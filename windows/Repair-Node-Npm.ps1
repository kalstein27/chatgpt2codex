param(
    [switch]$CheckOnly,
    [switch]$RebuildPortable
)

$ErrorActionPreference = "Stop"

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($machinePath)) { $parts += $machinePath }
    if (-not [string]::IsNullOrWhiteSpace($userPath)) { $parts += $userPath }
    $env:Path = $parts -join ";"
}

function Get-NodeNpmStatus {
    Refresh-ProcessPath
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $npmCli = $null
    $nodeVersion = $null
    $npmVersion = $null
    $nodeMajor = 0

    if ($node) {
        try {
            $nodeVersion = (& $node.Source --version).Trim()
            if ($nodeVersion -match '^v([0-9]+)\.') { $nodeMajor = [int]$Matches[1] }
        } catch {}
    }
    if ($node) {
        if ($npm) {
            $candidate = Join-Path (Split-Path $npm.Source -Parent) "node_modules\npm\bin\npm-cli.js"
            if (Test-Path -LiteralPath $candidate) { $npmCli = (Resolve-Path -LiteralPath $candidate).Path }
        }
        if (-not $npmCli) {
            $candidate = Join-Path (Split-Path $node.Source -Parent) "node_modules\npm\bin\npm-cli.js"
            if (Test-Path -LiteralPath $candidate) { $npmCli = (Resolve-Path -LiteralPath $candidate).Path }
        }
    }
    if ($node -and $npmCli) {
        try { $npmVersion = (& $node.Source $npmCli --version).Trim() } catch {}
    }

    [pscustomobject]@{
        Healthy = [bool]($node -and $npmCli -and $nodeMajor -ge 22 -and $npmVersion)
        NodePath = if ($node) { $node.Source } else { $null }
        NpmPath = if ($npm) { $npm.Source } elseif ($npmCli) { $npmCli } else { $null }
        NpmCliPath = $npmCli
        NodeVersion = $nodeVersion
        NpmVersion = $npmVersion
        NodeMajor = $nodeMajor
    }
}

function Wait-NodeNpmStable {
    param($Status)
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $lastError = $null
    do {
        $probe = Join-Path $env:TEMP ("c2ct-node-repair-probe-" + [guid]::NewGuid().ToString("N") + ".exe")
        try {
            $nodeVersion = (& $Status.NodePath --version).Trim()
            $npmVersion = (& $Status.NodePath $Status.NpmCliPath --version).Trim()
            [System.IO.File]::Copy($Status.NodePath, $probe, $true)
            Remove-Item -Force -ErrorAction SilentlyContinue $probe
            if ($nodeVersion -and $npmVersion) {
                Write-Host "node-npm-stable=true"
                return
            }
        } catch {
            $lastError = $_.Exception.Message
            Remove-Item -Force -ErrorAction SilentlyContinue $probe
        }
        Start-Sleep -Milliseconds 350
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Node.js/npm installation is present but file handles are still locked or unstable. Last error: $lastError"
}

$status = Get-NodeNpmStatus
if ($status.Healthy) {
    Write-Host "node-npm-status=healthy"
    Write-Host "node-version=$($status.NodeVersion)"
    Write-Host "npm-version=$($status.NpmVersion)"
    Write-Host "node-path=$($status.NodePath)"
    Write-Host "npm-path=$($status.NpmPath)"
    Wait-NodeNpmStable $status
    if (-not $RebuildPortable) { exit 0 }
}

if (-not $status.Healthy) {
    Write-Host "node-npm-status=repair-needed"
    if ($status.NodeVersion) { Write-Host "detected-node-version=$($status.NodeVersion)" }
    if ($status.NodePath) { Write-Host "detected-node-path=$($status.NodePath)" }
    if ($status.NpmPath) { Write-Host "detected-npm-path=$($status.NpmPath)" }

    if ($CheckOnly) {
        throw "Node.js 22+ with an npm CLI is not available from the machine/user installation."
    }

    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "WinGet is unavailable. Install or repair Microsoft App Installer, then rerun this script."
    }

    Write-Host "[chatgpt2codex] Repairing the source-development Node/npm prerequisite with the official WinGet Node.js LTS package..."
    Write-Host "[chatgpt2codex] Windows may show a UAC prompt because the Node.js LTS package installs machine-wide."

    & $winget.Source install `
        --id OpenJS.NodeJS.LTS `
        --exact `
        --source winget `
        --accept-package-agreements `
        --accept-source-agreements `
        --silent `
        --force `
        --disable-interactivity

    if ($LASTEXITCODE -ne 0) {
        throw "WinGet Node.js LTS installation/repair failed with exit code $LASTEXITCODE."
    }

    $status = Get-NodeNpmStatus
    if (-not $status.Healthy) {
        throw "Node.js/npm repair completed but Node.js 22+ and npm are still not visible. Sign out/restart Windows once, then rerun with -CheckOnly."
    }

    Write-Host "node-npm-repair=PASS"
    Write-Host "node-version=$($status.NodeVersion)"
    Write-Host "npm-version=$($status.NpmVersion)"
    Write-Host "node-path=$($status.NodePath)"
    Write-Host "npm-path=$($status.NpmPath)"
    Wait-NodeNpmStable $status
}

if ($RebuildPortable) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    Set-Location $repoRoot
    Write-Host "[chatgpt2codex] Running the isolated build/verify flow after repair..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Build-And-Verify-Portable.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Portable build/verify failed during repair bootstrap." }
    Write-Host "repair-bootstrap-portable=PASS"
}
