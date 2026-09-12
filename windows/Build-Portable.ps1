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

$npmCliCandidates = @()
if (-not [string]::IsNullOrWhiteSpace($env:npm_execpath)) {
    $npmCliCandidates += $env:npm_execpath
}
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCommand) {
    $npmCliCandidates += Join-Path (Split-Path $npmCommand.Source -Parent) "node_modules\npm\bin\npm-cli.js"
}
$npmCliCandidates += Join-Path (Split-Path $nodeExe -Parent) "node_modules\npm\bin\npm-cli.js"
$npmCli = $npmCliCandidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1
if (-not $npmCli) {
    throw "npm CLI was not found next to the build Node runtime. Install Node with npm or invoke this script through npm run build:windows-portable."
}
$npmCli = (Resolve-Path -LiteralPath $npmCli).Path
$npmPackageRoot = Split-Path (Split-Path $npmCli -Parent) -Parent
$npmVersion = (& $nodeExe $npmCli --version).Trim()
if (-not $npmVersion) { throw "Could not determine npm version." }

$bundleName = "chatgpt2codex-windows-$nodeArch"
$outputBase = if ([System.IO.Path]::IsPathRooted($OutputRoot)) { $OutputRoot } else { Join-Path $RepoRoot $OutputRoot }
$outputBase = [System.IO.Path]::GetFullPath($outputBase)
$stage = Join-Path $outputBase $bundleName
$zip = Join-Path $outputBase ($bundleName + ".zip")

function Test-RunningNodeInsidePath {
    param([string]$CandidateRoot)
    try {
        $normalizedRoot = [System.IO.Path]::GetFullPath($CandidateRoot).TrimEnd('\') + '\'
        $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
        foreach ($processInfo in $processes) {
            $exePath = [string]$processInfo.ExecutablePath
            if ([string]::IsNullOrWhiteSpace($exePath)) { continue }
            $normalizedExe = [System.IO.Path]::GetFullPath($exePath)
            if ($normalizedExe.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
    } catch {
        Write-Warning "Could not inspect running Node paths before portable staging: $($_.Exception.Message)"
    }
    return $false
}

function Copy-WithRetry {
    param([string]$Source, [string]$Destination, [switch]$Recurse, [string]$Label)
    $lastError = $null
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        try {
            if (Test-Path -LiteralPath $Destination) {
                if ($Recurse) { Remove-Item -Recurse -Force -LiteralPath $Destination }
                else { Remove-Item -Force -LiteralPath $Destination }
            }
            if ($Recurse) { Copy-Item -Recurse -Force $Source $Destination }
            else { Copy-Item -Force $Source $Destination }
            return
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 350
        }
    }
    throw "Could not copy $Label after repeated file-lock retries. Last error: $lastError"
}

if (Test-RunningNodeInsidePath $stage) {
    throw "Refusing to overwrite portable staging path because a running node.exe is inside it: $stage. Build to a different OutputRoot, such as build\windows-portable-next."
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stage
Remove-Item -Force -ErrorAction SilentlyContinue $zip
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage "runtime"), (Join-Path $stage "assets") | Out-Null

Copy-WithRetry "dist" (Join-Path $stage "dist") -Recurse -Label "dist"
Copy-WithRetry "node_modules" (Join-Path $stage "node_modules") -Recurse -Label "node_modules"
Copy-Item -Force "package.json", "package-lock.json", "start-chatgpt.ps1", "start-chatgpt.cmd" $stage
Copy-Item -Force "windows\Portable-README.txt" (Join-Path $stage "README.txt")
Copy-WithRetry $nodeExe (Join-Path $stage "runtime\node.exe") -Label "node.exe"
Copy-WithRetry $npmPackageRoot (Join-Path $stage "npm") -Recurse -Label "npm package"

# Keep the archive self-contained without carrying development-only packages.
& $nodeExe $npmCli prune --omit=dev --ignore-scripts --prefix $stage | Out-Null
if ($LASTEXITCODE -ne 0) { throw "npm prune failed while preparing the portable bundle." }

$cscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw "Microsoft .NET Framework csc.exe was not found." }
$source = (Resolve-Path "windows\ChatGPTToCodexLauncher.cs").Path
$brandDir = Join-Path $RepoRoot "build\windows-brand-icon"
New-Item -ItemType Directory -Force -Path $brandDir | Out-Null
$icon = Join-Path $brandDir "chatgpt2codex-icon.ico"
$iconPng = Join-Path $brandDir "chatgpt2codex-icon.png"
$iconSvg = (Resolve-Path "assets\chatgpt2codex-icon.svg").Path
$pluginIcon = (Resolve-Path "assets\chatgpt2codex-plugin-icon.png").Path
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Generate-BrandIcon.ps1") -SourceSvg $iconSvg -OutputIco $icon -OutputPng $iconPng
if ($LASTEXITCODE -ne 0) { throw "Windows brand icon generation failed with exit code $LASTEXITCODE." }
Copy-Item -Force $icon (Join-Path $stage "assets\chatgpt2codex-icon.ico")
Copy-Item -Force $iconPng (Join-Path $stage "assets\chatgpt2codex-icon.png")
Copy-Item -Force $iconSvg (Join-Path $stage "assets\chatgpt2codex-icon.svg")
Copy-Item -Force $pluginIcon (Join-Path $stage "assets\chatgpt2codex-plugin-icon.png")
$launcher = Join-Path $stage "ChatGPT To Codex.exe"
& $csc /nologo /target:winexe "/win32icon:$icon" /reference:System.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$launcher" $source
if ($LASTEXITCODE -ne 0) { throw "Windows launcher compilation failed with exit code $LASTEXITCODE." }

$manifest = [ordered]@{
    schemaVersion = 1
    architecture = $nodeArch
    nodeVersion = (& $nodeExe --version).Trim()
    npmVersion = $npmVersion
    launcherSha256 = Get-C2ctSha256Hex $launcher
    nodeSha256 = Get-C2ctSha256Hex (Join-Path $stage "runtime\node.exe")
    npmCliSha256 = Get-C2ctSha256Hex (Join-Path $stage "npm\bin\npm-cli.js")
    pluginIconSha256 = Get-C2ctSha256Hex (Join-Path $stage "assets\chatgpt2codex-plugin-icon.png")
    builtAtUtc = [DateTime]::UtcNow.ToString("o")
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage "portable-manifest.json") -Encoding UTF8

$archiveScript = Join-Path $PSScriptRoot "Archive-Portable.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $archiveScript -Stage $stage -Zip $zip
if ($LASTEXITCODE -ne 0) { throw "Portable archive creation failed with exit code $LASTEXITCODE." }
Write-Host "portable-arch=$nodeArch"
Write-Host "portable-npm-version=$npmVersion"
