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
| Windows 10 / 11 desktop | Native x64/ARM64 CI covers the source/portable path; a published signed release still needs release acceptance |
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

The portable source build is intentionally signing-provider-neutral. For a real
signed release, sign the staged `ChatGPT To Codex.exe` with the approved Windows
code-signing provider **before** the final ZIP is published. Use a SHA-256 code
signature and an RFC 3161 SHA-256 timestamp; a release signature without a
timestamp is not accepted by the finalization gate. Then run
`npm run finalize:windows-signed-portable`. That command refuses an invalid or
missing/timestamp-free Authenticode signature, refreshes the launcher's manifest SHA-256, and
recreates both the ZIP and its `.zip.sha256` sidecar. This keeps certificate or
trusted-signing credentials outside the repository while still making the final
packaging step reproducible.

Use `npm run verify:windows-release-candidate` to report the current launcher
signature status while enforcing all portable integrity/checksum checks. The
final publish gate is `npm run verify:windows-release-signed`; it fails unless the
launcher has a valid timestamped Authenticode signature and the final ZIP/checksum pair still
matches the staged bundle.

## Windows install: source-first local build

The public Windows install path is source-first. A signed GitHub Release is
optional and is not required for a normal installation. The intended trust model
is to fetch the public source, build it on the target Windows PC, verify the local
build, and then run that local build. Do not stop solely because the repository
has no Windows Release ZIP.

This avoids making paid Authenticode signing a prerequisite for ordinary use. A
locally built unsigned executable is still unsigned: do not describe it as a
signed release, SmartScreen-approved binary, or installer acceptance evidence.

### Codex / coding-agent clean-install guide

If the user supplies only the GitHub repository URL and says **"install this"**,
use this source-build path by default and carry it through to a running local app.
Do not switch to a GitHub Actions artifact or other prebuilt binary merely to
avoid building locally.

1. Detect the Windows CPU architecture (`x64` or `arm64`) and record it for build
   verification. The build must run natively on the target architecture.
2. Choose a stable user-owned checkout directory. `%LOCALAPPDATA%\ChatGPT2Codex\source`
   is a suitable default. If that path already exists but is not this repository,
   do not delete or overwrite it; choose another directory and report the choice.
3. Ensure the supported prerequisites exist: PowerShell, Git for Windows, Node.js
   22 or newer, and npm. When the user asked the agent to perform the installation,
   the agent may install missing prerequisites from their official WinGet packages
   (`Git.Git` and `OpenJS.NodeJS.LTS`). Do not use unofficial binary mirrors.
4. Clone `https://github.com/kalstein27/chatgpt2codex.git` into the chosen directory.
   For an existing valid checkout with no conflicting local work, update with
   `git pull --ff-only`. Never use `git reset --hard` or `git clean` to force an
   update.
5. From the checkout run:

   ```powershell
   npm ci --ignore-scripts
   npm run typecheck
   npm run test:publication
   npm run build
   ```

   Stop and report the exact failing command if any of these checks fails.
6. Launch the source-built desktop app with
   `windows\Start-ChatGPTToCodexTray.cmd`. A machine-wide Node/npm installation is
   required for this source checkout path.
7. Start MCP and require local health to become healthy before continuing. If a
   step requires a human UI decision, tell the user exactly what to click rather
   than guessing or bypassing it.
8. For ChatGPT web, enable the web connector and copy the externally reachable
   HTTPS connector URL. Register the bare `/mcp` endpoint in ChatGPT Apps /
   Plugins / Connectors under the name `C2CT`; do not append schema hashes or
   ad-hoc query parameters.
9. Complete OAuth interactively when offered. Keep Owner Token values private and
   use them only as a fallback. Never ask the user to paste credentials into an
   agent transcript.
10. Final connection proof is a new ChatGPT conversation calling
    `connection_status` and immediately `agent_guide`. Treat the install as
    complete only when connection status reports `ok=true`, `finalHealthy=true`,
    and `transportErrors=0`.

Optional: after the source build succeeds, `npm run build:windows-portable` can
create a self-contained portable ZIP for local reuse on that same architecture.
The resulting unsigned bundle is a local build artifact, not a signed public
release, and it does not need to be uploaded to GitHub for the install flow above.

One-shot prompt for Codex or another local coding agent:

```text
Install ChatGPT To Codex from this GitHub repository on this Windows PC. Use a
source-first install: detect the native architecture, ensure official Git for
Windows and Node.js 22+ with npm are available, clone or safely fast-forward the
repository in a stable user-owned folder, run npm ci --ignore-scripts, typecheck,
test:publication, and build, then launch windows\Start-ChatGPTToCodexTray.cmd.
Do not stop just because there is no Windows Release ZIP, do not use Actions
artifacts as an install substitute, and never use git reset --hard or git clean to
erase local work. Guide me through only the human steps needed to start MCP,
confirm local health, enable the web connector, and register the HTTPS bare /mcp
endpoint in ChatGPT as C2CT. Prefer OAuth and never expose Owner Token or OAuth
credentials. Report the exact command and evidence on any failure.
```

## Manual source install: clone and build the repository

The manual path uses the same source-first model. It requires a machine-wide
Node/npm toolchain to install dependencies and build the runtime. If you also
create a portable bundle afterward, that portable bundle no longer depends on the
machine-wide toolchain.

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
For the source-first public Windows install, this toolchain is the bootstrap and
update path. Building a portable bundle afterward is optional.

The public branch intentionally excludes development-only `*.test.ts` files.
`npm test` therefore stays strict for development checkouts that contain tests,
while `npm run test:publication` is the publication-checkout command and permits
an empty Vitest set. Real Windows CI still performs typecheck, build, launcher
compilation, portable packaging, and a live HTTP health smoke test.

Use the same normal Windows user for `git clone`, `npm ci`, build, and runtime
launch. Do not clone as Administrator and then build as a different user. If Git
reports dubious ownership, prefer a fresh clone owned by the intended user; do
not silence the boundary globally with `safe.directory=*`.

### 4. Start the Windows desktop app

For a source checkout, launch:

```powershell
.\windows\Start-ChatGPTToCodexTray.cmd
```

You can also double-click `windows\Start-ChatGPTToCodexTray.cmd` in Explorer.
That entry point bootstraps the native launcher/tray and opens the same shared
desktop shell used on macOS. On Windows the shell is rendered in Edge app mode,
with Chrome app mode and then the system browser as fallbacks. The tray remains
a secondary lifecycle/recovery surface rather than a separate main UI. Node.js
is the default source prerequisite. `cloudflared` is checked/installed only when
`CHATGPT2CODEX_TUNNEL_MODE` explicitly selects a Cloudflare tunnel mode.

If you only want the runtime without the desktop launcher, use:

```powershell
npm run chatgpt:windows
```

### 5. Select the project you want ChatGPT to work on

Open **Settings** in the shared desktop shell and select the project folder. The
selected folder becomes the default project root shown to the runtime. You can
change it later. If the shared window is closed, use the tray only to reopen
**ChatGPT To Codex** or access platform-native lifecycle/recovery shortcuts.

### 6. Start MCP and verify local health

1. Open **MCP / Connection** in the shared desktop shell.
2. Click **Start MCP**.
3. Confirm the local MCP health/status becomes healthy.
4. Use the native tray status only as a secondary mirror/recovery surface.

Administrator mode is not normally required for ChatGPT To Codex itself. Keep the
tray and any PowerShell window at the same privilege level unless a separately
diagnosed operation specifically requires elevation.

### 7. Connect ChatGPT web

ChatGPT web cannot reach a loopback-only MCP URL on the Windows PC. Enable the
web connector and use an externally reachable HTTPS connector URL.

The currently guaranteed built-in public-tunnel path on Windows is Cloudflare.
For Quick/Named Tunnel modes, `cloudflared` is required. The native launcher
prerequisite helper installs it through WinGet when needed.

A Quick Tunnel `trycloudflare.com` URL can change after restart. If it changes,
update or reconnect the ChatGPT connector. For regular use, prefer a stable HTTPS
hostname that you control.

Copy the `/mcp` connector URL from **MCP / Connection** in the shared desktop
shell and register it in ChatGPT Apps / Connectors. Keep the Owner Token private.
Treat it like a password.

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

It emits `build\windows-portable\chatgpt2codex-windows-<arch>.zip` plus the
matching `chatgpt2codex-windows-<arch>.zip.sha256` sidecar. The checksum file uses
the conventional `<sha256>  <filename>` format so both humans and local install
agents can verify the exact artifact before extraction. The archive includes its
own Node executable and npm CLI and can run without a separately installed Node/npm
toolchain after extraction. The manifest records both bundled versions and the npm
CLI hash. Build it on the same CPU architecture where it will be used. For any
published binary, perform real-Windows acceptance before treating it as a release.
Publishing the ZIP is optional; the source-first installation path does not require
a GitHub Release. If a binary is ever published as an official release, keep the
existing signed-release verification requirements. Release binaries do not belong
in the Git tree.

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
npm run verify:windows-release-candidate
npm run verify:windows-release-signed
```

The OAuth check verifies the launcher/local-control approval wiring from source.
The portable check validates launcher, bundled Node, bundled npm CLI, manifest
versions/hashes, architecture, brand assets, and the final non-empty ZIP/checksum
pair. The release-candidate check additionally rejects broken Authenticode states
while still allowing a deliberately unsigned `NotSigned` CI candidate. The signed
release check requires a valid timestamped launcher signature. The
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

- Loopback port: use the value currently configured/shown by **MCP / Connection** or the native runtime status; do not treat a historical default as process identity.
- Starting MCP is loopback-only unless the web connector is enabled.
- Temporary Quick Tunnel URLs may change after restart.
- The shared desktop shell is the normal UI for Activity, Approvals, MCP /
  Connection, Settings, and Diagnostics. The tray is secondary and provides
  reopen/quit plus platform-native lifecycle/recovery shortcuts and status hints.
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
