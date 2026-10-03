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
$launcher = Join-Path $bundle "ChatGPT To Codex.exe"
$manifestPath = Join-Path $bundle "portable-manifest.json"
if (-not (Test-Path -LiteralPath $launcher)) { throw "Portable launcher is missing: $launcher" }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Portable manifest is missing: $manifestPath" }

$signature = Get-AuthenticodeSignature -LiteralPath $launcher
$signatureStatus = [string]$signature.Status
if ($signatureStatus -ne "Valid") {
    throw "Portable launcher Authenticode signature is not valid: $signatureStatus. Sign the staged launcher before finalizing the release bundle."
}
if ($null -eq $signature.SignerCertificate) {
    throw "Portable launcher signature is valid but no signer certificate was reported."
}
if ($null -eq $signature.TimeStamperCertificate) {
    throw "Portable launcher signature has no Authenticode timestamp. Timestamp the staged launcher before finalizing the release bundle."
}

$launcherHash = Get-C2ctSha256Hex $launcher
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$manifest.launcherSha256 = $launcherHash
$manifest | Add-Member -NotePropertyName launcherSignatureStatus -NotePropertyValue $signatureStatus -Force
$manifest | Add-Member -NotePropertyName launcherSignerSubject -NotePropertyValue ([string]$signature.SignerCertificate.Subject) -Force
$manifest | Add-Member -NotePropertyName launcherSignerThumbprint -NotePropertyValue ([string]$signature.SignerCertificate.Thumbprint) -Force
$manifest | Add-Member -NotePropertyName launcherTimestampSubject -NotePropertyValue ([string]$signature.TimeStamperCertificate.Subject) -Force
$manifest | Add-Member -NotePropertyName launcherTimestampThumbprint -NotePropertyValue ([string]$signature.TimeStamperCertificate.Thumbprint) -Force

$manifestPartial = $manifestPath + ".partial"
Remove-Item -Force -ErrorAction SilentlyContinue $manifestPartial
try {
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPartial -Encoding UTF8
    [System.IO.File]::Replace($manifestPartial, $manifestPath, $null)
} catch {
    Remove-Item -Force -ErrorAction SilentlyContinue $manifestPartial
    throw
}

$zip = $bundle + ".zip"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Archive-Portable.ps1") -Stage $bundle -Zip $zip
if ($LASTEXITCODE -ne 0) { throw "Signed portable archive finalization failed with exit code $LASTEXITCODE." }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Verify-Portable.ps1") -BundleRoot $bundle
if ($LASTEXITCODE -ne 0) { throw "Signed portable integrity verification failed with exit code $LASTEXITCODE." }

$signatureAfter = Get-AuthenticodeSignature -LiteralPath $launcher
if ([string]$signatureAfter.Status -ne "Valid") {
    throw "Portable launcher signature did not remain valid after finalization: $($signatureAfter.Status)"
}
if ($null -eq $signatureAfter.TimeStamperCertificate) {
    throw "Portable launcher timestamp was not preserved after finalization."
}

Write-Host "windows-signed-portable-finalization=PASS"
Write-Host "portable-root=$bundle"
Write-Host "portable-launcher-sha256=$launcherHash"
Write-Host "portable-launcher-signature-status=$signatureStatus"
Write-Host "portable-launcher-signer-subject=$($signature.SignerCertificate.Subject)"
Write-Host "portable-launcher-signer-thumbprint=$($signature.SignerCertificate.Thumbprint)"
Write-Host "portable-launcher-timestamp-subject=$($signature.TimeStamperCertificate.Subject)"
Write-Host "portable-launcher-timestamp-thumbprint=$($signature.TimeStamperCertificate.Thumbprint)"
Write-Host "portable-bundle=$zip"
Write-Host "portable-checksum=$zip.sha256"
