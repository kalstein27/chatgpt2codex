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
npm ci
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
