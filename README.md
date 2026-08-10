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

[Installation guide](docs/INSTALL.md) ·
[Build guide](docs/BUILDING.md) ·
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
- OAuth-style owner-token approval so random clients cannot just attach
- multilingual menu bar app for non-English users

The mental model is simple:

```text
ChatGPT thinks. Your computer acts. You review the result.
```

## Build and release status

| Platform | Status | Package/build path |
| --- | --- | --- |
| macOS | Local/source workflow validated; publish only a signed and notarized release asset | See [the build guide](docs/BUILDING.md) |
| Windows | Tray and installer source exist; real Windows CI/E2E acceptance is still required before publishing | See [the Windows quick start](docs/WINDOWS-QUICKSTART.ko.md) |
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

Once connected, ChatGPT can operate like a practical coding agent over a trusted
project:

- list local projects and select the active one
- read repo rules before editing
- search code and read exact line slices
- create files and apply patches
- run project commands and tests
- start a dev server and wait for a URL
- open a browser URL or installed desktop app
- capture macOS E2E screenshots (Windows native capture is not implemented yet)
- return inline screenshot previews through Actions
- save generated image assets into the repo
- summarize diffs, blockers, and verification evidence

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

Full beginner guide: [docs/INSTALL.md](docs/INSTALL.md)

Use an installer only when the matching asset is attached to an official
GitHub Release. Otherwise build from source and keep platform-specific steps
marked as unverified until they run on that platform.

macOS short version:

1. When a signed and notarized DMG is attached, download it from the
   [official releases](https://github.com/ezBuilder/chatgpt2codex/releases).
2. Open the DMG and drag **ChatGPT To Codex** onto the **Applications** shortcut.
3. If macOS blocks the app, Control-click it, choose **Open**, and
   confirm in **System Settings** -> **Privacy & Security** if needed.
4. Open **ChatGPT To Codex** from Applications.
5. Open **Settings...** from the menu bar icon.
6. Choose a project folder.
7. Enable **ChatGPT web connector** if you want ChatGPT in the browser to connect.
8. Click **Start MCP**.
9. Click **Copy Connector URL**.
10. Register that `/mcp` URL in ChatGPT Apps / Connectors and approve with the
    Owner Token shown by the app.

Windows short version:

1. When a Windows installer has passed its Windows runner checks and is
   attached, download it from the
   [official releases](https://github.com/ezBuilder/chatgpt2codex/releases).
2. Double-click the installer.
3. If Windows SmartScreen warns, choose **More info** -> **Run anyway** only if
   the file came from this GitHub release.
4. Launch **ChatGPT To Codex**.
5. Open the tray icon settings, choose your project folder, enable the ChatGPT
   web connector if needed, then click **Start MCP**.
6. Copy the `/mcp` Connector URL and approve it in ChatGPT with the Owner Token.

Keep the Owner Token private. Treat it like a password.

## First Prompt To Try

```text
Use ChatGPT To Codex. Select my project, read the README and package scripts,
run the safest available check, then summarize the result with exact evidence.
```

Then try a visual proof flow:

```text
Use ChatGPT To Codex to run the app E2E, capture screenshots, and show the
passing screenshot set inline before you say it is done.
```

## Safety Model

ChatGPT To Codex is designed for trusted local development, not arbitrary public
automation.

- It runs locally on your computer.
- It defaults to loopback-only networking.
- ChatGPT web requires an explicit connector/tunnel mode.
- File operations are scoped to the selected project.
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

The install guide currently includes Korean, English, Japanese, and Simplified
Chinese. More documentation languages are welcome.

## Windows status

Windows has tray, portable-bundle, installer, and installer-E2E source paths.
The shared workspace, file, patch, command, Git, image intake, OAuth, and
session-status runtime is implemented, but a Windows release is not accepted
until those paths run on a real Windows runner. Native Windows desktop
screenshot/click/type control is not implemented, so the tray deliberately
shows `Agent Arm: unavailable on Windows` instead of accepting a lease it
cannot execute. See
[docs/WINDOWS-QUICKSTART.ko.md](docs/WINDOWS-QUICKSTART.ko.md),
[docs/INSTALL.md](docs/INSTALL.md), and [windows/README.md](windows/README.md).

## Connection Diagnostics

When tools are visible in ChatGPT but a real call fails, open **Connection
Diagnostics...** from the macOS menu bar or Windows tray. The bounded JSONL log
records only status codes, event/tool names, timing, and diagnostic IDs; it
does not record tokens, headers, request bodies, tool inputs, or tool outputs.
When a tool call still works, call `connection_status` for the same summary.
See [docs/CONNECTION-DIAGNOSTICS.ko.md](docs/CONNECTION-DIAGNOSTICS.ko.md).

## Repository contents

This public repository is intended to contain only the product source, public
documentation, reviewed assets, and reproducible scripts. Release binaries are
published as GitHub Release assets rather than committed. Local agent state,
personal automation rules, generated memory, hooks, private MCP config, build
output, installation backups, signing credentials, IDE state, E2E captures,
local databases, and machine-local logs are ignored.

If you see local-only files in a clone, they came from your machine, not from
the public repo. The public tree intentionally contains only product source,
reviewed assets, and the small set of user-facing guides linked above.

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
runner acceptance are intentionally kept outside the public source tree. See
[docs/BUILDING.md](docs/BUILDING.md) for the reproducible source build boundary.

## Star Pitch

If this saves you one "copy this patch, paste it in terminal, now run tests,
now send me a screenshot" loop, give it a star. The goal is simple: make
ChatGPT useful for real local development without turning your project into a
cloud upload.

Built by **ezBuilder**.
