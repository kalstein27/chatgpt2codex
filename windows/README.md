# ChatGPT To Codex for Windows

Windows has a WinForms tray launcher, portable-bundle builder, installer builder,
and installer E2E script. The shared TypeScript/Node runtime provides project,
file, patch, command, Git, image intake, OAuth, connector, and session-status
features.

A Windows installer is publishable only after the current commit is built and
tested on a real Windows runner. A successful TypeScript build or macOS test is
not Windows release evidence. Native Windows screenshot, click, type, and UI
Automation control are not implemented yet, so `Agent Arm` remains unavailable.

## Install from an official release

Use this path only when a Windows setup asset is attached to an official GitHub
Release and its Windows acceptance checks are recorded.

1. Download `chatgpt2codex-<version>-windows-setup.exe` from the official release.
2. Verify the source and published checksum before running an unsigned build.
3. Launch **ChatGPT To Codex** and confirm the tray icon appears.
4. Open **Settings...**, choose a project, and start MCP.
5. Enable the web connector only when needed.
6. Copy the `/mcp` connector URL and approve the connection with the Owner Token.

Keep the Owner Token private. Treat it like a password.

The Windows release publishes three related assets:

- `chatgpt2codex-<version>-windows-setup.exe` — unsigned installer
- `chatgpt2codex-<version>-windows-portable.zip` — unsigned portable bundle
- `SHA256SUMS.txt` — SHA-256 manifest for both files

Authenticode signing remains TBD. A release containing these assets must not be
described as signed until a Windows signing and verification gate is added. The
current GitHub Actions release workflow therefore creates only a draft
prerelease for verification; it does not publish an unsigned stable release.

## Build from source

Prerequisites:

- Windows 10 or Windows 11
- PowerShell
- Node.js 22 or newer
- .NET Framework C# compiler available to the launcher build script

```powershell
npm ci
npm run typecheck
npm run build
```

Installer, portable-bundle, and installer-E2E automation are kept outside the
minimal public source tree. They must run on a real Windows runner before any
artifact is treated as a release candidate. Release binaries belong in GitHub
Releases, not in the Git tree.

## Runtime behavior

- Default loopback port: `7979`
- Starting MCP is loopback-only unless the web connector is enabled.
- Temporary Quick Tunnel URLs may change after restart.
- The tray shows MCP state, selected project, local port, active sessions,
  pending approvals, Settings, diagnostics, and start/stop/restart actions.
- The launcher cleans stale runtime processes before restart.

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

## Troubleshooting

- If port `7979` is busy, use **Restart MCP** from the tray and inspect logs.
- If the connector URL is empty, enable the web connector and restart MCP.
- If a temporary connector URL changes, replace the old ChatGPT connection.
- If tools are visible but calls fail, open **Connection Diagnostics...**. No
  event at the failure time means the request did not reach the local runtime.
- If SmartScreen appears, run the file only after verifying it came from the
  official release or from your own source build.

See [the Korean Windows quick start](../docs/WINDOWS-QUICKSTART.ko.md),
[the installation guide](../docs/INSTALL.md), and the
[build guide](../docs/BUILDING.md).

Copyright 2026 ezBuilder. All rights reserved.
