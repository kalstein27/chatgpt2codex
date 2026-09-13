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

Use an official release asset only when the matching verified package is attached to the GitHub Release. Do not silently substitute an Actions artifact or source build for an end-user install.

### macOS

1. Download the signed and notarized DMG from an official release when available.
2. Drag **ChatGPT To Codex** to **Applications**.
3. Launch the app and open **Settings**.

If no verified release package is available, use the source-build path below only as a developer workflow.

### Windows

The recommended end-user path is the architecture-matched portable ZIP.

1. Choose the ZIP for `x64` or `arm64`.
2. Verify the published SHA-256 when provided.
3. Extract the entire ZIP to a permanent user-writable folder.
4. Launch `ChatGPT To Codex.exe` from the extracted folder.

The portable bundle includes its own Node.js and npm. A machine-wide Node/npm installation is not required for normal portable use.

See [windows/README.md](windows/README.md) for the Windows install and verification details.

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
