# Building from source

This repository keeps product source in Git and keeps local packaging,
installation, acceptance, and release automation outside the public tree.
Build outputs belong in local build directories or GitHub Release artifacts,
not in Git.

## Shared Node runtime

Requirements:

- Node.js 22 or newer
- npm

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
```

The compiled runtime is written to `dist/`. Start it with:

```bash
npm start
```

The public package scripts intentionally do not include local installation,
packaging, notarization, live connector, benchmark, or acceptance automation.

## macOS native executables

Install the Xcode Command Line Tools, then compile the three native binaries
from the repository root. The following commands compile binaries only; they
do not assemble, sign, notarize, install, or launch an application bundle.

```bash
mkdir -p build/macos/bin

swiftc -O \
  -framework AppKit \
  -framework Carbon \
  -framework CoreGraphics \
  -framework Foundation \
  -framework ScreenCaptureKit \
  -framework WebKit \
  macos/ChatGPTToCodexStatusBar/accessibility-bridge.swift \
  macos/ChatGPTToCodexStatusBar/main.swift \
  -o build/macos/bin/ChatGPTToCodexStatusBar

swiftc -O \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework Foundation \
  macos/ChatGPTToCodexStatusBar/ax-helper.swift \
  -o build/macos/bin/chatgpt2codex-ax

swiftc -O \
  -framework Foundation \
  macos/ChatGPTToCodexStatusBar/runtime-updater.swift \
  -o build/macos/bin/chatgpt2codex-runtime-updater
```

A distributable macOS application additionally requires bundle assembly,
resources, an embedded Node runtime and dependencies, code signing, and Apple
notarization. Maintain those environment-specific steps locally.

### Safe local app and runtime replacement

Keep application installation and runtime activation as separate transactions.
Before installing a local app candidate, verify its bundle identifier,
non-ad-hoc Team Identifier, designated requirement, and
`codesign --verify --deep --strict` result. Record the candidate main-executable
SHA-256 and verify the installed executable matches it. Stop the existing app
cleanly before swapping the bundle so an old launcher cannot resolve binaries
from a partially replaced `/Applications` path. Stage and verify the candidate
before moving the installed app, retain one exact rollback copy during the
transaction, and relaunch only after the installed signature is rechecked.
The live runtime must not perform that swap inline: a fixed detached worker
owns the drain barrier and persists a `0600` receipt so the result remains
queryable if graceful app termination closes the initiating MCP response. The
worker asks AppKit to quit first, uses bounded exact-PID signals only as a
fallback, stops a supervisor only when its parent proves that the old app owns
it, and waits for healthy runtime recovery after launching the new app. An
externally managed supervisor is observed but never signalled by app apply.

Runtime activation should use a private immutable snapshot rather than point at
the mutable source or build directory. The safe contract is:

1. compare the live and candidate runtime manifests and exact fingerprints;
2. prepare the snapshot and persist an idempotent request/operation receipt;
3. reject activation while any foreground or background operation or unrelated
   approval remains active;
4. acquire the bounded runtime-update drain barrier before requesting reload;
5. preserve the supervisor and externally managed connector/tunnel identity;
   immediately before pointer mutation, re-check that the approved supervisor
   PID is still alive and is still the supervisor reported by live health;
6. verify the new fingerprint through loopback health, otherwise restore the
   previous active-runtime pointer and prove the previous runtime is healthy;
7. release the barrier in a `finally` path.

Do not automatically replay a command whose subprocess may have crossed a
runtime restart. Such a record is forensic state with
`automaticRetrySafe=false`; inspect its process and artifacts before deciding
whether a fresh execution is safe.

Immutable snapshot cleanup is a separate approved transaction. Inventory
first, and always protect the active pointer, current process root, recent
apply/rollback roots, the newest three snapshots, and snapshots younger than
seven days. Never prune by a broad glob or storage pressure alone. The fixed
prune path accepts only `runtime-<64 lowercase hex>` directories below the
private release root, ignores symlinks, re-evaluates protection immediately
before deletion, and requires full-write plus local destructive approval.

## Windows launcher

Run the following in Windows PowerShell from the repository root. It compiles
the tray launcher only; it does not build or install an installer package.

```powershell
$ErrorActionPreference = "Stop"
$buildDir = Join-Path (Get-Location) 'build\windows'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw 'Microsoft .NET Framework csc.exe was not found.' }

$source = (Resolve-Path -LiteralPath 'windows\ChatGPTToCodexLauncher.cs').Path
$icon = (Resolve-Path -LiteralPath 'assets\chatgpt2codex-icon.ico').Path
$output = Join-Path $buildDir 'ChatGPT To Codex.exe'
& $csc /nologo /target:winexe "/win32icon:$icon" `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Web.Extensions.dll `
  /reference:System.Windows.Forms.dll `
  /reference:System.Drawing.dll `
  "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "Windows launcher compilation failed with exit code $LASTEXITCODE." }
Get-FileHash -LiteralPath $output -Algorithm SHA256
```

Create `build\windows` first if it does not exist. A distributable installer
also requires dependency bundling, signing, installer metadata, and real
Windows acceptance testing; keep that release automation local.

## Release boundary

Do not commit `dist/`, `build/`, application bundles, installers, signatures,
certificates, tokens, logs, or runtime state. Publish approved binary artifacts
through a release channel after platform-specific security and acceptance
checks.
