param(
    [string]$BundleRoot = "",
    [switch]$RequireSignedLauncher
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

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
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Verify-Portable.ps1") -BundleRoot $bundle
if ($LASTEXITCODE -ne 0) { throw "Portable integrity verification failed with exit code $LASTEXITCODE." }

$launcher = Join-Path $bundle "ChatGPT To Codex.exe"
if (-not (Test-Path -LiteralPath $launcher)) { throw "Portable launcher is missing: $launcher" }
$signature = Get-AuthenticodeSignature -LiteralPath $launcher
$signatureStatus = [string]$signature.Status
$isSigned = $signatureStatus -eq "Valid"
$hasTimestamp = $null -ne $signature.TimeStamperCertificate

if (-not $isSigned -and $signatureStatus -ne "NotSigned") {
    throw "Portable launcher has an invalid Authenticode state: $signatureStatus. Unsigned CI candidates may be NotSigned, but malformed or broken signatures are not accepted."
}
if ($RequireSignedLauncher -and -not $isSigned) {
    throw "Release candidate requires a valid Authenticode launcher signature; current status: $signatureStatus"
}
if ($RequireSignedLauncher -and -not $hasTimestamp) {
    throw "Release candidate requires a timestamped Authenticode launcher signature."
}
if ($isSigned -and $null -eq $signature.SignerCertificate) {
    throw "Portable launcher signature is valid but no signer certificate was reported."
}

Write-Host "windows-release-candidate=PASS"
Write-Host "portable-root=$bundle"
Write-Host "portable-launcher-signature-status=$signatureStatus"
Write-Host "portable-launcher-signed=$($isSigned.ToString().ToLowerInvariant())"
Write-Host "portable-launcher-timestamped=$($hasTimestamp.ToString().ToLowerInvariant())"
Write-Host "portable-signature-required=$($RequireSignedLauncher.IsPresent.ToString().ToLowerInvariant())"
if ($isSigned) {
    Write-Host "portable-launcher-signer-subject=$($signature.SignerCertificate.Subject)"
    Write-Host "portable-launcher-signer-thumbprint=$($signature.SignerCertificate.Thumbprint)"
    if ($hasTimestamp) {
        Write-Host "portable-launcher-timestamp-subject=$($signature.TimeStamperCertificate.Subject)"
        Write-Host "portable-launcher-timestamp-thumbprint=$($signature.TimeStamperCertificate.Thumbprint)"
    }
}
