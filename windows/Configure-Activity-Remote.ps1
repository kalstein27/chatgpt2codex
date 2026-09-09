param(
    [ValidateSet("Enable", "Disable", "Status")]
    [string]$Action = "Enable"
)

$ErrorActionPreference = "Stop"
$activityPort = 7980
$tailscaleHttpsPort = 8443
$tailscaleResolver = Join-Path $PSScriptRoot "Tailscale-Path.ps1"
if (-not (Test-Path -LiteralPath $tailscaleResolver -PathType Leaf)) { throw "Tailscale resolver script is missing." }
. $tailscaleResolver

function Invoke-HttpStatus([string]$Url, [int]$TimeoutSec = 5) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Uri $Url
        return [int]$response.StatusCode
    } catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            return [int]$_.Exception.Response.StatusCode
        }
        return 0
    }
}

$tailscaleInfo = Resolve-TailscaleCli
$tailscale = [string]$tailscaleInfo.Path

$statusText = (& $tailscale status --json 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "tailscale status --json failed: $statusText" }
$status = $statusText | ConvertFrom-Json
if ($status.BackendState -ne "Running") { throw "Tailscale is not running (BackendState=$($status.BackendState))." }
$dnsName = [string]$status.Self.DNSName
if ([string]::IsNullOrWhiteSpace($dnsName)) { throw "Tailscale status did not report Self.DNSName." }
$dnsName = $dnsName.Trim().TrimEnd('.')

if ($Action -eq "Disable") {
    $disableText = (& $tailscale serve --yes "--https=$tailscaleHttpsPort" off 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Failed to disable Activity Tailscale Serve: $disableText" }
    Write-Host "activity-remote=DISABLED"
    Write-Host "tailscale-path-source=$($tailscaleInfo.Source)"
    Write-Host "tailscale-dns=$dnsName"
    Write-Host "tailscale-https-port=$tailscaleHttpsPort"
    exit 0
}

$localUrl = "http://127.0.0.1:$activityPort/activity/"
$localApiUrl = "http://127.0.0.1:$activityPort/activity/api/activity"
if ((Invoke-HttpStatus $localUrl) -ne 200) { throw "Local Activity dashboard is not healthy at $localUrl" }
if ((Invoke-HttpStatus $localApiUrl) -ne 200) { throw "Local Activity API is not healthy at $localApiUrl" }

if ($Action -eq "Enable") {
    $enableText = (& $tailscale serve --bg --yes "--https=$tailscaleHttpsPort" "http://127.0.0.1:$activityPort" 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure Activity Tailscale Serve: $enableText" }
}

$serveText = (& $tailscale serve status 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "tailscale serve status failed: $serveText" }
if ($serveText -notmatch [regex]::Escape(":$tailscaleHttpsPort") -or $serveText -notmatch [regex]::Escape("127.0.0.1:$activityPort")) {
    throw "Tailscale Serve status does not show HTTPS $tailscaleHttpsPort -> 127.0.0.1:$activityPort. Status: $serveText"
}

$remoteBase = "https://$dnsName`:$tailscaleHttpsPort/activity/"
$remotePageStatus = 0
$remoteApiStatus = 0
for ($attempt = 0; $attempt -lt 12; $attempt++) {
    $remotePageStatus = Invoke-HttpStatus $remoteBase 5
    $remoteApiStatus = Invoke-HttpStatus ($remoteBase + "api/activity") 5
    if ($remotePageStatus -eq 200 -and $remoteApiStatus -eq 200) { break }
    Start-Sleep -Milliseconds 500
}
if ($remotePageStatus -ne 200 -or $remoteApiStatus -ne 200) {
    throw "Tailnet Activity verification failed (page=$remotePageStatus api=$remoteApiStatus) at $remoteBase"
}

$remoteSettingsStatus = Invoke-HttpStatus ($remoteBase + "api/settings") 5
if ($remoteSettingsStatus -notin @(403, 404)) {
    throw "Remote settings endpoint must not be readable (expected 403 or 404, got $remoteSettingsStatus)."
}

Write-Host "activity-remote=PASS"
Write-Host "activity-action=$($Action.ToLowerInvariant())"
Write-Host "tailscale-path-source=$($tailscaleInfo.Source)"
Write-Host "tailscale-dns=$dnsName"
Write-Host "tailscale-https-port=$tailscaleHttpsPort"
Write-Host "activity-url=$remoteBase"
Write-Host "local-page=200"
Write-Host "local-api=200"
Write-Host "remote-page=200"
Write-Host "remote-api=200"
Write-Host "remote-settings=$remoteSettingsStatus"
Write-Host "security=tailnet-only-tailscale-identity"
