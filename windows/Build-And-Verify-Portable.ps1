param(
    [string]$OutputRoot = "build\windows-portable-next"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

$outputBase = if ([System.IO.Path]::IsPathRooted($OutputRoot)) { $OutputRoot } else { Join-Path $repoRoot $OutputRoot }
$outputBase = [System.IO.Path]::GetFullPath($outputBase)
New-Item -ItemType Directory -Force -Path $outputBase | Out-Null
$logPath = Join-Path $outputBase "build-and-verify.log"
$transcriptStarted = $false
try {
    Start-Transcript -LiteralPath $logPath -Force | Out-Null
    $transcriptStarted = $true
} catch {
    Write-Warning "Could not start transcript log: $($_.Exception.Message)"
}

$node = Get-Command node.exe -ErrorAction Stop
$npm = Get-Command npm.cmd -ErrorAction Stop
$npmCli = Join-Path (Split-Path $npm.Source -Parent) "node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path -LiteralPath $npmCli)) { throw "npm CLI was not found next to $($npm.Source)." }

function Wait-NodeToolchainStable {
    param([string]$Phase)
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $lastError = $null
    do {
        $nodeProbe = Join-Path $env:TEMP ("c2ct-node-probe-" + [guid]::NewGuid().ToString("N") + ".exe")
        $npmProbe = Join-Path $env:TEMP ("c2ct-npm-probe-" + [guid]::NewGuid().ToString("N") + ".js")
        try {
            $nodeVersion = (& $node.Source --version).Trim()
            $npmVersion = (& $node.Source $npmCli --version).Trim()
            [System.IO.File]::Copy($node.Source, $nodeProbe, $true)
            [System.IO.File]::Copy($npmCli, $npmProbe, $true)
            Remove-Item -Force -ErrorAction SilentlyContinue $nodeProbe, $npmProbe
            if ($nodeVersion -and $npmVersion) {
                Write-Host "[chatgpt2codex] Node/npm stable ($Phase): $nodeVersion / npm $npmVersion"
                return
            }
        } catch {
            $lastError = $_.Exception.Message
            Remove-Item -Force -ErrorAction SilentlyContinue $nodeProbe, $npmProbe
        }
        Start-Sleep -Milliseconds 350
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Node/npm remained locked or unstable during '$Phase'. Last error: $lastError"
}

function Invoke-Npm {
    param([string[]]$NpmArgs, [string]$Phase)
    Wait-NodeToolchainStable ("before " + $Phase)
    Write-Host "[chatgpt2codex] >>> npm $($NpmArgs -join ' ')"
    & $node.Source $npmCli @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "$Phase failed with exit code $LASTEXITCODE." }
    Wait-NodeToolchainStable ("after " + $Phase)
}

try {
    Write-Host "[chatgpt2codex] Using Node: $($node.Source)"
    Write-Host "[chatgpt2codex] Using npm CLI: $npmCli"
    Write-Host "[chatgpt2codex] Log: $logPath"

    $previousRuntimeRoot = $env:CHATGPT2CODEX_RUNTIME_ROOT
    # Source verification must never inherit the identity of a currently
    # executing portable runtime. Point every child build explicitly at source.
    $env:CHATGPT2CODEX_RUNTIME_ROOT = $repoRoot

    Invoke-Npm @("run", "typecheck") "typecheck"
    Invoke-Npm @("run", "test:publication") "test:publication"
    Invoke-Npm @("run", "build") "build"

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Build-Portable.ps1") -OutputRoot $outputBase
    if ($LASTEXITCODE -ne 0) { throw "portable build failed with exit code $LASTEXITCODE." }

    $nodeArch = (& $node.Source -p "process.arch").Trim()
    $expectedStage = Join-Path $outputBase ("chatgpt2codex-windows-" + $nodeArch)
    $expectedZip = $expectedStage + ".zip"
    if (-not (Test-Path -LiteralPath (Join-Path $expectedStage "portable-manifest.json"))) {
        throw "Portable build reported success but the isolated staging manifest is missing: $expectedStage"
    }
    if (-not (Test-Path -LiteralPath $expectedZip)) {
        throw "Portable build reported success but the isolated ZIP is missing: $expectedZip"
    }
    if ((Get-Item -LiteralPath $expectedZip).Length -le 0) {
        throw "Portable build reported success but the isolated ZIP is empty: $expectedZip"
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Verify-OAuth-Approval-Wiring.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Windows OAuth approval wiring verification failed with exit code $LASTEXITCODE." }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Verify-Portable.ps1") -BundleRoot $expectedStage
    if ($LASTEXITCODE -ne 0) { throw "Portable integrity verification failed with exit code $LASTEXITCODE." }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Verify-Portable-First-Install-UI.ps1") -OutputRoot $outputBase
    if ($LASTEXITCODE -ne 0) { throw "portable first-install isolation verification failed with exit code $LASTEXITCODE." }

    Invoke-Npm @("run", "diff:check") "diff:check"

    Write-Host "portable-build-verify=PASS"
    Write-Host "oauth-wiring-verify=PASS"
    Write-Host "portable-integrity-verify=PASS"
    Write-Host "portable-output-root=$OutputRoot"
    Write-Host "[chatgpt2codex] The currently running portable folder was not overwritten."
} finally {
    if ([string]::IsNullOrEmpty($previousRuntimeRoot)) {
        Remove-Item Env:CHATGPT2CODEX_RUNTIME_ROOT -ErrorAction SilentlyContinue
    } else {
        $env:CHATGPT2CODEX_RUNTIME_ROOT = $previousRuntimeRoot
    }
    if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
}
