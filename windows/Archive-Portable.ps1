param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Zip
)

$ErrorActionPreference = "Stop"
$stagePath = (Resolve-Path -LiteralPath $Stage).Path
if (-not (Test-Path -LiteralPath (Join-Path $stagePath "portable-manifest.json"))) {
    throw "Portable staging manifest is missing: $stagePath"
}

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
        Write-Warning "Could not inspect running Node paths before portable archive: $($_.Exception.Message)"
    }
    return $false
}

if (Test-RunningNodeInsidePath $stagePath) {
    throw "Refusing to archive a portable staging path while node.exe is running inside it: $stagePath"
}

$zipPath = [System.IO.Path]::GetFullPath($Zip)
$zipParent = Split-Path $zipPath -Parent
New-Item -ItemType Directory -Force -Path $zipParent | Out-Null
$partial = $zipPath + ".partial.zip"
Remove-Item -Force -ErrorAction SilentlyContinue $partial

Write-Host "[chatgpt2codex] Creating portable ZIP archive with atomic finalization..."
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $stagePath,
        $partial,
        [System.IO.Compression.CompressionLevel]::Fastest,
        $true
    )

    if (-not (Test-Path -LiteralPath $partial)) { throw "Portable ZIP archive was not created." }
    $partialInfo = Get-Item -LiteralPath $partial
    if ($partialInfo.Length -le 0) { throw "Portable ZIP archive is empty." }

    Remove-Item -Force -ErrorAction SilentlyContinue $zipPath
    Move-Item -LiteralPath $partial -Destination $zipPath
} catch {
    Remove-Item -Force -ErrorAction SilentlyContinue $partial
    throw
}

$zipInfo = Get-Item -LiteralPath $zipPath
if ($zipInfo.Length -le 0) { throw "Final portable ZIP archive is empty." }
$zipHash = Get-C2ctSha256Hex $zipPath
Write-Host "portable-bundle=$zipPath"
Write-Host "portable-bytes=$($zipInfo.Length)"
Write-Host "portable-sha256=$zipHash"
