param(
    [string]$OutputRoot = "build\windows-portable"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

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

$hostExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
Write-Host "portable-powershell-version=$($PSVersionTable.PSVersion)"
Write-Host "portable-powershell-host=$hostExe"

if (-not (Test-Path "dist\cli.js")) {
    throw "dist/cli.js is missing. Run npm run build first."
}
if (-not (Test-Path "node_modules")) {
    throw "node_modules is missing. Run npm ci --ignore-scripts first."
}

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeExe = $nodeCommand.Source
$nodeArch = (& $nodeExe -p "process.arch").Trim()
if (-not $nodeArch) { throw "Could not determine Node architecture." }

$bundleName = "chatgpt2codex-windows-$nodeArch"
$outputBase = Join-Path $RepoRoot $OutputRoot
$stage = Join-Path $outputBase $bundleName
$zip = Join-Path $outputBase ($bundleName + ".zip")

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stage
Remove-Item -Force -ErrorAction SilentlyContinue $zip
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage "runtime") | Out-Null

Copy-Item -Recurse -Force "dist" (Join-Path $stage "dist")
Copy-Item -Recurse -Force "node_modules" (Join-Path $stage "node_modules")
Copy-Item -Force "package.json", "package-lock.json", "start-chatgpt.ps1", "start-chatgpt.cmd" $stage
Copy-Item -Force "windows\Portable-README.txt" (Join-Path $stage "README.txt")
Copy-Item -Force $nodeExe (Join-Path $stage "runtime\node.exe")

# Keep the archive self-contained without carrying development-only packages.
& npm prune --omit=dev --ignore-scripts --prefix $stage | Out-Null
if ($LASTEXITCODE -ne 0) { throw "npm prune failed while preparing the portable bundle." }

$cscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw "Microsoft .NET Framework csc.exe was not found." }
$source = (Resolve-Path "windows\ChatGPTToCodexLauncher.cs").Path
$icon = (Resolve-Path "assets\chatgpt2codex-icon.ico").Path
$launcher = Join-Path $stage "ChatGPT To Codex.exe"
& $csc /nologo /target:winexe "/win32icon:$icon" /reference:System.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$launcher" $source
if ($LASTEXITCODE -ne 0) { throw "Windows launcher compilation failed with exit code $LASTEXITCODE." }

$manifest = [ordered]@{
    schemaVersion = 1
    architecture = $nodeArch
    nodeVersion = (& $nodeExe --version).Trim()
    launcherSha256 = Get-C2ctSha256Hex $launcher
    nodeSha256 = Get-C2ctSha256Hex (Join-Path $stage "runtime\node.exe")
    builtAtUtc = [DateTime]::UtcNow.ToString("o")
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage "portable-manifest.json") -Encoding UTF8

Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
$zipHash = Get-C2ctSha256Hex $zip
Write-Host "portable-bundle=$zip"
Write-Host "portable-arch=$nodeArch"
Write-Host "portable-sha256=$zipHash"
