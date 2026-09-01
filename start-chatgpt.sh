#!/usr/bin/env bash
# chatgpt2codex - ChatGPT connector one-shot launcher.
#
# Starts the local HTTP/OAuth MCP server. Default mode is loopback-only.
# Set CHATGPT2CODEX_EXPOSE_WEB=1 only while ChatGPT web needs to reach it.
# Keep this terminal open. Ctrl+C tears down the server and optional tunnel.
#
# Optional env:
#   WORKSPACE="$HOME/workspace"
#   PORT=7979
#   CHATGPT2CODEX_EXPOSE_WEB=1            # opt-in public tunnel for ChatGPT web
#   CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES=20   # optional explicit idle shutdown
#   PUBLIC_HOSTNAME=your-domain.example.com   # optional stable host for web mode
#   CHATGPT2CODEX_TUNNEL_MODE=loopback|cloudflare-quick|cloudflare-named|external
#   CHATGPT2CODEX_PUBLIC_URL=https://connector.example.com  # required/recommended for external mode
#   CHATGPT2CODEX_ACTIVE_PROJECT_ROOT=/path/to/project
#   CLOUDFLARED_TUNNEL_TOKEN=...      # preferred if configured in Cloudflare dashboard
#   CLOUDFLARED_TUNNEL_NAME=...       # optional named tunnel from local cloudflared config
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$ROOT/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WORKSPACE="${WORKSPACE:-$HOME/workspace}"
PORT="${PORT:-7979}"
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-}"
EXPOSE_WEB="${CHATGPT2CODEX_EXPOSE_WEB:-0}"
TUNNEL_MODE="${CHATGPT2CODEX_TUNNEL_MODE:-}"
CONFIGURED_PUBLIC_URL="${CHATGPT2CODEX_PUBLIC_URL:-}"
IDLE_SHUTDOWN_MINUTES="${CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES:-}"
CLOUDFLARED_TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-}"
STATE_DIR="${CHATGPT2CODEX_STATE_DIR:-$HOME/.local/share/chatgpt2codex}"
ACTIVE_RUNTIME_FILE="$STATE_DIR/active-runtime"
RUNTIME_RELOAD_FILE="$STATE_DIR/runtime-reload-request"
OPERATOR_STOP_FILE="$STATE_DIR/operator-stop"
RUNTIME_APPLY_MAINTENANCE_FILE="$STATE_DIR/runtime-apply-maintenance"
CFLOG="$(mktemp -t chatgpt2codex-cf.XXXX.log)"
SRVLOG="$(mktemp -t chatgpt2codex-server.XXXX.log)"
LAST_RUNTIME_FAILURE_LOG="$STATE_DIR/logs/last-runtime-failure.log"
DOCTOR_SCRIPT="$ROOT/macos-dependency-doctor.sh"
if [[ ! -f "$DOCTOR_SCRIPT" && -f "$ROOT/scripts/macos-dependency-doctor.sh" ]]; then
  DOCTOR_SCRIPT="$ROOT/scripts/macos-dependency-doctor.sh"
fi
LAUNCHER_SUBSHELL_LEVEL="${BASH_SUBSHELL:-0}"
CLEANED_UP=0
HEALTH_CHECK_INTERVAL_TICKS=5
HEALTH_FAILURE_THRESHOLD=3
HUNG_RECOVERY_COOLDOWN_SEC=30
HUNG_RECOVERY_WINDOW_SEC=300
HUNG_RECOVERY_MAX_ATTEMPTS=3
HEALTH_TICK=0
CONSECUTIVE_HEALTH_FAILURES=0
HUNG_RECOVERY_WINDOW_STARTED_AT=0
HUNG_RECOVERY_LAST_AT=0
HUNG_RECOVERY_ATTEMPTS=0
HUNG_RECOVERY_DISABLED=0

cleanup() {
  # Command substitutions run in Bash subshells and inherit EXIT traps on some
  # macOS Bash versions. Only the top-level launcher may own/stop these PIDs.
  [[ "${BASH_SUBSHELL:-0}" == "$LAUNCHER_SUBSHELL_LEVEL" ]] || return 0
  [[ "$CLEANED_UP" == "0" ]] || return 0
  CLEANED_UP=1
  echo
  echo "[chatgpt2codex] stopping server/tunnel..."
  [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true
  [[ -n "${CF_PID:-}" ]] && kill "$CF_PID" 2>/dev/null || true
  rm -f "$CFLOG" "$SRVLOG"
}
trap 'cleanup' EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[chatgpt2codex] missing command: $1" >&2
    exit 1
  fi
}

run_macos_doctor() {
  if [[ "$(uname -s)" != "Darwin" || ! -f "$DOCTOR_SCRIPT" ]]; then
    return 0
  fi
  echo "[chatgpt2codex] checking macOS runtime dependencies..."
  if ! CHATGPT2CODEX_DOCTOR_REPAIR=1 bash "$DOCTOR_SCRIPT" --repair; then
    echo "[chatgpt2codex] macOS doctor found issues that could not be fixed automatically." >&2
    echo "[chatgpt2codex] open ChatGPT To Codex settings -> Run Doctor for the full report." >&2
    exit 1
  fi
}

sleep_1s() {
  # The supervisor outlives in-place .app bundle replacement. Never resolve
  # this delay through $ROOT/bin/node because that path can temporarily
  # disappear while /Applications/ChatGPT To Codex.app is being swapped.
  /bin/sleep 1
}

operator_stop_requested() {
  [[ -f "$OPERATOR_STOP_FILE" ]]
}

runtime_apply_maintenance_active() {
  local owner_pid operation_id modified_at now age command
  [[ -f "$RUNTIME_APPLY_MAINTENANCE_FILE" ]] || return 1
  IFS=' ' read -r owner_pid operation_id <"$RUNTIME_APPLY_MAINTENANCE_FILE" || true
  if [[ ! "$owner_pid" =~ ^[0-9]+$ || ! "$operation_id" =~ ^rt_[0-9a-f-]{36}$ ]]; then
    rm -f "$RUNTIME_APPLY_MAINTENANCE_FILE"
    return 1
  fi
  modified_at="$(stat -f %m "$RUNTIME_APPLY_MAINTENANCE_FILE" 2>/dev/null || stat -c %Y "$RUNTIME_APPLY_MAINTENANCE_FILE" 2>/dev/null || printf '0')"
  now="$(date +%s)"
  if [[ ! "$modified_at" =~ ^[0-9]+$ || "$modified_at" == "0" ]]; then
    rm -f "$RUNTIME_APPLY_MAINTENANCE_FILE"
    return 1
  fi
  age=$((now - modified_at))
  if [[ "$age" -gt 180 || "$age" -lt 0 ]] || ! kill -0 "$owner_pid" 2>/dev/null; then
    rm -f "$RUNTIME_APPLY_MAINTENANCE_FILE"
    return 1
  fi
  command="$(ps -o command= -p "$owner_pid" 2>/dev/null || true)"
  if [[ "$command" != *"start-chatgpt.sh"* ]]; then
    rm -f "$RUNTIME_APPLY_MAINTENANCE_FILE"
    return 1
  fi
  return 0
}

persist_server_failure_log() {
  local temporary="${LAST_RUNTIME_FAILURE_LOG}.tmp-$$"
  /bin/mkdir -p "$(/usr/bin/dirname "$LAST_RUNTIME_FAILURE_LOG")"
  /usr/bin/tail -c 262144 "$SRVLOG" >"$temporary" 2>/dev/null || true
  /bin/chmod 600 "$temporary" 2>/dev/null || true
  /bin/mv -f "$temporary" "$LAST_RUNTIME_FAILURE_LOG"
}

wait_http_ok() {
  local url="$1"
  local tries="$2"
  local label="$3"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep_1s
  done
  echo "[chatgpt2codex] $label did not become ready: $url" >&2
  return 1
}

resolve_server_runtime_root() {
  local candidate=""
  if [[ -f "$ACTIVE_RUNTIME_FILE" ]]; then
    IFS= read -r candidate <"$ACTIVE_RUNTIME_FILE" || true
  fi
  if [[ -n "$candidate" && -f "$candidate/dist/cli.js" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [[ -n "$candidate" ]]; then
    echo "[chatgpt2codex] ignoring invalid active runtime: $candidate" >&2
  fi
  printf '%s\n' "$ROOT"
}

resolve_server_node() {
  local runtime_root="$1"
  local candidate
  for candidate in \
    "$runtime_root/bin/node" \
    "$runtime_root/node/bin/node" \
    "$ROOT/bin/node" \
    "$ROOT/node/bin/node"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  command -v node
}

start_server_process() {
  local requested_root="${1:-}"
  if [[ -n "$requested_root" ]]; then
    SERVER_RUNTIME_ROOT="$requested_root"
  else
    SERVER_RUNTIME_ROOT="$(resolve_server_runtime_root)"
  fi
  SERVER_NODE="$(resolve_server_node "$SERVER_RUNTIME_ROOT")"
  if [[ ! -f "$SERVER_RUNTIME_ROOT/dist/cli.js" ]]; then
    echo "[chatgpt2codex] runtime is missing dist/cli.js: $SERVER_RUNTIME_ROOT" >&2
    return 1
  fi
  SERVER_RUNTIME_VERSION="$("$SERVER_NODE" -e \
    'try { process.stdout.write(require(process.argv[1]).version || "unknown") } catch { process.stdout.write("unknown") }' \
    "$SERVER_RUNTIME_ROOT/package.json" 2>/dev/null || printf 'unknown')"
  printf '\n[chatgpt2codex] starting runtime from %s\n' "$SERVER_RUNTIME_ROOT" >>"$SRVLOG"
  CHATGPT2CODEX_RUNTIME_ROOT="$SERVER_RUNTIME_ROOT" \
    CHATGPT2CODEX_SUPERVISOR_PID="$$" \
    CHATGPT2CODEX_CLOUDFLARED_PID="${CF_PID:-}" \
    CHATGPT2CODEX_TUNNEL_MODE="$TUNNEL_MODE" \
    CHATGPT2CODEX_PUBLIC_ORIGIN="$PUBLIC_URL" \
    CHATGPT2CODEX_PORT="$PORT" \
    CHATGPT2CODEX_RUNTIME_VERSION="$SERVER_RUNTIME_VERSION" \
    "$SERVER_NODE" "$SERVER_RUNTIME_ROOT/dist/cli.js" "${SERVER_ARGS[@]}" \
    ${ACTIVE_PROJECT_ARGS[@]+"${ACTIVE_PROJECT_ARGS[@]}"} >>"$SRVLOG" 2>&1 &
  SRV_PID=$!
  echo "[chatgpt2codex] runtime process started (supervisor=$$, server=$SRV_PID, version=$SERVER_RUNTIME_VERSION)."
}

restore_runtime_pointer() {
  local previous_root="$1"
  if [[ "$previous_root" == "$ROOT" ]]; then
    rm -f "$ACTIVE_RUNTIME_FILE"
  else
    printf '%s\n' "$previous_root" >"$ACTIVE_RUNTIME_FILE"
    chmod 600 "$ACTIVE_RUNTIME_FILE" 2>/dev/null || true
  fi
}

reload_server_runtime() {
  local previous_root="$SERVER_RUNTIME_ROOT"
  rm -f "$RUNTIME_RELOAD_FILE"
  echo "[chatgpt2codex] applying runtime update while preserving the connector URL..."
  echo "[chatgpt2codex] stopping runtime process $SRV_PID (supervisor=$$)."
  stop_managed_server_process

  if start_server_process &&
     wait_http_ok "http://127.0.0.1:$PORT/healthz" 20 "updated local server"; then
    reset_hung_recovery_state
    echo "[chatgpt2codex] runtime updated; connector URL is unchanged."
    return 0
  fi

  echo "[chatgpt2codex] updated runtime failed health check; rolling back." >&2
  [[ -n "${SRV_PID:-}" ]] && stop_managed_server_process || true
  restore_runtime_pointer "$previous_root"
  start_server_process
  if wait_http_ok "http://127.0.0.1:$PORT/healthz" 20 "rolled-back local server"; then
    reset_hung_recovery_state
    echo "[chatgpt2codex] previous runtime restored; connector URL is unchanged." >&2
    return 1
  fi
  echo "[chatgpt2codex] rollback runtime also failed. Log: $SRVLOG" >&2
  return 1
}

reset_hung_recovery_state() {
  HEALTH_TICK=0
  CONSECUTIVE_HEALTH_FAILURES=0
  HUNG_RECOVERY_WINDOW_STARTED_AT=0
  HUNG_RECOVERY_LAST_AT=0
  HUNG_RECOVERY_ATTEMPTS=0
  HUNG_RECOVERY_DISABLED=0
}

server_process_state() {
  [[ -n "${SRV_PID:-}" ]] || return 1
  ps -p "$SRV_PID" -o stat= 2>/dev/null | tr -d '[:space:]'
}

local_runtime_healthy() {
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null |
    grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
}

reclaim_healthy_runtime_for_handoff() {
  local health runtime_pid supervisor_pid runtime_parent supervisor_command target_pid i
  health="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
  runtime_pid="$(printf '%s' "$health" | node -e '
    let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{try{const j=JSON.parse(s);const v=j.runtimePid; if(Number.isSafeInteger(v)&&v>0) process.stdout.write(String(v));}catch{}})
  ')"
  supervisor_pid="$(printf '%s' "$health" | node -e '
    let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{try{const j=JSON.parse(s);const v=j.runtimeExternalIdentity?.supervisorPid ?? j.supervisorPid; if(Number.isSafeInteger(v)&&v>0) process.stdout.write(String(v));}catch{}})
  ')"
  [[ "$runtime_pid" =~ ^[0-9]+$ ]] || return 1

  target_pid="$runtime_pid"
  if [[ "$supervisor_pid" =~ ^[0-9]+$ ]]; then
    runtime_parent="$(ps -o ppid= -p "$runtime_pid" 2>/dev/null | tr -d '[:space:]')"
    supervisor_command="$(ps -o command= -p "$supervisor_pid" 2>/dev/null || true)"
    if [[ "$runtime_parent" == "$supervisor_pid" && "$supervisor_command" == *"start-chatgpt.sh"* ]]; then
      target_pid="$supervisor_pid"
    fi
  fi

  echo "[chatgpt2codex] approved app handoff reclaiming healthy runtime ownership (target=$target_pid, runtime=$runtime_pid)."
  kill -TERM "$target_pid" 2>/dev/null || true
  for i in $(seq 1 24); do
    if ! port_busy; then
      return 0
    fi
    /bin/sleep 0.25
  done

  # Bounded exact-PID fallback. Re-check that the same runtime is still the
  # healthy C2CT listener before escalating, so PID reuse cannot widen scope.
  health="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
  local current_runtime_pid
  current_runtime_pid="$(printf '%s' "$health" | node -e '
    let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{try{const j=JSON.parse(s);const v=j.runtimePid; if(Number.isSafeInteger(v)&&v>0) process.stdout.write(String(v));}catch{}})
  ')"
  [[ "$current_runtime_pid" == "$runtime_pid" ]] || return 1
  kill -KILL "$target_pid" 2>/dev/null || true
  [[ "$target_pid" == "$runtime_pid" ]] || kill -TERM "$runtime_pid" 2>/dev/null || true
  for i in $(seq 1 12); do
    if ! port_busy; then
      return 0
    fi
    /bin/sleep 0.25
  done
  return 1
}

stop_managed_server_process() {
  local pid="${SRV_PID:-}"
  local state=""
  local i
  [[ -n "$pid" ]] || return 0

  state="$(server_process_state || true)"
  if [[ "$state" == Z* ]]; then
    wait "$pid" 2>/dev/null || true
    SRV_PID=""
    return 0
  fi

  kill -TERM "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      SRV_PID=""
      return 0
    fi
    state="$(server_process_state || true)"
    if [[ "$state" == Z* ]]; then
      wait "$pid" 2>/dev/null || true
      SRV_PID=""
      return 0
    fi
    sleep_1s
  done

  echo "[chatgpt2codex] managed runtime $pid ignored TERM; sending bounded KILL fallback." >&2
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  SRV_PID=""
}

hung_recovery_budget_allows() {
  local now
  now="$(date +%s)"
  if [[ "$HUNG_RECOVERY_DISABLED" == "1" ]]; then
    return 1
  fi
  if [[ "$HUNG_RECOVERY_WINDOW_STARTED_AT" == "0" || $((now - HUNG_RECOVERY_WINDOW_STARTED_AT)) -gt "$HUNG_RECOVERY_WINDOW_SEC" ]]; then
    HUNG_RECOVERY_WINDOW_STARTED_AT="$now"
    HUNG_RECOVERY_ATTEMPTS=0
  fi
  if [[ "$HUNG_RECOVERY_ATTEMPTS" -ge "$HUNG_RECOVERY_MAX_ATTEMPTS" ]]; then
    HUNG_RECOVERY_DISABLED=1
    echo "[chatgpt2codex] managed runtime auto-recovery disabled after $HUNG_RECOVERY_ATTEMPTS attempts in ${HUNG_RECOVERY_WINDOW_SEC}s; explicit Stop/Restart or runtime reload is required." >&2
    return 1
  fi
  if [[ "$HUNG_RECOVERY_LAST_AT" != "0" && $((now - HUNG_RECOVERY_LAST_AT)) -lt "$HUNG_RECOVERY_COOLDOWN_SEC" ]]; then
    return 1
  fi
  HUNG_RECOVERY_LAST_AT="$now"
  HUNG_RECOVERY_ATTEMPTS=$((HUNG_RECOVERY_ATTEMPTS + 1))
  return 0
}

recover_hung_managed_runtime() {
  local reason="$1"
  local previous_root="${SERVER_RUNTIME_ROOT:-}"
  local retry_delay attempt=0
  if operator_stop_requested; then
    echo "[chatgpt2codex] explicit operator stop suppresses managed runtime recovery."
    return 1
  fi
  [[ -n "$previous_root" ]] || return 1
  hung_recovery_budget_allows || return 1

  echo "[chatgpt2codex] managed runtime recovery attempt $HUNG_RECOVERY_ATTEMPTS/$HUNG_RECOVERY_MAX_ATTEMPTS: $reason; preserving supervisor=$$, tunnel mode=$TUNNEL_MODE."
  stop_managed_server_process

  # A previous runtime may have died while holding a short-lived local state
  # lock. Retry long enough to cross the 30s stale-lock fallback rather than
  # declaring the managed runtime unrecoverable after one immediate restart.
  # The sequence is fixed and bounded: immediate, +5s, +10s, +20s.
  for retry_delay in 0 5 10 20; do
    attempt=$((attempt + 1))
    if [[ "$retry_delay" -gt 0 ]]; then
      echo "[chatgpt2codex] managed runtime recovery sub-attempt $attempt/4 after ${retry_delay}s backoff."
      while [[ "$retry_delay" -gt 0 ]]; do
        operator_stop_requested && return 1
        sleep_1s
        retry_delay=$((retry_delay - 1))
      done
    fi

    if start_server_process "$previous_root" &&
       wait_http_ok "http://127.0.0.1:$PORT/healthz" 20 "recovered managed runtime"; then
      HEALTH_TICK=0
      CONSECUTIVE_HEALTH_FAILURES=0
      echo "[chatgpt2codex] managed runtime recovered; supervisor and connector/tunnel were preserved."
      return 0
    fi

    persist_server_failure_log
    [[ -n "${SRV_PID:-}" ]] && stop_managed_server_process || true
  done

  echo "[chatgpt2codex] managed runtime recovery exhausted the bounded retry sequence; preserving the supervisor/tunnel for explicit inspection." >&2
  HUNG_RECOVERY_DISABLED=1
  return 1
}

handle_managed_server_exit() {
  local exit_status="$1"
  local exited_pid="$2"
  SRV_PID=""

  if operator_stop_requested; then
    echo "[chatgpt2codex] server stopped by explicit operator request."
    return 2
  fi

  if [[ "$exit_status" == "0" && -n "$IDLE_SHUTDOWN_MINUTES" ]]; then
    echo "[chatgpt2codex] server stopped."
    return 2
  fi

  echo "[chatgpt2codex] server $exited_pid exited with status $exit_status. Log:" >&2
  cat "$SRVLOG" >&2
  persist_server_failure_log
  if recover_hung_managed_runtime "runtime process $exited_pid exited with status $exit_status"; then
    return 0
  fi

  echo "[chatgpt2codex] runtime exit recovery is unavailable; preserving the supervisor/tunnel for an explicit reload or inspection." >&2
  return 1
}

monitor_managed_runtime_health() {
  local state=""
  [[ -n "${SRV_PID:-}" ]] || return 0

  state="$(server_process_state || true)"
  if [[ "$state" == Z* ]]; then
    recover_hung_managed_runtime "runtime entered Unix zombie state ($state)" || true
    return 0
  fi

  HEALTH_TICK=$((HEALTH_TICK + 1))
  if [[ "$HEALTH_TICK" -lt "$HEALTH_CHECK_INTERVAL_TICKS" ]]; then
    return 0
  fi
  HEALTH_TICK=0

  if local_runtime_healthy; then
    CONSECUTIVE_HEALTH_FAILURES=0
    return 0
  fi

  CONSECUTIVE_HEALTH_FAILURES=$((CONSECUTIVE_HEALTH_FAILURES + 1))
  echo "[chatgpt2codex] managed runtime health miss $CONSECUTIVE_HEALTH_FAILURES/$HEALTH_FAILURE_THRESHOLD (server=$SRV_PID)." >&2
  if [[ "$CONSECUTIVE_HEALTH_FAILURES" -ge "$HEALTH_FAILURE_THRESHOLD" ]]; then
    recover_hung_managed_runtime "repeated loopback health failure while managed PID remained present" || true
  fi
}

cloudflare_doh_ips() {
  local host="$1"
  local query_url="https://cloudflare-dns.com/dns-query?name=${host}&type=A"
  curl --silent --show-error --resolve "cloudflare-dns.com:443:1.1.1.1" \
    -H "accept: application/dns-json" --max-time 20 "$query_url" |
    node -e '
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const json = JSON.parse(input);
          for (const answer of json.Answer ?? []) {
            if (answer.type === 1 && answer.data) console.log(answer.data);
          }
        } catch {}
      });
    '
}

http_ok_with_curl_resolve() {
  local url="$1"
  local host
  host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$url" 2>/dev/null || true)"
  [[ -z "$host" ]] && return 1
  local ip
  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    if curl -fsS --resolve "$host:443:$ip" --max-time 20 "$url" >/dev/null 2>&1; then
      return 0
    fi
  done < <(cloudflare_doh_ips "$host")
  return 1
}

wait_public_http_ok() {
  local url="$1"
  local tries="$2"
  local label="$3"
  local allow_cloudflare_fallback="${4:-0}"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$allow_cloudflare_fallback" == "1" ]] && http_ok_with_curl_resolve "$url"; then
      return 0
    fi
    sleep_1s
  done
  echo "[chatgpt2codex] $label did not become ready: $url" >&2
  return 1
}

wait_quick_tunnel_url() {
  local tries="$1"
  local i
  for i in $(seq 1 "$tries"); do
    local url
    url="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$CFLOG" | head -n 1 || true)"
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return 0
    fi
    if [[ -n "${CF_PID:-}" ]] && ! kill -0 "$CF_PID" 2>/dev/null; then
      echo "[chatgpt2codex] cloudflared exited early. Log:" >&2
      cat "$CFLOG" >&2
      return 1
    fi
    sleep_1s
  done
  echo "[chatgpt2codex] quick tunnel URL did not appear. Log:" >&2
  cat "$CFLOG" >&2
  return 1
}

start_quick_tunnel_with_retry() {
  local attempts="$1"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if [[ "$attempt" -gt 1 ]]; then
      echo "[chatgpt2codex] retrying public tunnel ($attempt/$attempts)..." >&2
      sleep "$(( attempt < 5 ? attempt * 2 : 10 ))"
    fi

    cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$CFLOG" 2>&1 &
    CF_PID=$!
    if PUBLIC_URL="$(wait_quick_tunnel_url 45)"; then
      return 0
    fi
    kill "$CF_PID" 2>/dev/null || true
    wait "$CF_PID" 2>/dev/null || true
    CF_PID=""
  done
  return 1
}

port_busy() {
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", () => process.exit(0));
    server.once("listening", () => server.close(() => process.exit(1)));
    server.listen(port, "127.0.0.1");
  ' "$PORT"
}

is_legacy_external_hostname() {
  local host
  host="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$host" == *.ts.net && "$host" != *"/"* && "$host" != *"@"* && "$host" != *"?"* && "$host" != *"#"* ]]
}

resolve_tunnel_mode() {
  if [[ -n "$TUNNEL_MODE" ]]; then
    case "$TUNNEL_MODE" in
      loopback|cloudflare-quick|cloudflare-named|external) ;;
      *) echo "[chatgpt2codex] invalid CHATGPT2CODEX_TUNNEL_MODE." >&2; exit 1 ;;
    esac
    return 0
  fi
  if [[ -n "$CONFIGURED_PUBLIC_URL" ]]; then
    TUNNEL_MODE="external"
  elif [[ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" || -n "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
    TUNNEL_MODE="cloudflare-named"
  elif [[ -n "$PUBLIC_HOSTNAME" ]] && is_legacy_external_hostname "$PUBLIC_HOSTNAME"; then
    # Safe migration for the historical Tailscale Funnel configuration. New
    # configurations should persist CHATGPT2CODEX_TUNNEL_MODE=external.
    TUNNEL_MODE="external"
  elif [[ -n "$PUBLIC_HOSTNAME" ]]; then
    TUNNEL_MODE="cloudflare-named"
  elif [[ "$EXPOSE_WEB" == "1" ]]; then
    TUNNEL_MODE="cloudflare-quick"
  else
    TUNNEL_MODE="loopback"
  fi
}

validate_external_public_url() {
  local candidate="$1"
  node - "$candidate" <<'NODE'
const raw = process.argv[2];
let url;
try { url = new URL(raw); } catch { process.exit(2); }
const rawHost = url.hostname.toLowerCase().replace(/\.$/u, "");
const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
const forbiddenHost = host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
  /^127(?:\.|$)/u.test(host) || host === "0.0.0.0";
if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    (url.pathname !== "" && url.pathname !== "/") || forbiddenHost) process.exit(2);
process.stdout.write(url.origin);
NODE
}

run_macos_doctor

need_cmd node
need_cmd curl
resolve_tunnel_mode

mkdir -p "$WORKSPACE"
WORKSPACE="$(cd "$WORKSPACE" && pwd)"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

if operator_stop_requested; then
  echo "[chatgpt2codex] explicit operator stop is active; leaving MCP stopped."
  exit 0
fi
if runtime_apply_maintenance_active; then
  echo "[chatgpt2codex] runtime apply maintenance is owned by the existing managed supervisor; refusing a competing launcher."
  exit 0
fi

cd "$ROOT"

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  need_cmd npm
  echo "[chatgpt2codex] dist/cli.js missing; building..."
  npm run build
fi

if port_busy; then
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    if [[ "${CHATGPT2CODEX_HANDOFF_RECOVERY:-0}" == "1" ]]; then
      if ! reclaim_healthy_runtime_for_handoff; then
        echo "[chatgpt2codex] approved app handoff could not safely reclaim the healthy runtime listener." >&2
        exit 1
      fi
    else
      echo "[chatgpt2codex] existing healthy runtime detected on port $PORT; leaving it untouched."
      exit 0
    fi
  else
    echo "[chatgpt2codex] port $PORT is already in use, but its local health could not be verified." >&2
    echo "[chatgpt2codex] refusing automatic process reclamation; use an explicit Stop/Restart action after inspecting the runtime." >&2
    exit 1
  fi
fi

INITIAL_RUNTIME_ROOT="$(resolve_server_runtime_root)"
INITIAL_NODE="$(resolve_server_node "$INITIAL_RUNTIME_ROOT")"
if ! "$INITIAL_NODE" "$INITIAL_RUNTIME_ROOT/dist/cli.js" doctor 2>/dev/null | grep -q "owner token configured"; then
  echo "[chatgpt2codex] owner token is not configured." >&2
  echo "[chatgpt2codex] Open ChatGPT To Codex settings and generate or set an owner token first." >&2
  echo "[chatgpt2codex] CLI fallback: node \"$ROOT/dist/cli.js\" owner-token --generate --workspace \"$WORKSPACE\"" >&2
  exit 1
fi

USE_PUBLIC_ENDPOINT=0
MANAGES_CLOUDFLARED=0
if [[ "$TUNNEL_MODE" != "loopback" ]]; then USE_PUBLIC_ENDPOINT=1; fi

if [[ "$TUNNEL_MODE" == "external" ]]; then
  candidate_public_url="$CONFIGURED_PUBLIC_URL"
  if [[ -z "$candidate_public_url" && -n "$PUBLIC_HOSTNAME" ]]; then
    candidate_public_url="https://${PUBLIC_HOSTNAME}"
  fi
  if [[ -z "$candidate_public_url" ]] || ! PUBLIC_URL="$(validate_external_public_url "$candidate_public_url")"; then
    echo "[chatgpt2codex] externally managed tunnel requires a valid HTTPS public origin (no credentials, query, fragment, path, localhost, or loopback)." >&2
    exit 1
  fi
  echo "[chatgpt2codex] 1/3 using externally managed HTTPS tunnel; no cloudflared process will be started."
elif [[ "$TUNNEL_MODE" == cloudflare-* ]]; then
  if [[ "$TUNNEL_MODE" == "cloudflare-named" ]]; then
    if [[ -z "$PUBLIC_HOSTNAME" ]]; then
      echo "[chatgpt2codex] PUBLIC_HOSTNAME is required for cloudflare-named mode." >&2
      exit 1
    fi
    if [[ -z "${CLOUDFLARED_TUNNEL_TOKEN:-}" && -z "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
      echo "[chatgpt2codex] cloudflare-named mode requires CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME; a hostname alone is not sufficient." >&2
      exit 1
    fi
  fi
  MANAGES_CLOUDFLARED=1
  need_cmd cloudflared
  echo "[chatgpt2codex] 1/3 starting public tunnel..."
  if [[ "$TUNNEL_MODE" == "cloudflare-named" ]]; then
    PUBLIC_URL="https://${PUBLIC_HOSTNAME}"
    if [[ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]]; then
      cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARED_TUNNEL_TOKEN" >"$CFLOG" 2>&1 &
    else
      cloudflared tunnel --no-autoupdate run --url "http://127.0.0.1:$PORT" "$CLOUDFLARED_TUNNEL_NAME" >"$CFLOG" 2>&1 &
    fi
    CF_PID=$!
  else
    if ! start_quick_tunnel_with_retry 4; then
      echo "[chatgpt2codex] quick tunnel URL did not appear. Log:" >&2
      cat "$CFLOG" >&2
      exit 1
    fi
  fi

  if [[ "$TUNNEL_MODE" == "cloudflare-quick" ]]; then
    PUBLIC_URL="$(wait_quick_tunnel_url 30)"
  else
    for _ in $(seq 1 3); do
      if ! kill -0 "$CF_PID" 2>/dev/null; then
        echo "[chatgpt2codex] cloudflared exited early. Log:" >&2
        cat "$CFLOG" >&2
        exit 1
      fi
      sleep_1s
    done
  fi
else
  PUBLIC_URL="http://127.0.0.1:$PORT"
  echo "[chatgpt2codex] 1/2 loopback-only mode; no public tunnel."
fi

echo "[chatgpt2codex] 2/3 starting local HTTP/OAuth MCP server..."
ACTIVE_PROJECT_ARGS=()
if [[ -n "${CHATGPT2CODEX_ACTIVE_PROJECT_ROOT:-}" ]]; then
  ACTIVE_PROJECT_ARGS+=(--active-project-root "$CHATGPT2CODEX_ACTIVE_PROJECT_ROOT")
  ACTIVE_PROJECT_ARGS+=(--active-project-preset "${CHATGPT2CODEX_ACTIVE_PROJECT_PRESET:-full-write}")
fi
SERVER_ARGS=(serve --http --port "$PORT" --public-url "$PUBLIC_URL" --workspace "$WORKSPACE")
if [[ -n "$IDLE_SHUTDOWN_MINUTES" ]]; then
  SERVER_ARGS+=(--idle-shutdown-minutes "$IDLE_SHUTDOWN_MINUTES")
fi
start_server_process
if ! wait_http_ok "http://127.0.0.1:$PORT/healthz" 20 "local server"; then
  echo "[chatgpt2codex] server log: $SRVLOG" >&2
  cat "$SRVLOG" >&2
  exit 1
fi

if [[ "$USE_PUBLIC_ENDPOINT" == "1" ]]; then
  echo "[chatgpt2codex] 3/3 checking public health..."
  cloudflare_fallback=0
  [[ "$TUNNEL_MODE" == cloudflare-* ]] && cloudflare_fallback=1
  if ! wait_public_http_ok "$PUBLIC_URL/healthz" 60 "public endpoint" "$cloudflare_fallback"; then
    [[ "$MANAGES_CLOUDFLARED" == "1" ]] && echo "[chatgpt2codex] cloudflared log: $CFLOG" >&2
    echo "[chatgpt2codex] server log: $SRVLOG" >&2
    exit 1
  fi
fi

cat <<EOF

============================================================
 chatgpt2codex is ready
============================================================
 MCP URL:

   ${PUBLIC_URL}/mcp

OAuth owner token:
   Use the private owner token you generated in ChatGPT To Codex settings.
   CLI fallback:
   node "$ROOT/dist/cli.js" owner-token --generate --workspace "$WORKSPACE"

 After approval, say something like:
   "alpha-app 열어서 로그인 버그 고쳐"

Notes:
   - Keep this terminal open.
   - Ctrl+C stops the server and only a tunnel process managed by this launcher.
   - Default mode is loopback-only and is not reachable from ChatGPT web.
   - Set CHATGPT2CODEX_EXPOSE_WEB=1 only while ChatGPT web needs a public URL.
   - Use CHATGPT2CODEX_TUNNEL_MODE=external with CHATGPT2CODEX_PUBLIC_URL=https://... for an externally managed HTTPS tunnel.
   - Use cloudflare-quick or cloudflare-named mode for launcher-managed Cloudflare tunnels.
   - Web mode stays running unless CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES is set.
   - If the old owner token appeared in a chat/screenshot, rotate it.
============================================================
EOF

if [[ "$TUNNEL_MODE" == "cloudflare-quick" ]]; then
  cat <<EOF
[chatgpt2codex] warning: this trycloudflare.com URL is temporary.
[chatgpt2codex] warning: ChatGPT app registration will need reconnect/update after the tunnel URL changes.
[chatgpt2codex] warning: set PUBLIC_HOSTNAME plus CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME for a stable URL.

EOF
fi

while true; do
  if operator_stop_requested; then
    echo "[chatgpt2codex] explicit operator stop observed; shutting down the managed supervisor."
    exit 0
  fi
  desired_runtime_root="$(resolve_server_runtime_root)"
  if [[ "$desired_runtime_root" != "${SERVER_RUNTIME_ROOT:-}" ]]; then
    echo "[chatgpt2codex] active runtime pointer changed; converging managed runtime to $desired_runtime_root."
    reload_server_runtime || true
  elif [[ -f "$RUNTIME_RELOAD_FILE" ]]; then
    reload_server_runtime || true
  fi
  monitor_managed_runtime_health
  if [[ -z "${SRV_PID:-}" ]]; then
    # A failed verified recovery intentionally leaves the supervisor/tunnel
    # alive for inspection or an explicit runtime reload. Do not collapse the
    # whole connector topology merely because the runtime child is absent.
    sleep_1s
    continue
  fi
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    exited_pid="$SRV_PID"
    if wait "$exited_pid"; then
      exit_status=0
    else
      exit_status=$?
    fi
    if handle_managed_server_exit "$exit_status" "$exited_pid"; then
      continue
    else
      handle_status=$?
    fi
    [[ "$handle_status" == "2" ]] && exit 0
    sleep_1s
    continue
  fi
  if [[ "$MANAGES_CLOUDFLARED" == "1" ]] && ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "[chatgpt2codex] cloudflared exited. Log:" >&2
    cat "$CFLOG" >&2
    exit 1
  fi
  sleep_1s
done
