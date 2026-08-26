#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
if [[ ! -f "$ROOT/package.json" && -f "$(dirname "${BASH_SOURCE[0]}")/package.json" ]]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

REPAIR=0
if [[ "${1:-}" == "--repair" || "${CHATGPT2CODEX_DOCTOR_REPAIR:-0}" == "1" ]]; then
  REPAIR=1
fi

export PATH="$ROOT/bin:$ROOT/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

STATUS=0
FIXED=0

ok() { printf '[OK] %s\n' "$*"; }
fixed() { FIXED=1; printf '[FIXED] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
block() { STATUS=1; printf '[ACTION REQUIRED] %s\n' "$*"; }

brew_install() {
  local formula="$1"
  local command_name="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$REPAIR" != "1" ]]; then
    return 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    return 1
  fi
  printf '[DOCTOR] installing %s with Homebrew...\n' "$formula"
  HOMEBREW_NO_AUTO_UPDATE=1 brew install "$formula"
  command -v "$command_name" >/dev/null 2>&1
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

need_cloudflared=0
doctor_tunnel_mode="${CHATGPT2CODEX_TUNNEL_MODE:-}"
if [[ -z "$doctor_tunnel_mode" ]]; then
  if [[ -n "${CHATGPT2CODEX_PUBLIC_URL:-}" ]]; then
    doctor_tunnel_mode="external"
  elif [[ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" || -n "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
    doctor_tunnel_mode="cloudflare-named"
  elif [[ "${PUBLIC_HOSTNAME:-}" == *.ts.net && "${PUBLIC_HOSTNAME:-}" != *"/"* && "${PUBLIC_HOSTNAME:-}" != *"@"* ]]; then
    doctor_tunnel_mode="external"
  elif [[ -n "${PUBLIC_HOSTNAME:-}" ]]; then
    doctor_tunnel_mode="cloudflare-named"
  elif [[ "${CHATGPT2CODEX_EXPOSE_WEB:-0}" == "1" ]]; then
    doctor_tunnel_mode="cloudflare-quick"
  else
    doctor_tunnel_mode="loopback"
  fi
fi
if [[ "$doctor_tunnel_mode" == cloudflare-* ]]; then
  need_cloudflared=1
fi

printf 'ChatGPT To Codex macOS Doctor\n'
printf 'Runtime: %s\n\n' "$ROOT"

if ! command -v curl >/dev/null 2>&1; then
  if brew_install curl curl; then
    fixed "curl installed"
  else
    block "curl is missing. Install Xcode Command Line Tools or Homebrew curl."
  fi
else
  ok "curl: $(command -v curl)"
fi

if ! command -v node >/dev/null 2>&1; then
  if brew_install node node; then
    fixed "Node.js installed"
  else
    block "Node.js 22+ is missing. Reinstall the pkg built with bundled Node, or install Node.js 22+."
  fi
fi

if command -v node >/dev/null 2>&1; then
  major="$(node_major)"
  if [[ "$major" -ge 22 ]]; then
    ok "node: $(node -v) ($(command -v node))"
  else
    if brew_install node node && [[ "$(node_major)" -ge 22 ]]; then
      fixed "Node.js upgraded to $(node -v)"
    else
      block "Node.js 22+ is required; found $(node -v 2>/dev/null || echo unknown)."
    fi
  fi
fi

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  block "dist/cli.js is missing. Reinstall ChatGPT To Codex or rebuild the source checkout."
else
  ok "runtime CLI found"
fi

if [[ ! -f "$ROOT/start-chatgpt.sh" ]]; then
  block "start-chatgpt.sh is missing. Reinstall ChatGPT To Codex."
elif [[ ! -x "$ROOT/start-chatgpt.sh" ]]; then
  warn "start-chatgpt.sh is not executable; app/npm launches remain available through bash, but direct ./start-chatgpt.sh execution is unavailable."
else
  ok "launcher script executable"
fi

if ! command -v pngpaste >/dev/null 2>&1; then
  if brew_install pngpaste pngpaste; then
    fixed "pngpaste installed for clipboard image intake"
  else
    warn "pngpaste not found; clipboard image intake is unavailable until pngpaste is installed."
  fi
else
  ok "pngpaste: $(command -v pngpaste)"
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  if [[ "$REPAIR" == "1" && -f "$ROOT/package-lock.json" ]] && command -v npm >/dev/null 2>&1; then
    printf '[DOCTOR] installing runtime npm dependencies...\n'
    (cd "$ROOT" && npm ci --omit=dev --ignore-scripts)
    if [[ -d "$ROOT/node_modules" ]]; then
      fixed "runtime npm dependencies installed"
    else
      block "runtime npm dependencies are missing and npm install did not create node_modules."
    fi
  else
    block "runtime npm dependencies are missing. Reinstall the pkg or run npm ci --omit=dev."
  fi
else
  ok "runtime npm dependencies found"
fi

if [[ "$need_cloudflared" == "1" ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    if brew_install cloudflared cloudflared; then
      fixed "cloudflared installed"
    else
      block "cloudflared is missing. Disable ChatGPT web connector, install cloudflared, or use a pkg built with bundled cloudflared."
    fi
  else
    ok "cloudflared: $(command -v cloudflared)"
  fi
else
  if command -v cloudflared >/dev/null 2>&1; then
    ok "cloudflared available for ChatGPT web connector"
  else
    warn "cloudflared not found; only needed when ChatGPT web connector is enabled"
  fi
fi

printf '\n'
if [[ "$STATUS" == "0" ]]; then
  if [[ "$FIXED" == "1" ]]; then
    printf 'Doctor result: ready after automatic repair.\n'
  else
    printf 'Doctor result: ready.\n'
  fi
else
  printf 'Doctor result: action required before first use.\n'
fi

exit "$STATUS"
