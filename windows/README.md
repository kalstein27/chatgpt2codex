# ChatGPT To Codex for Windows

Windows has a WinForms/PowerShell launcher and the shared TypeScript/Node runtime.
Together they provide project, file, patch, command, Git, image intake, OAuth,
connector, approval, and session-status features.

The current public tree does **not** contain the installer/portable-package/
installer-E2E builder automation referenced by older documentation. Treat an
installer filename as a release convention, not proof that a current Windows
artifact exists or passed acceptance. A successful TypeScript build or macOS
test is also not Windows release evidence.

Native Windows screenshot, click/type control, and UI Automation are not
implemented yet, so `Agent Arm` remains unavailable by design.

## Compatibility at a glance

| Area | Windows status |
| --- | --- |
| Windows 10 / 11 desktop | Intended source-run target; a release still needs real-Windows acceptance |
| Node runtime | Node.js 22 or newer is required for the public source-run path |
| PowerShell | Required; launch scripts use `powershell.exe -NoProfile -ExecutionPolicy Bypass` |
| Core local coding workflow | Supported through the shared runtime |
| Local loopback MCP | Supported without a public tunnel |
| ChatGPT web connector | Requires an externally reachable HTTPS connector URL |
| Cloudflare Quick/Named Tunnel | Requires `cloudflared` for those tunnel modes |
| Administrator rights | Not normally required |
| Native screenshot / desktop control | Not implemented yet |
| Windows ARM64 installer | Not release-validated; verify the exact asset on real Windows |

## What GitHub verifies on real Windows

The public `.github/workflows/verify-windows.yml` job runs on `windows-latest`
with read-only repository permissions. It currently verifies:

- `npm ci --ignore-scripts` and a production dependency audit
- TypeScript typecheck and the shared runtime build
- PowerShell parser acceptance for the public Windows scripts
- compilation of `windows/ChatGPTToCodexLauncher.cs` with the Windows .NET
  Framework C# compiler
- a live loopback HTTP smoke test that requires `/healthz` to report
  `platform=win32` and `transport=http`

That workflow is strong source/runtime evidence, but it intentionally does not
package, sign, publish, or click through a Windows installer. Installer and
SmartScreen acceptance therefore remain separate release evidence.

## Recommended install: clone the repository and build it yourself

The recommended Windows path is to clone the public repository, install the Node
dependencies, build the current source, and run that checkout. This avoids
depending on a separately packaged Windows build.

### 1. Install the prerequisites

Required:

- Windows 10 or Windows 11
- PowerShell
- Git for Windows
- Node.js 22 or newer

Recommended:

- Tailscale on the Windows PC and on the phone/tablet you use with ChatGPT

Tailscale is optional for the basic local runtime, but it is recommended because
it gives the PC a stable private tailnet identity and makes later remote Activity
and approval workflows much easier to reason about. Create or sign in to a
Tailscale account, install the Windows client, and sign the Windows PC and your
mobile device into the same tailnet.

The official Windows client requires Windows 10 or later. Tailscale's current
Windows installation guide is:

`https://tailscale.com/docs/install/windows`

### 2. Clone ChatGPT To Codex

Open PowerShell in the folder where you keep source projects:

```powershell
git clone https://github.com/kalstein27/chatgpt2codex.git ChatGPT2Codex
cd ChatGPT2Codex
```

To update this checkout later:

```powershell
git pull --ff-only
```

Do not run `git reset --hard`, `git clean`, or other destructive Git commands on
a checkout that contains work you want to keep.

### 3. Install dependencies and build

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

`npm run build` produces the shared Node runtime in `dist/`. If `dist/cli.js` is
missing when the launcher starts, `start-chatgpt.ps1` also attempts a build, but
running the explicit build above gives a much clearer first-install failure point.

### 4. Start the Windows tray UI

For the closest Windows equivalent to the desktop app experience, launch:

```powershell
.\windows\Start-ChatGPTToCodexTray.cmd
```

You can also double-click `windows\Start-ChatGPTToCodexTray.cmd` in Explorer.
That entry point runs the prerequisite helper and then starts the PowerShell tray
UI. The prerequisite helper can install Node.js and `cloudflared` through WinGet
when either command is missing.

If you only want the runtime without the tray UI, use:

```powershell
npm run chatgpt:windows
```

### 5. Select the project you want ChatGPT to work on

Open the tray icon, choose **Settings...**, and select the project folder. The
selected folder becomes the default project root shown to the runtime. You can
change it later; if MCP is already running the tray restarts the runtime against
the new selection.

### 6. Start MCP and verify local health

1. Click **Start MCP**.
2. Confirm the tray reports the runtime as running.
3. Open **Open Local Health**.
4. Confirm the configured local health page is healthy.

Administrator mode is not normally required for ChatGPT To Codex itself. Keep the
tray and any PowerShell window at the same privilege level unless a separately
diagnosed operation specifically requires elevation.

### 7. Connect ChatGPT web

ChatGPT web cannot reach a loopback-only MCP URL on the Windows PC. Enable the
web connector and use an externally reachable HTTPS connector URL.

The currently guaranteed built-in public-tunnel path on Windows is Cloudflare.
For Quick/Named Tunnel modes, `cloudflared` is required. The tray prerequisite
helper installs it through WinGet when needed.

A Quick Tunnel `trycloudflare.com` URL can change after restart. If it changes,
update or reconnect the ChatGPT connector. For regular use, prefer a stable HTTPS
hostname that you control.

Copy the `/mcp` connector URL from the tray and register it in ChatGPT Apps /
Connectors. Keep the Owner Token private. Treat it like a password.

## Tailscale recommendation

Even when Cloudflare is used for the ChatGPT `/mcp` connector, installing and
signing in to Tailscale is recommended. It gives the Windows PC and your phone a
stable private network where local operator pages can later be exposed without
making them public to the internet.

Tailscale Serve can proxy a local service to other devices in the same tailnet.
The C2CT Activity service listens locally on port `7980`. Tailscale's documented
Serve feature works on Windows, but the current C2CT `mobile_approval_setup`
helper still resolves only the approved macOS Tailscale CLI locations. Therefore
the fully automatic Mac-style Tailscale/mobile-approval setup is **not yet Windows
parity** and should not be described as automatic on Windows.

## Shared desktop UI

The Activity dashboard and desktop settings are one shared web UI used by both
macOS and Windows. While MCP is running, the Windows launcher opens the same UI
in Microsoft Edge app mode and hides the legacy launcher/log window to the tray.
Double-clicking the tray icon, or choosing **Open ChatGPT To Codex**, opens it
again. The direct loopback URL remains:

`http://127.0.0.1:7980/activity/`

The UI shows the current conversation/activity model, operation history, pending
approvals, deployment/runtime state, widget-load information, MCP health, and a
shared **Settings** tab. Those settings are persisted in the common desktop
settings document and then applied by the platform-native launcher. If Edge is
not available, Windows falls back to the system browser. The old WinForms window
remains a startup/recovery/log surface rather than the normal daily UI.

Local loopback viewing works cross-platform. Remote viewing is accepted only from
loopback or a request carrying a Tailscale identity. If you manually expose the
dashboard with Tailscale Serve, keep it private to the tailnet and follow the
current Tailscale Serve documentation rather than exposing port `7980` directly.

Important Windows limitation: remote Activity **viewing** can use Tailscale
identity, but the dashboard's remote approve/reject buttons require C2CT mobile
approval to be configured too. That automatic setup path is currently macOS-only,
so do not expect the full Mac mobile-approval experience on Windows yet.

## Web connector and cloudflared

The release workflow is not included in the minimal public source tree, and the
installer-E2E automation remains local-only. Installer/portable packaging still
needs to run on a real Windows runner before any artifact is treated as a release
candidate. Release binaries belong in GitHub Releases, not in the Git tree.

## Web connector and cloudflared

Starting MCP without the web connector is loopback-only. ChatGPT on the web needs
an externally reachable HTTPS connector URL. The Windows launcher supports
loopback, Cloudflare Quick Tunnel, Cloudflare Named Tunnel, and an externally
managed HTTPS origin.

For Quick/Named Tunnel modes, install `cloudflared`. The launcher adds the normal
WinGet Cloudflare package location to `PATH` automatically. One common install
command is:

```powershell
winget install --id Cloudflare.cloudflared
```

A Quick Tunnel `trycloudflare.com` URL can change after restart. Reconnect or
update the ChatGPT connector when that happens. For regular use, prefer a stable
HTTPS hostname that you control.

## Runtime behavior

- Loopback port: use the value currently configured/shown by the tray runtime; do not treat a historical default as process identity.
- Starting MCP is loopback-only unless the web connector is enabled.
- Temporary Quick Tunnel URLs may change after restart.
- The tray shows MCP state, selected project, local port, active sessions,
  pending approvals, Settings, diagnostics, and start/stop/restart actions.
- The launcher cleans stale runtime processes before restart.
- The native launcher starts `start-chatgpt.ps1` through `powershell.exe` without
  a console window and captures stdout/stderr in its logs.
- Launch-at-startup registration uses the current user's `HKCU` Run key.

The tray and terminal should run at the same privilege level. Do not recommend
Administrator mode unless a diagnosed operation specifically requires it.

## Platform boundary

Supported through the shared runtime:

- project discovery and scoped leases
- guarded file read/write and hash-checked patches
- allowlisted commands and bounded shell execution
- Git inspection
- image intake
- OAuth and connector sessions
- approval/status reporting

Not implemented on Windows yet:

- native desktop screenshot capture
- Windows UI Automation element targeting
- SendInput click/type/key control
- control leases backed by a Windows-native executor

The disabled `Agent Arm` item is intentional. Do not work around it with macOS
commands or claim native-control parity.

## How close is Windows to the current macOS experience?

For ordinary ChatGPT-to-code work, the experience is close: the shared runtime,
project discovery, work lanes, file read/write/patching, guarded commands, Git,
image intake, OAuth/connector sessions, approvals/status, connection diagnostics,
and the Activity dashboard are shared.

It is **not yet identical** to macOS in two important areas:

1. The automatic Tailscale Serve + ntfy mobile-approval setup currently resolves
   macOS Tailscale CLI paths only. Windows can run Tailscale and Tailscale Serve,
   but C2CT does not yet automate that setup on Windows.
2. Native desktop screenshot/click/type/UI-Automation control is not implemented
   on Windows, so `Agent Arm` remains unavailable.

If your normal Mac usage is ChatGPT asking C2CT to inspect/edit/test/build Git
projects, Windows should exercise the same shared runtime path. If your workflow
depends on Mac desktop control or one-tap mobile approval over the automatically
configured Tailscale bridge, Windows is not yet feature-identical.

## First-run verification on the Windows PC

Before calling a friend's installation good, verify all of these on that PC:

1. **ChatGPT To Codex** opens without requiring Administrator mode.
2. **Start MCP** reaches a healthy local state.
3. **Open Local Health** returns healthy on the configured loopback port.
4. The selected project folder is shown correctly.
5. A simple read-only C2CT request reaches the runtime.
6. If using ChatGPT web, public health works and the `/mcp` connector registers.
7. Restart MCP once and confirm it returns cleanly.
8. Check **Connection Diagnostics...** for unexplained repeated failures.

For release evidence, also record the Windows version, CPU architecture, Node
version for source-run testing, artifact SHA-256, and signing/SmartScreen state.

## Troubleshooting

- If the currently configured loopback port is busy, use **Restart MCP** from the tray and inspect logs.
- If the connector URL is empty, enable the web connector and restart MCP.
- If Cloudflare connector startup fails, confirm `cloudflared` is installed and
  reachable before retrying.
- If a temporary connector URL changes, replace the old ChatGPT connection.
- If tools are visible but calls fail, open **Connection Diagnostics...**. No
  event at the failure time means the request did not reach the local runtime.
- If SmartScreen appears, run the file only after verifying it came from the
  exact release or from your own source build and its checksum matches.
- If desktop screenshot/control tools are unavailable, that is currently expected
  on Windows; use ordinary Windows screenshot tools for visual evidence.

Keep machine-local installation, acceptance, and operator notes outside the
public Git tree. Use this README and the root README as the public source guide.

Copyright 2026 ezBuilder. All rights reserved.
