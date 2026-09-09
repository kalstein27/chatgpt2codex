param(
    [string]$BundleRoot = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

function Get-C2ctSha256Hex([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $sha256.Dispose()
    }
}

if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
    $outputBase = Join-Path $repoRoot "build\windows-portable"
    if (-not (Test-Path -LiteralPath $outputBase)) {
        throw "Portable output directory is missing. Run npm run build:windows-portable first."
    }
    $candidates = @(Get-ChildItem -LiteralPath $outputBase -Directory -Filter "chatgpt2codex-windows-*" -ErrorAction Stop)
    if ($candidates.Count -ne 1) {
        throw "Expected exactly one portable bundle directory under $outputBase; found $($candidates.Count). Pass -BundleRoot explicitly when multiple builds exist."
    }
    $BundleRoot = $candidates[0].FullName
}

$bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
$manifestPath = Join-Path $bundle "portable-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "portable-manifest.json is missing from $bundle" }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

$required = @(
    "ChatGPT To Codex.exe",
    "runtime\node.exe",
    "npm\bin\npm-cli.js",
    "dist\cli.js",
    "start-chatgpt.ps1",
    "package.json",
    "package-lock.json",
    "node_modules",
    "README.txt",
    "assets\chatgpt2codex-icon.ico",
    "assets\chatgpt2codex-icon.png",
    "assets\chatgpt2codex-icon.svg"
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $bundle $relative))) {
        throw "Portable bundle is missing required path: $relative"
    }
}

$launcherPath = Join-Path $bundle "ChatGPT To Codex.exe"
$nodePath = Join-Path $bundle "runtime\node.exe"
$npmCliPath = Join-Path $bundle "npm\bin\npm-cli.js"
$iconIcoPath = Join-Path $bundle "assets\chatgpt2codex-icon.ico"
$iconPngPath = Join-Path $bundle "assets\chatgpt2codex-icon.png"
$iconSvgPath = Join-Path $bundle "assets\chatgpt2codex-icon.svg"
$iconSvg = Get-Content -Raw -LiteralPath $iconSvgPath
if ($iconSvg -notmatch '#087E78' -or $iconSvg -notmatch '#FF9C14' -or $iconSvg -notmatch 'M755 758') {
    throw "Portable bundle brand SVG does not match the current ChatGPT To Codex icon contract."
}
if ((Get-Item -LiteralPath $iconIcoPath).Length -lt 1024 -or (Get-Item -LiteralPath $iconPngPath).Length -lt 4096) {
    throw "Portable bundle generated icon assets are unexpectedly small."
}
$launcherHash = Get-C2ctSha256Hex $launcherPath
$nodeHash = Get-C2ctSha256Hex $nodePath
$npmCliHash = Get-C2ctSha256Hex $npmCliPath
if ($launcherHash -ne [string]$manifest.launcherSha256) {
    throw "Launcher SHA-256 does not match portable-manifest.json."
}
if ($nodeHash -ne [string]$manifest.nodeSha256) {
    throw "Bundled Node SHA-256 does not match portable-manifest.json."
}
if ($npmCliHash -ne [string]$manifest.npmCliSha256) {
    throw "Bundled npm CLI SHA-256 does not match portable-manifest.json."
}

$nodeVersion = (& $nodePath --version).Trim()
$nodeArch = (& $nodePath -p "process.arch").Trim()
$npmVersion = (& $nodePath $npmCliPath --version).Trim()
if ($nodeVersion -ne [string]$manifest.nodeVersion) {
    throw "Bundled Node version $nodeVersion does not match manifest $($manifest.nodeVersion)."
}
if ($nodeArch -ne [string]$manifest.architecture) {
    throw "Bundled Node architecture $nodeArch does not match manifest $($manifest.architecture)."
}
if ($npmVersion -ne [string]$manifest.npmVersion) {
    throw "Bundled npm version $npmVersion does not match manifest $($manifest.npmVersion)."
}

$zip = "$bundle.zip"
if (-not (Test-Path -LiteralPath $zip)) { throw "Portable ZIP is missing: $zip" }
$zipInfo = Get-Item -LiteralPath $zip
if ($zipInfo.Length -le 0) { throw "Portable ZIP is empty: $zip" }
$zipHash = Get-C2ctSha256Hex $zip

Write-Host "windows-portable-verification=PASS"
Write-Host "portable-root=$bundle"
Write-Host "portable-architecture=$nodeArch"
Write-Host "portable-node-version=$nodeVersion"
Write-Host "portable-npm-version=$npmVersion"
Write-Host "portable-launcher-sha256=$launcherHash"
Write-Host "portable-node-sha256=$nodeHash"
Write-Host "portable-npm-cli-sha256=$npmCliHash"
Write-Host "portable-brand-icon=true"
Write-Host "portable-zip-sha256=$zipHash"
