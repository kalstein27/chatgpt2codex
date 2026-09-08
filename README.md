<p align="center">
  <img src="assets/readme-hero.png" alt="ChatGPT To Codex local coding runtime" width="100%" />
</p>

# ChatGPT To Codex

**Give ChatGPT real local coding hands.**

ChatGPT To Codex is a local MCP and Actions runtime for macOS and Windows that lets ChatGPT
work inside the project folder you choose: read files, search code, apply
patches, run tests, launch E2E checks, and send back screenshot proof.

Your source stays on your machine. ChatGPT connects to the local app you run.
You choose the workspace, approve the token, and keep control of what gets
edited.

> **Development fork:** This repository is a development fork of
> [ezBuilder/chatgpt2codex](https://github.com/ezBuilder/chatgpt2codex), with
> separate modifications applied here.

[Official releases](https://github.com/ezBuilder/chatgpt2codex/releases)

> Help us get this in front of more builders: star the repo if you want
> ChatGPT to stop talking about code and start safely doing the repo loop.

## Why It Exists

ChatGPT is great at reasoning, but web chat alone cannot reliably inspect your
local repo, run your local tests, or prove what the UI actually looked like.
ChatGPT To Codex fills that gap:

- local project selection instead of uploading a source tree
- guarded file reads and hash-checked patching
- allowlisted local commands for tests and checks
- macOS app/window screenshot capture for visual E2E proof (Windows native capture planned)
- temporary or fixed HTTPS connector URL for ChatGPT web
- OAuth 2.1 + PKCE approval, with one-click local macOS approval and an Owner Token fallback
- multilingual macOS app window and Windows tray UI for non-English users

The mental model is simple:

```text
ChatGPT thinks. Your computer acts. You review the result.
```

## Build and release status

| Platform | Status | Package/build path |
| --- | --- | --- |
| macOS | Local/source workflow validated; publish only a signed and notarized release asset | Public source build: `npm run build`; release packaging stays outside Git |
| Windows | Tray and installer source exist; real Windows CI/E2E acceptance is still required before publishing | See [windows/README.md](windows/README.md) |
| Linux | Developer path only | Not published |

Installers are distributed as GitHub Release assets when the matching platform
release gates pass. They are not committed to the Git tree. A version in
`package.json` or a successful build on another operating system is not proof
that a signed installer has been published.

### Why DMG?

The macOS release uses the familiar drag-to-Applications DMG flow. The app
bundle already contains Node.js, cloudflared, the MCP runtime, and its native
helpers, so an installer package is not required. Public artifacts should be
Developer ID signed and notarized.

## What ChatGPT Can Do With It

Once connected, ChatGPT can operate like a practical coding agent over one or
more trusted local projects:

- list local projects and open an explicit work lane for each active project
- keep independent read/test/write lanes on distinct project roots concurrently
- read repo rules before editing
- search code and read exact line slices
- create files and apply patches
- run project commands, tests, and bounded background operations
- start a dev server and wait for a URL
- open a browser URL or installed desktop app
- capture macOS E2E screenshots (Windows native capture is not implemented yet)
- return inline screenshot previews through Actions
- save generated image assets into the repo
- summarize diffs, blockers, lane/lease state, and verification evidence

Tool precedence is client-aware. Remote ChatGPT is C2CT-first because it has no
direct local filesystem or shell. Local/native coding clients such as Codex CLI
and Claude Code are native-first: they should use their built-in file/search/
shell/test/Git/E2E/Computer Use tools for ordinary repository work, while C2CT
stays available for connector diagnostics, runtime/app lifecycle, approvals,
lease/session administration, media bridging, and explicit C2CT bridge tests.

`connection_status` and `agent_guide` form a global, lease-neutral bootstrap.
They work even when no project folder has been chosen and the workspace registry
is empty, so a newly installed connector can teach the agent the complete live
C2CT operating contract before any project capability is acquired.

When `agent_guide.capabilities.multiProjectLanes` reports `enabled`, ordinary
coding should start with `project_lane_open` only when actual project work begins,
retain the exact returned `workLaneId`, verify it with `project_lane_status`, and
carry that handle through lane-aware operations. Project discovery and
`project_rules(projectId=...)` are instruction-discovery reads and must not switch
another chat's serial lease. `project_select` remains for legacy/admin serial work
and desktop control; it should not be used merely to read instructions or make a
normal coding project active. Distinct project roots can hold independent
privileged lanes at once.
If a conversation loses its one-shot raw `workLaneId`, `project_lane_recover` can
clean up only that same conversation's stale privileged lane/root-lock without a
local approval. Foreign abandoned lanes remain approval-gated and are never
released automatically.


The standout workflow is:

```text
Run the E2E test, open the app, capture screenshots, and show me proof.
```

For web apps, ChatGPT To Codex can capture browser regions. For desktop apps
such as Tauri apps, it can open the built app window and capture top/middle/bottom
views. The one-shot `e2e_test_and_show_screenshot` action returns inline
`imageMarkdown` results so you can inspect the screen without digging through
local folders.

## Install In 5 Minutes

Public installation guidance lives in this README; machine-local operator notes stay outside Git.

Use an installer only when the matching asset is attached to an official
GitHub Release. Otherwise build from source and keep platform-specific steps
marked as unverified until they run on that platform.

macOS short version:

1. When a signed and notarized DMG is attached, download it from the official release.
2. Open the DMG and drag **ChatGPT To Codex** onto the **Applications** shortcut.
3. If macOS blocks the app, Control-click it, choose **Open**, and confirm in **System Settings** -> **Privacy & Security** if needed.
4. Open **ChatGPT To Codex** from Applications. The main window contains the former menu-bar commands in its left command sidebar.
5. Click **Settings...** in that sidebar.
6. Project folder selection is optional for first connection. The app can start MCP with its default workspace even when zero projects are registered; add or choose a project when you are ready to work on one.
7. Enable **ChatGPT web connector** if you want ChatGPT in the browser to connect.
8. Click **Start MCP** in the app sidebar.
9. Click **Copy Connector URL** in the app sidebar.
10. Register that `/mcp` URL in ChatGPT Apps / Connectors. On macOS, approve the exact OAuth request once in the ChatGPT To Codex app; use the Owner Token form only as a fallback.

The legacy macOS status item remains hidden; its command model is retained internally for compatibility, while user-facing controls live in the regular app window.

Windows short version (recommended source checkout):

1. Install Git for Windows and Node.js 22 or newer.
2. Tailscale is optional, but signing the Windows PC and your phone into the same
   tailnet is recommended for stable private operator access and future mobile
   Activity/approval workflows.
3. Clone and build the repository:

```powershell
git clone https://github.com/kalstein27/chatgpt2codex.git ChatGPT2Codex
cd ChatGPT2Codex
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

4. Start the tray UI with `windows\Start-ChatGPTToCodexTray.cmd`. The launcher
   helper can install missing Node.js and `cloudflared` through WinGet.
5. Open **Settings...**, choose the project folder, and click **Start MCP**.
6. Open local health, then open `http://127.0.0.1:7980/activity/` to verify the
   Activity dashboard.
7. For ChatGPT web, enable the web connector, copy its HTTPS `/mcp` URL, and
   register that URL in ChatGPT Apps / Connectors.

The runtime-only alternative is `npm run chatgpt:windows`. Administrator mode is
not normally required for ChatGPT To Codex itself. See
[windows/README.md](windows/README.md) for the full clone/build walkthrough,
Tailscale recommendation, Activity page, first-run checks, and Windows/macOS
parity notes.

Keep the Owner Token private. Treat it like a password.

The native macOS approval path never copies the Owner Token or OAuth
access/refresh tokens into the CLI, agent context, clipboard, or logs. ChatGPT
and C2CT complete the standard authorization-code + PKCE exchange directly.

## First Prompt To Try

```text
Use ChatGPT To Codex. Check connection_status and agent_guide first. Do not select
or lease a project merely to learn the rules. If no projects are registered,
report that as a valid first-connection state. When a project is available, resolve
its exact projectId and read project_rules/project_status directly. Only when
actual project work begins, open the smallest suitable work lane, verify the exact
workLaneId/leaseId with project_lane_status, and keep project_select reserved for
legacy/admin serial work or desktop control.
```

Then try a visual proof flow:

```text
Use ChatGPT To Codex to run the app E2E inside the current verified work lane,
capture screenshots, and show the passing screenshot set inline before you say
it is done.
```

## Safety Model

ChatGPT To Codex is designed for trusted local development, not arbitrary public
automation.

- It runs locally on your computer.
- It defaults to loopback-only networking.
- ChatGPT web requires an explicit connector/tunnel mode.
- File operations are scoped to the selected project or explicit project work lane.
- Non-overlapping project roots can hold independent privileged work lanes;
  same-root and ancestor/descendant privileged lane/serial conflicts fail closed.
- Patch application uses line/hash context.
- Owner Token approval is required for remote Actions access.
- Secret-looking values are redacted from tool output while labelled hashes,
  project-relative evidence paths, and readable classification values remain
  available for verification.
- Destructive, network, and sensitive operations remain approval-gated.

Do not expose the connector URL publicly unless you understand the tunnel and
token model. Do not paste Owner Tokens into issues, screenshots, or shared logs.

## Supported Languages

The desktop app can follow the system language and currently includes UI strings
for English, Korean, Japanese, Simplified Chinese, Traditional Chinese, Spanish,
French, German, Brazilian Portuguese, Italian, Dutch, Polish, Russian, Turkish,
Vietnamese, Indonesian, Thai, Arabic, Hindi, and Ukrainian.

Local installation and operator notes may contain additional languages without
becoming public repository content.

## Windows status

Windows uses the same shared Node runtime for project discovery, work lanes,
guarded file edits, commands, Git, image intake, OAuth/connectors, approval
status, diagnostics, and the Activity dashboard. The recommended installation
path is a Git clone plus local build, not a prebuilt Windows binary.

While MCP is running, the Activity page is available locally at
`http://127.0.0.1:7980/activity/`. Installing Tailscale on the Windows PC and
mobile devices is recommended, but automatic Tailscale Serve + ntfy mobile
approval setup is not yet Windows-parity. Native Windows desktop
screenshot/click/type/UI-Automation control is also not implemented, so
`Agent Arm` remains unavailable. See [windows/README.md](windows/README.md) for
the source-build walkthrough and the exact macOS/Windows parity boundary.

## Command side-effect metadata

`command_list` publishes machine-readable `sideEffects` for every discovered
command. Package scripts can narrow name-only heuristics with an optional
`package.json` `c2ct.commands` declaration. Script-body network/destructive
scans remain authoritative and cannot be downgraded by project metadata.

```json
{
  "scripts": {
    "fixed-local-install": "python3 tools/fixed_local_install.py"
  },
  "c2ct": {
    "commands": {
      "fixed-local-install": {
        "sideEffects": {
          "needsNetwork": false,
          "writesWorkspace": false,
          "writesExternalLocalPath": true,
          "launchesProcess": false,
          "destructive": false,
          "fixedDestination": true,
          "localApproval": "once"
        },
        "argProfiles": [
          {
            "id": "audit",
            "whenArgsContainAll": ["--audit"],
            "sideEffects": {
              "writesExternalLocalPath": false,
              "fixedDestination": false,
              "localApproval": "none"
            }
          }
        ]
      }
    }
  }
}
```

External-local writes are accepted as `local-file-mutation` only when the
destination is declared fixed. Otherwise they fail closed as destructive.
If multiple argv profiles match the same invocation, C2CT ignores the
ambiguous profiles and keeps the more conservative base policy. Caller
`intent.needsNetwork` is only an assertion; it cannot override the resolved
command policy.

Protected `command_run` calls keep the original tool operation alive while a
local/mobile approval is pending. Approval consumes the exact request and then
resumes that same command operation; callers should not redispatch the command
merely to consume an approval. Rejection, expiry, lease change, or client
cancellation remains pre-spawn and fails closed.

## Verified fixed local file operations

When a local artifact install is a fixed file mutation rather than a command,
declare it under `package.json` `c2ct.fixedLocalFileOperations` and call the
first-class `verified_local_file_apply` tool. The caller supplies only
`projectId`, the exact `workLaneId`, and an `operationSpecId`; the public schema
has no command, argv, raw source path, or raw destination path fields.

```json
{
  "c2ct": {
    "fixedLocalFileOperations": {
      "clean-dormant-install": {
        "source": {
          "projectRelativePath": "build/candidate.dylib",
          "sha256From": "build/result.json#candidate_sha256"
        },
        "destination": {
          "class": "user-application-support-measurement",
          "fixedRelativePath": "Example Product/Measurement/candidate.dylib"
        },
        "replaceMode": "atomic",
        "approval": "once",
        "network": false,
        "launchProcess": false
      }
    }
  }
}
```

The current `user-application-support-measurement` class is intentionally
narrow: it resolves beneath the user's Application Support directory, requires
an existing non-symlink `<product>/Measurement/` parent, and refuses traversal,
hidden-path components, source/destination symlinks, non-regular source files,
or mismatched SHA-256 evidence. The executor uses no subprocess or network
primitive. After one-shot approval the same tool operation resumes, writes an
attempt-count-1 durable receipt before external mutation, copies to a temporary
file, verifies its SHA, fsyncs where supported, atomically renames it, and
post-verifies the installed SHA. An existing exact attempt receipt blocks a
second attempt; automatic retry is never safe. This primitive does not replace
the dedicated runtime/app apply operations.

## Connection Diagnostics

When tools are visible in ChatGPT but a real call fails, open **Connection
Diagnostics...** from the macOS app's left command sidebar or the Windows tray.
The bounded JSONL log records only status codes, event/tool names, timing, and
diagnostic IDs; it does not record tokens, headers, request bodies, tool inputs, or tool outputs.
When a tool call still works, call `connection_status` for the same summary.
Use `connection_status` with `mode="compact"` for a smaller preflight response;
the default remains the backward-compatible full status. File mutation callers
can supply a stable `requestId` and inspect `mutation_status` after UNKNOWN or
response loss instead of blindly replaying the write. Every mutation receipt
keeps `automaticRetrySafe=false`.
Remote ChatGPT/MCP `command_run` calls are always handed off as background
operations, including callers that omit `executionMode` or request
`synchronous`. This keeps the host request short so a 30-90 second subprocess
cannot make one conversation look disconnected/disabled while the local runtime
is still healthy. Poll `operation_status`; read the terminal `outputRef` with
`output_read`. Local in-process callers keep synchronous semantics. `operation_cancel`
remains full-write and one-shot approval gated. While that local approval is
pending, the command's remaining timeout budget is paused for at most two minutes
so approval does not lose a race to the original deadline; a client
Stop/disconnect still never implies cancel or safe automatic retry.
## Repository contents

This public repository is intended to contain only the product source, the
reviewed public READMEs, reviewed assets, and reproducible scripts. Release binaries are
published as GitHub Release assets rather than committed. Local agent state,
personal automation rules, generated memory, hooks, private MCP config, build
output, installation backups, signing credentials, IDE state, E2E captures,
local databases, and machine-local logs are ignored.

If you see local-only files in a clone, they came from your machine, not from
the public repo. The public tree intentionally contains only product source,
reviewed assets, and the intentionally public README files.

## Build From Source

For developers:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
```

The shared runtime starts with:

```bash
npm start
```

Platform packaging, signing, notarization, live connector reload, and Windows
runner acceptance are intentionally kept outside the public source tree. The
commands above are the reproducible public source-build boundary.

## Star Pitch

If this saves you one "copy this patch, paste it in terminal, now run tests,
now send me a screenshot" loop, give it a star. The goal is simple: make
ChatGPT useful for real local development without turning your project into a
cloud upload.

Built by **ezBuilder**.
