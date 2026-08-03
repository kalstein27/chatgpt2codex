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
IDLE_SHUTDOWN_MINUTES="${CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES:-}"
CLOUDFLARED_TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-}"
STATE_DIR="${CHATGPT2CODEX_STATE_DIR:-$HOME/.local/share/chatgpt2codex}"
ACTIVE_RUNTIME_FILE="$STATE_DIR/active-runtime"
RUNTIME_RELOAD_FILE="$STATE_DIR/runtime-reload-request"
CFLOG="$(mktemp -t chatgpt2codex-cf.XXXX.log)"
SRVLOG="$(mktemp -t chatgpt2codex-server.XXXX.log)"
DOCTOR_SCRIPT="$ROOT/macos-dependency-doctor.sh"
if [[ ! -f "$DOCTOR_SCRIPT" && -f "$ROOT/scripts/macos-dependency-doctor.sh" ]]; then
  DOCTOR_SCRIPT="$ROOT/scripts/macos-dependency-doctor.sh"
fi
LAUNCHER_SUBSHELL_LEVEL="${BASH_SUBSHELL:-0}"
CLEANED_UP=0

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
  node -e 'setTimeout(function(){}, 1000)'
}

wait_http_ok() {
  local url="$1"
  local tries="$2"
  local label="$3"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
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
  SERVER_RUNTIME_ROOT="$(resolve_server_runtime_root)"
  SERVER_NODE="$(resolve_server_node "$SERVER_RUNTIME_ROOT")"
  if [[ ! -f "$SERVER_RUNTIME_ROOT/dist/cli.js" ]]; then
    echo "[chatgpt2codex] runtime is missing dist/cli.js: $SERVER_RUNTIME_ROOT" >&2
    return 1
  fi
  SERVER_RUNTIME_VERSION="$("$SERVER_NODE" -e \
    'try { process.stdout.write(require(process.argv[1]).version || "unknown") } catch { process.stdout.write("unknown") }' \
    "$SERVER_RUNTIME_ROOT/package.json" 2>/dev/null || printf 'unknown')"
  printf '\n[chatgpt2codex] starting runtime from %s\n' "$SERVER_RUNTIME_ROOT" >>"$SRVLOG"
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
  echo "[chatgpt2codex] applying runtime update without restarting the Cloudflare tunnel..."
  echo "[chatgpt2codex] stopping runtime process $SRV_PID (supervisor=$$)."
  kill "$SRV_PID" 2>/dev/null || true
  wait "$SRV_PID" 2>/dev/null || true
  SRV_PID=""

  if start_server_process &&
     wait_http_ok "http://127.0.0.1:$PORT/healthz" 20 "updated local server"; then
    echo "[chatgpt2codex] runtime updated; connector URL is unchanged."
    return 0
  fi

  echo "[chatgpt2codex] updated runtime failed health check; rolling back." >&2
  [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true
  [[ -n "${SRV_PID:-}" ]] && wait "$SRV_PID" 2>/dev/null || true
  restore_runtime_pointer "$previous_root"
  start_server_process
  if wait_http_ok "http://127.0.0.1:$PORT/healthz" 20 "rolled-back local server"; then
    echo "[chatgpt2codex] previous runtime restored; connector URL is unchanged." >&2
    return 1
  fi
  echo "[chatgpt2codex] rollback runtime also failed. Log: $SRVLOG" >&2
  return 1
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
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1 || http_ok_with_curl_resolve "$url"; then
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

stop_stale_runtime_processes() {
  local stopped=()
  local patterns=(
    "dist/cli.js serve --http --port $PORT"
    "cloudflared.*127[.]0[.]0[.]1:$PORT"
    "cloudflared.*localhost:$PORT"
  )
  local pattern pid command
  for pattern in "${patterns[@]}"; do
    while IFS= read -r pid; do
      [[ -z "$pid" || "$pid" == "$$" || "$pid" == "${PPID:-}" ]] && continue
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      [[ -z "$command" ]] && continue
      if [[ "$command" == *"$ROOT"* || "$command" == *"$STATE_DIR/runtime"* || "$command" == *"cloudflared"* ]]; then
        kill "$pid" 2>/dev/null || true
        stopped+=("$pid")
      fi
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done
  if [[ "${#stopped[@]}" -gt 0 ]]; then
    echo "[chatgpt2codex] stopped stale runtime process(es): ${stopped[*]}"
    sleep 1
  fi
}

run_macos_doctor

need_cmd node
need_cmd curl

mkdir -p "$WORKSPACE"
WORKSPACE="$(cd "$WORKSPACE" && pwd)"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

cd "$ROOT"

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  need_cmd npm
  echo "[chatgpt2codex] dist/cli.js missing; building..."
  npm run build
fi

stop_stale_runtime_processes
if port_busy; then
  echo "[chatgpt2codex] port $PORT is already in use. Set PORT=xxxx or stop the other process." >&2
  exit 1
fi

INITIAL_RUNTIME_ROOT="$(resolve_server_runtime_root)"
INITIAL_NODE="$(resolve_server_node "$INITIAL_RUNTIME_ROOT")"
if ! "$INITIAL_NODE" "$INITIAL_RUNTIME_ROOT/dist/cli.js" doctor 2>/dev/null | grep -q "owner token configured"; then
  echo "[chatgpt2codex] owner token is not configured." >&2
  echo "[chatgpt2codex] Open ChatGPT To Codex settings and generate or set an owner token first." >&2
  echo "[chatgpt2codex] CLI fallback: node \"$ROOT/dist/cli.js\" owner-token --generate --workspace \"$WORKSPACE\"" >&2
  exit 1
fi

USE_TUNNEL=0
if [[ "$EXPOSE_WEB" == "1" || -n "$PUBLIC_HOSTNAME" || -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" || -n "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
  USE_TUNNEL=1
fi

if [[ "$USE_TUNNEL" == "1" ]]; then
  need_cmd cloudflared
  echo "[chatgpt2codex] 1/3 starting public tunnel..."
  if [[ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" || -n "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
    if [[ -z "$PUBLIC_HOSTNAME" ]]; then
      echo "[chatgpt2codex] PUBLIC_HOSTNAME is required when using CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME." >&2
      exit 1
    fi
    PUBLIC_URL="https://${PUBLIC_HOSTNAME}"
    if [[ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]]; then
      cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARED_TUNNEL_TOKEN" >"$CFLOG" 2>&1 &
    else
      cloudflared tunnel --no-autoupdate run --url "http://127.0.0.1:$PORT" "$CLOUDFLARED_TUNNEL_NAME" >"$CFLOG" 2>&1 &
    fi
    CF_PID=$!
  elif [[ -n "$PUBLIC_HOSTNAME" ]]; then
    PUBLIC_URL="https://${PUBLIC_HOSTNAME}"
    cloudflared tunnel --hostname "$PUBLIC_HOSTNAME" --url "http://127.0.0.1:$PORT" --no-autoupdate >"$CFLOG" 2>&1 &
    CF_PID=$!
  else
    if ! start_quick_tunnel_with_retry 4; then
      echo "[chatgpt2codex] quick tunnel URL did not appear. Log:" >&2
      cat "$CFLOG" >&2
      exit 1
    fi
  fi

  if [[ -z "${PUBLIC_URL:-}" ]]; then
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

if [[ "$USE_TUNNEL" == "1" ]]; then
  echo "[chatgpt2codex] 3/3 checking public health..."
  if ! wait_public_http_ok "$PUBLIC_URL/healthz" 60 "public endpoint"; then
    echo "[chatgpt2codex] cloudflared log: $CFLOG" >&2
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
   - Ctrl+C stops server and any public tunnel.
   - Default mode is loopback-only and is not reachable from ChatGPT web.
   - Set CHATGPT2CODEX_EXPOSE_WEB=1 only while ChatGPT web needs a public URL.
   - Set PUBLIC_HOSTNAME plus CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME for a stable URL.
   - Web mode stays running unless CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES is set.
   - If the old owner token appeared in a chat/screenshot, rotate it.
============================================================
EOF

if [[ "$USE_TUNNEL" == "1" && -z "$PUBLIC_HOSTNAME" && -z "${CLOUDFLARED_TUNNEL_TOKEN:-}" && -z "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
  cat <<EOF
[chatgpt2codex] warning: this trycloudflare.com URL is temporary.
[chatgpt2codex] warning: ChatGPT app registration will need reconnect/update after the tunnel URL changes.
[chatgpt2codex] warning: set PUBLIC_HOSTNAME plus CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME for a stable URL.

EOF
fi

while true; do
  if [[ -f "$RUNTIME_RELOAD_FILE" ]]; then
    reload_server_runtime || true
  fi
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    if wait "$SRV_PID"; then
      echo "[chatgpt2codex] server stopped."
      exit 0
    fi
    echo "[chatgpt2codex] server exited. Log:" >&2
    cat "$SRVLOG" >&2
    exit 1
  fi
  if [[ "$USE_TUNNEL" == "1" ]] && ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "[chatgpt2codex] cloudflared exited. Log:" >&2
    cat "$CFLOG" >&2
    exit 1
  fi
  sleep_1s
done
