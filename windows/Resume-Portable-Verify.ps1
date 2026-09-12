param(
    [string]$OutputRoot = "build\windows-portable-next"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

$outputBase = if ([System.IO.Path]::IsPathRooted($OutputRoot)) { $OutputRoot } else { Join-Path $repoRoot $OutputRoot }
$outputBase = [System.IO.Path]::GetFullPath($outputBase)
$resumeLog = Join-Path $outputBase "resume-portable-verify.log"
$resumeResult = Join-Path $outputBase "resume-portable-verify.result.txt"
$transcriptStarted = $false
New-Item -ItemType Directory -Force -Path $outputBase | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $resumeResult
try {
    Start-Transcript -LiteralPath $resumeLog -Force | Out-Null
    $transcriptStarted = $true
} catch {
    Write-Warning "Could not start resume verification transcript: $($_.Exception.Message)"
}
trap {
    $message = $_.Exception.Message
    @("portable-resume-verify=FAIL", "error=$message") | Set-Content -LiteralPath $resumeResult -Encoding UTF8
    [Console]::Error.WriteLine("[chatgpt2codex] Resume verification failed: " + $message)
    if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
    exit 1
}
$node = Get-Command node.exe -ErrorAction Stop
$nodeArch = (& $node.Source -p "process.arch").Trim()
if (-not $nodeArch) { throw "Could not determine Node architecture." }

$stage = Join-Path $outputBase ("chatgpt2codex-windows-" + $nodeArch)
$zip = $stage + ".zip"
$stageManifest = Join-Path $stage "portable-manifest.json"
$sourceSeal = Join-Path $repoRoot "dist\runtime-build-manifest.json"
$stageSeal = Join-Path $stage "dist\runtime-build-manifest.json"

foreach ($required in @($stageManifest, $sourceSeal, $stageSeal)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Resume verification input is missing: $required" }
}

$sourceSealHash = (Get-FileHash -LiteralPath $sourceSeal -Algorithm SHA256).Hash
$stageSealHash = (Get-FileHash -LiteralPath $stageSeal -Algorithm SHA256).Hash
if ($sourceSealHash -ne $stageSealHash) {
    throw "Existing portable stage does not match the current sealed source build. Run Build-And-Verify-Portable.cmd instead."
}

$stageBuiltAt = (Get-Item -LiteralPath $stageManifest).LastWriteTimeUtc
$packagingInputs = @(
    "windows\ChatGPTToCodexLauncher.cs",
    "windows\Portable-README.txt",
    "start-chatgpt.ps1",
    "start-chatgpt.cmd",
    "package.json",
    "package-lock.json",
    "dist\runtime-build-manifest.json"
)
$staleInputs = @()
foreach ($relative in $packagingInputs) {
    $candidate = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $candidate)) { throw "Packaging input is missing: $relative" }
    if ((Get-Item -LiteralPath $candidate).LastWriteTimeUtc -gt $stageBuiltAt) { $staleInputs += $relative }
}
if ($staleInputs.Count -gt 0) {
    throw "Existing portable stage is older than packaging inputs: $($staleInputs -join ', '). Run Build-And-Verify-Portable.cmd instead."
}

Write-Host "[chatgpt2codex] Existing stage matches the current sealed source build."
Write-Host "[chatgpt2codex] Reusing stage: $stage"

$reuseZip = (Test-Path -LiteralPath $zip) -and
    ((Get-Item -LiteralPath $zip).Length -gt 0) -and
    ((Get-Item -LiteralPath $zip).LastWriteTimeUtc -ge $stageBuiltAt)
if ($reuseZip) {
    Write-Host "[chatgpt2codex] Reusing existing non-empty portable ZIP: $zip"
} else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Archive-Portable.ps1") -Stage $stage -Zip $zip
    if ($LASTEXITCODE -ne 0) { throw "Portable archive finalization failed with exit code $LASTEXITCODE." }
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Verify-Portable.ps1") -BundleRoot $stage
if ($LASTEXITCODE -ne 0) { throw "Portable integrity verification failed with exit code $LASTEXITCODE." }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Verify-Portable-First-Install-UI.ps1") -OutputRoot $outputBase
if ($LASTEXITCODE -ne 0) { throw "Portable first-install isolation verification failed with exit code $LASTEXITCODE." }

$npm = Get-Command npm.cmd -ErrorAction Stop
$npmCli = Join-Path (Split-Path $npm.Source -Parent) "node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path -LiteralPath $npmCli)) { throw "npm CLI was not found next to $($npm.Source)." }
& $node.Source $npmCli run diff:check
if ($LASTEXITCODE -ne 0) { throw "diff:check failed with exit code $LASTEXITCODE." }

Write-Host "portable-resume-verify=PASS"
Write-Host "portable-output-root=$outputBase"
"portable-resume-verify=PASS" | Set-Content -LiteralPath $resumeResult -Encoding UTF8
if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
