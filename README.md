# ChatGPT To Codex

A local bridge that lets ChatGPT work safely inside projects on your Mac or Windows PC.

ChatGPT To Codex connects ChatGPT to a local MCP runtime so it can inspect files, edit code, run tests, check Git state, and report results without uploading your whole repository.

> This repository is a development fork of [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex).

[Releases](https://github.com/kalstein27/chatgpt2codex/releases)

## What it does

- discovers local projects and reads project-specific rules
- searches and reads source files
- applies guarded edits and patches
- runs approved commands, tests, builds, and E2E checks
- reports Git status, diffs, operation state, and diagnostics
- supports approval-gated sensitive operations
- uses one shared desktop UI on macOS and Windows
- supports native macOS screenshot and desktop-control workflows

The normal desktop UI is the same on both platforms:

**Activity / Approvals / MCP / Connection / Settings / Diagnostics**

The macOS menu/status item and Windows tray are secondary surfaces for reopening the app, lifecycle actions, and recovery.

## Platform status

| Platform | Current status |
| --- | --- |
| macOS | Local coding workflow, shared desktop UI, native screenshot/E2E and desktop control supported. Public release should use a signed and notarized DMG. |
| Windows x64 / ARM64 | Shared runtime and desktop UI supported. Native Windows CI verifies the portable bundle. Native screenshot/click/type/UI Automation is not implemented yet. |
| Linux | Developer/runtime path only. No packaged desktop release. |

## Install

Windows uses a source-first install path. A signed GitHub Release is optional and is not required for a normal Windows install. When a user gives a coding agent only this repository URL and asks to install it, the agent should clone the repository, prepare the supported toolchain, build locally on that Windows PC, and launch the local build. Do not stop only because no Windows Release ZIP exists.

### macOS

1. Download the signed and notarized DMG from an official release when available.
2. Drag **ChatGPT To Codex** to **Applications**.
3. Launch the app and open **Settings**.

If no verified macOS release package is available, use the source-build path only when you intentionally want the developer workflow.

### Windows

The recommended public Windows path is to build from source on the target PC:

1. Clone this repository into a stable user-owned folder.
2. Ensure Git for Windows and Node.js 22+ with npm are available. A coding agent may install the official packages when the user asked it to perform the installation.
3. Run `npm ci --ignore-scripts`, `npm run typecheck`, `npm run test:publication`, and `npm run build`.
4. Launch `windows\Start-ChatGPTToCodexTray.cmd`.
5. Start MCP in the desktop UI and verify local health before connecting ChatGPT.

You can also run `npm run build:windows-portable` after the source build to create a self-contained local portable bundle. A locally built unsigned bundle is not a signed public release, and its existence must not be represented as Authenticode or SmartScreen acceptance.

See [windows/README.md](windows/README.md) for the one-pass Windows agent install flow, prerequisites, build, launch, and verification details.

## Connect ChatGPT

1. Open **Settings**. Selecting a project is optional for the first connection.
2. Open **MCP / Connection** and start MCP.
3. Enable **ChatGPT web connector** when ChatGPT on the web needs to reach this computer.
4. Copy the externally reachable HTTPS connector URL. It must end in `/mcp`.
5. Register that URL in ChatGPT as the `C2CT` MCP connector.
6. Complete the local OAuth approval when offered. Use the Owner Token only as a fallback.

A loopback-only MCP endpoint is local to the computer. ChatGPT web needs an externally reachable HTTPS endpoint.

For a new ChatGPT conversation, start with:

```text
@C2CT connection_status
```

Then call `agent_guide` before project work. The live guide is the source of truth for the current runtime contract.

## Safety

ChatGPT To Codex is designed for trusted local development.

- project work is scoped to explicit project roots and work lanes
- writes use guarded patch/edit paths instead of unrestricted remote shell access
- destructive, network, and sensitive operations stay approval-gated
- secret-looking values are redacted from tool output
- local project state and credentials are not intended to be committed to the public repository

Keep Owner Tokens and OAuth credentials out of chat messages, screenshots, logs, and issues.

## Current limitations

- Windows native desktop screenshot, click, type, and UI Automation control are not implemented yet, so `Agent Arm` remains unavailable on Windows.
- Tailscale Serve is tailnet-private. ChatGPT web needs Tailscale Funnel or another externally reachable HTTPS endpoint.
- A successful source build is not the same as a published, verified release package.

## Build from source

For development:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run test:publication
npm run build
```

Start the shared runtime with:

```bash
npm start
```

On Windows, build and verify the portable bundle on Windows:

```powershell
windows\Build-And-Verify-Portable.cmd
```

Do not treat macOS-only test results as Windows release acceptance.

## Documentation

- [Windows guide](windows/README.md)
- [Installation guide](docs/INSTALL.md)
- [Documentation map](docs/README.md)
- [Agent contract](AGENTS.md)

For implementation details, runtime replacement, connector diagnostics, approvals, and historical design notes, use the documents under `docs/` instead of expanding this README.
