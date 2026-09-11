# ChatGPT To Codex for Windows

Windows has a WinForms/PowerShell launcher and the shared TypeScript/Node runtime.
Together they provide project, file, patch, command, Git, image intake, OAuth,
connector, approval, and session-status features.

The public tree now contains a source-driven portable-package builder. It creates
an architecture-matched ZIP with the launcher, built runtime, production Node
dependencies, its own `runtime\node.exe`, and a bundled `npm\bin\npm-cli.js`.
The portable runtime therefore does not depend on a machine-wide Node/npm install
for normal operation or in-app package-script verification. This is build evidence,
not proof of signing, SmartScreen acceptance, or installer-style release acceptance.

Native Windows screenshot, click/type control, and UI Automation are not
implemented yet, so `Agent Arm` remains unavailable by design.

## Compatibility at a glance

| Area | Windows status |
| --- | --- |
| Windows 10 / 11 desktop | Intended source-run target; a release still needs real-Windows acceptance |
| Node runtime | Node.js 22 or newer is required for the public source-run path; the portable bundle carries its own runtime |
| npm | `packageManager` records npm 11.19.0 as the validated release-tooling version; the portable bundle carries its own npm CLI |
| PowerShell | Required; launch scripts use `powershell.exe -NoProfile -ExecutionPolicy Bypass` |
| Core local coding workflow | Supported through the shared runtime |
| Local loopback MCP | Supported without a public tunnel |
| ChatGPT web connector | Requires an externally reachable HTTPS connector URL |
| Cloudflare Quick/Named Tunnel | Requires `cloudflared` for those tunnel modes |
| Administrator rights | Not normally required |
| Native screenshot / desktop control | Not implemented yet |
| Windows ARM64 installer | Not release-validated; verify the exact asset on real Windows |

## What GitHub verifies on real Windows

The public `.github/workflows/verify-windows.yml` job runs a native x64/ARM64
matrix with read-only repository permissions. It currently verifies:

- `npm ci --ignore-scripts` and a production dependency audit
- TypeScript typecheck and the shared runtime build
- PowerShell parser acceptance for the public Windows scripts
- compilation of `windows/ChatGPTToCodexLauncher.cs` with the Windows .NET
  Framework C# compiler
- a self-contained portable ZIP for the native runner architecture, including
  bundled Node/npm version and npm CLI hash verification
- an isolated portable first-install/restart test whose child PATH contains no
  machine-wide Node/npm
- a live loopback HTTP smoke test that requires `/healthz` to report
  `platform=win32` and `transport=http`

That workflow is strong source/runtime evidence, but it intentionally does not
sign, publish a GitHub Release, or click through a Windows installer. Signing and
SmartScreen acceptance therefore remain separate release evidence.

## End-user install: use the self-contained portable bundle

For ordinary Windows use, prefer the architecture-matched portable ZIP produced
by the verified Windows build/release flow. Extract the whole folder and launch
`ChatGPT To Codex.exe`. The portable bundle carries its own Node runtime and npm
CLI, so rebooting the PC or losing a machine-wide Node/npm installation does not
break the app's package-script execution path.

### Codex / coding-agent clean-install guide

This is the public one-pass path for a coding agent installing ChatGPT To Codex
on a clean Windows PC. The portable path must not install machine-wide Node, npm,
Git, or other developer tooling unless the user explicitly chooses the source
build path instead.

1. Detect the Windows CPU architecture and choose the exact matching Release
   asset: `chatgpt2codex-windows-arm64.zip` or
   `chatgpt2codex-windows-x64.zip`. End users should prefer a GitHub Release
   asset. GitHub Actions artifacts are short-lived verification candidates, not
   a substitute for a published Release.
2. If the matching `.zip.sha256` file is published, calculate the ZIP SHA-256
   with `Get-FileHash -Algorithm SHA256` and require an exact match before
   extraction.
3. Extract the entire archive to
   `%LOCALAPPDATA%\Programs\ChatGPT To Codex`. Do not run the EXE from inside the
   ZIP and do not copy only the EXE.
4. Before launch, verify at least these bundle members exist:
   `ChatGPT To Codex.exe`, `runtime\node.exe`, `npm\bin\npm-cli.js`,
   `dist\cli.js`, `start-chatgpt.ps1`, `portable-manifest.json`, `README.txt`,
   and `assets\chatgpt2codex-plugin-icon.png`. Confirm the manifest architecture
   matches the current PC.
5. Launch `ChatGPT To Codex.exe`, start MCP, and require local health to become
   healthy before continuing. If a step requires a human UI decision, stop and
   tell the user exactly what to click rather than guessing or bypassing it.
6. For ChatGPT web, enable the web connector and copy the externally reachable
   HTTPS connector URL. Register the bare `/mcp` endpoint in ChatGPT Apps /
   Plugins / Connectors under the name `C2CT`; do not append schema hashes or
   ad-hoc query parameters.
7. Complete OAuth interactively when offered. Keep Owner Token values private
   and use them only as a fallback. Never ask the user to paste credentials into
   an agent transcript.
8. If the ChatGPT connector registration UI exposes a custom-icon control, use
   `%LOCALAPPDATA%\Programs\ChatGPT To Codex\assets\chatgpt2codex-plugin-icon.png`.
   If the UI has no such control, report that fact instead of inventing one.
9. Final connection proof is a new ChatGPT conversation calling
   `connection_status` and immediately `agent_guide`. Treat the install as
   complete only when connection status reports `ok=true`, `finalHealthy=true`,
   and `transportErrors=0`.

One-shot prompt for Codex or another local coding agent:

```text
Install ChatGPT To Codex on this clean Windows PC using the latest verified
architecture-matched portable ZIP from the project's GitHub Release. Do not
install machine-wide Node/npm/Git for the portable path. Verify the published
SHA-256 when available, extract the whole bundle to
%LOCALAPPDATA%\Programs\ChatGPT To Codex, validate portable-manifest.json and the
required bundled files, then launch ChatGPT To Codex.exe. Guide me through only
the human steps needed to start MCP, confirm local health, enable the web
connector, and register the HTTPS bare /mcp endpoint in ChatGPT as C2CT. Use the
bundled assets\chatgpt2codex-plugin-icon.png only if the registration UI supports
a custom icon. Prefer OAuth; never expose Owner Token or OAuth credentials. Stop
on any architecture/hash/health mismatch and report the exact evidence.
```


## Developer/source install: clone and build the repository

Clone/build is the development path. It requires a machine-wide Node/npm toolchain
to install dependencies and create the first portable bundle. Once a portable
bundle is built, that bundle no longer depends on the machine-wide toolchain.

### 1. Install the prerequisites

Required:

- Windows 10 or Windows 11
- PowerShell
- Git for Windows
- Node.js 22 or newer, including npm

If Node/npm is missing, broken after a reboot, or only partially visible on PATH,
run this source-tree repair helper once:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File windows\Repair-Node-Npm.ps1
```

For a double-clickable wrapper, use `windows\Repair-Node-Npm.cmd`. The helper uses
the official WinGet package ID `OpenJS.NodeJS.LTS`, then refreshes the current
process PATH and verifies both Node.js 22+ and npm. WinGet may show Windows UAC
because the Node.js LTS package is machine-wide. It never deletes the checkout or
uninstalls unrelated software.

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

ChatGPT To Codex resolves `tailscale.exe` automatically. It prefers Windows
machine-wide App Paths and installer registration when available, then checks
the documented Program Files default, the registered Tailscale service location,
per-user install/app-alias locations, and finally `PATH`. This also supports MSI
installs whose `INSTALLDIR` was customized, without storing a per-PC hard-coded
Tailscale path in ChatGPT To Codex settings.

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
npm run test:publication
npm run build
```

`npm run build` produces the shared Node runtime in `dist/`. If `dist/cli.js` is
missing when the launcher starts, `start-chatgpt.ps1` also attempts a build, but
running the explicit build above gives a much clearer first-install failure point.
Ordinary end users should not need this source-development toolchain; use the
self-contained portable artifact instead.

The public branch intentionally excludes development-only `*.test.ts` files.
`npm test` therefore stays strict for development checkouts that contain tests,
while `npm run test:publication` is the publication-checkout command and permits
an empty Vitest set. Real Windows CI still performs typecheck, build, launcher
compilation, portable packaging, and a live HTTP health smoke test.

Use the same normal Windows user for `git clone`, `npm ci`, build, and runtime
launch. Do not clone as Administrator and then build as a different user. If Git
reports dubious ownership, prefer a fresh clone owned by the intended user; do
not silence the boundary globally with `safe.directory=*`.

### 4. Start the Windows tray UI

For the closest Windows equivalent to the desktop app experience, launch:

```powershell
.\windows\Start-ChatGPTToCodexTray.cmd
```

You can also double-click `windows\Start-ChatGPTToCodexTray.cmd` in Explorer.
That entry point runs the prerequisite helper and then starts the PowerShell tray
UI. Node.js is the default prerequisite. `cloudflared` is checked/installed only
when `CHATGPT2CODEX_TUNNEL_MODE` explicitly selects a Cloudflare tunnel mode.

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
in Edge app mode when available, then Chrome app mode as a fallback, and hides
the legacy launcher/log window to the tray.
Double-clicking the tray icon, or choosing **Open ChatGPT To Codex**, opens it
again. The direct loopback URL remains:

`http://127.0.0.1:7980/activity/`

The UI shows the current conversation/activity model, operation history, pending
approvals, deployment/runtime state, widget-load information, MCP health, and a
shared **Settings** tab. Those settings are persisted in the common desktop
settings document and then applied by the platform-native launcher. If neither
Edge nor Chrome app mode is available, Windows falls back to the system browser.
The old WinForms window remains a startup/recovery/log surface rather than the
normal daily UI.

Local loopback viewing works cross-platform. Remote viewing is accepted only from
loopback or a request carrying a Tailscale identity. If you manually expose the
dashboard with Tailscale Serve, keep it private to the tailnet and follow the
current Tailscale Serve documentation rather than exposing port `7980` directly.

Important Windows limitation: remote Activity **viewing** can use Tailscale
identity, but the dashboard's remote approve/reject buttons require C2CT mobile
approval to be configured too. That automatic setup path is currently macOS-only,
so do not expect the full Mac mobile-approval experience on Windows yet.

## Web connector and cloudflared

The portable builder is:

```powershell
npm run build:windows-portable
```

It emits `build\windows-portable\chatgpt2codex-windows-<arch>.zip`. The archive
includes its own Node executable and npm CLI and can run without a separately
installed Node/npm toolchain after extraction. The manifest records both bundled
versions and the npm CLI hash. Build it on the same CPU architecture you intend
to ship, and still perform real-Windows acceptance before treating it as a release.
Release binaries belong in GitHub Releases, not in the Git tree.

For the complete source-to-portable acceptance loop on a Windows developer PC,
double-click:

```text
windows\Build-And-Verify-Portable.cmd
```

It builds into the separate `build\windows-portable-next` staging root so a
currently running portable installation is never overwritten. If a matching
sealed stage and non-empty ZIP already exist and only the final isolation check
needs to be resumed, use `windows\Resume-Portable-Verify.cmd` instead.

The portable builder and archive helper calculate SHA-256 directly through .NET
cryptography instead of depending on `Get-FileHash` module auto-loading. The
builder also prints its PowerShell version and host executable for diagnostics.

Supported non-interactive Windows verification commands are:

```powershell
npm run verify:windows-oauth-wiring
npm run verify:windows-portable
```

The OAuth check verifies the launcher/local-control approval wiring from source.
The portable check validates launcher, bundled Node, bundled npm CLI, manifest
versions/hashes, architecture, brand assets, and the final non-empty ZIP. The
stronger `npm run verify:windows-portable-first-install-ui` test additionally
launches the portable runtime in an isolated child environment with machine-wide
Node/npm removed from PATH. `npm run verify:windows-owner-token-ui` remains an
interactive Win32 UI E2E test and is intentionally separate from unattended automation.

For source verification and CI, prefer `npm ci --ignore-scripts`. If a newer npm
reports an `allowScripts` warning for `esbuild`, do not globally enable package
scripts merely to silence the warning. The verified source flow installs with
scripts disabled, then runs typecheck/build explicitly. Review dependency state
with `npm run audit:prod` for production exposure and `npm run audit:moderate`
when reviewing development-tooling advisories.

`npm run publication:check` now builds the shared runtime first and executes the
publication guard with plain Node rather than `tsx`. This keeps the check usable
in restricted Windows user/sandbox contexts where TypeScript-loader startup can
fail during OS account discovery.

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

For a `.ts.net` external HTTPS origin, keep the distinction explicit: Tailscale
**Serve** is tailnet-private and is not enough for ChatGPT web. Tailscale
**Funnel** is the public exposure mode. ChatGPT To Codex verifies public health
before marking the connector Ready, but an externally managed Serve/Funnel
configuration is not enabled or disabled by this app. Quitting the Windows app
therefore warns that Funnel configuration may remain enabled separately.

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
- If a source rebuild says `node.exe` is in use, do not overwrite the running
  portable directory. Keep the app running from one extracted folder and build
  into `build\windows-portable-next`, or exit the old portable before replacing
  that exact folder. The builder refuses an unsafe in-place overwrite.
- If system npm disappears after reboot, ordinary portable use should continue
  because bundled npm is used. Only a source/developer rebuild needs the system
  toolchain; use `windows\Repair-Node-Npm.cmd` when that source toolchain is
  genuinely missing or broken.
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
