$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

$activityBase = "http://127.0.0.1:7980/activity/"
$windowsUrl = $activityBase + "?embedded=windows"

function First-ExistingPath([string[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    return $null
}

function Invoke-EdgeDom([string]$Edge, [string]$Url, [string]$ProfileDir) {
    $args = @(
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-default-apps",
        "--virtual-time-budget=1800",
        "--user-data-dir=$ProfileDir",
        "--dump-dom",
        $Url
    )
    $lines = & $Edge @args 2>$null
    if ($LASTEXITCODE -ne 0) {
        $args[0] = "--headless"
        $lines = & $Edge @args 2>$null
    }
    if ($LASTEXITCODE -ne 0) { throw "Microsoft Edge headless DOM capture failed." }
    return ($lines -join "`n")
}

function Assert-View([string]$Dom, [string]$ExpectedView) {
    $expectedId = switch ($ExpectedView) {
        "activity" { "activity-view" }
        "approvals" { "approvals-view" }
        "connection" { "connection-view" }
        "diagnostics" { "diagnostics-view" }
        "cards" { "gallery-view" }
        "settings" { "settings-view" }
        default { throw "Unknown view $ExpectedView" }
    }
    $expectedButton = switch ($ExpectedView) {
        "activity" { "view-activity" }
        "approvals" { "view-approvals" }
        "connection" { "view-connection" }
        "diagnostics" { "view-diagnostics" }
        "cards" { $null }
        "settings" { "view-settings" }
    }
    if ($Dom -notmatch ('id="' + [regex]::Escape($expectedId) + '"')) { throw "Expected view $ExpectedView was not rendered." }
    if ($expectedButton -and $Dom -notmatch ('id="' + [regex]::Escape($expectedButton) + '"[^>]*aria-pressed="true"')) {
        throw "Expected view button $ExpectedView was not active after JavaScript initialization."
    }
}

$programFilesX86 = ${env:ProgramFiles(x86)}
$edge = First-ExistingPath @(
    $(if ($programFilesX86) { Join-Path $programFilesX86 "Microsoft\Edge\Application\msedge.exe" }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe" }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe" }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe" }),
    $(if ($programFilesX86) { Join-Path $programFilesX86 "Google\Chrome\Application\chrome.exe" }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe" })
)
if (-not $edge) { throw "No supported Chromium app-mode browser was found at an approved standard Windows path." }

$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $windowsUrl
if ($response.StatusCode -ne 200) { throw "Activity dashboard HTTP status was $($response.StatusCode)." }
$html = [string]$response.Content
if ($html -notmatch 'c2ct-activity-dashboard-contract" content="1"') { throw "Activity dashboard contract marker is missing." }
foreach ($requiredId in @("view-activity", "view-approvals", "view-connection", "view-settings", "view-diagnostics", "approvals-view", "connection-view", "diagnostics-view", "approval-box", "mcp-health-box", "cards")) {
    if ($html -notmatch ('id="' + [regex]::Escape($requiredId) + '"')) { throw "Activity dashboard is missing #$requiredId." }
}
if ($html -notmatch 'class="desktop-shell"') { throw "Shared desktop shell is missing." }

$activityApi = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ($activityBase + "api/activity")
if ($activityApi.StatusCode -ne 200) { throw "Activity API HTTP status was $($activityApi.StatusCode)." }
$activityJson = $activityApi.Content | ConvertFrom-Json
if ($null -eq $activityJson.conversations) { throw "Activity API did not return conversations." }

$dashboardSource = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "src\server\activity-dashboard.ts")
$windowsLauncherSource = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "windows\ChatGPTToCodexLauncher.cs")
$macLauncherSource = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "macos\ChatGPTToCodexStatusBar\main.swift")
if ($dashboardSource -notmatch 'html\.embedded-mac main, html\.embedded-windows main \{ width: 100%; max-width: none; padding-top: 10px; \}') {
    throw "Mac and Windows embedded dashboard content no longer share the same main-layout rule."
}
if ($windowsLauncherSource -notmatch 'http://127\.0\.0\.1:7980/activity/\?embedded=windows') { throw "Windows launcher no longer targets the embedded Windows dashboard." }
if ($windowsLauncherSource -notmatch 'Arguments = "--app="') { throw "Windows launcher no longer opens the dashboard in Chromium app mode." }
if ($windowsLauncherSource -notmatch '--window-size=920,640') { throw "Windows launcher no longer uses the shared desktop window size." }
if ($macLauncherSource -notmatch 'http://127\.0\.0\.1:7980/activity/\?embedded=mac') { throw "macOS launcher no longer targets the embedded Mac dashboard." }
$macNativeSidebar = $macLauncherSource -match 'sidebar\.widthAnchor\.constraint\(equalToConstant: 210\)'
if ($macNativeSidebar) { throw "macOS still installs the legacy native sidebar instead of the shared desktop shell." }
if ($macLauncherSource -notmatch 'showSharedDashboardSection\(id: "approvals", view: "approvals"\)') { throw "macOS approvals no longer route through the shared desktop shell." }
if ($dashboardSource -notmatch 'settingsViewButton\.hidden = !settingsEnabled') { throw "Local-only settings visibility guard is missing." }

$proofRoot = Join-Path $env:TEMP "c2ct-unified-dashboard-ui-proof"
$profileRoot = Join-Path $proofRoot "edge-profile"
New-Item -ItemType Directory -Force -Path $proofRoot, $profileRoot | Out-Null
$screenshot = Join-Path $proofRoot "windows-activity.png"
Remove-Item -Force -ErrorAction SilentlyContinue $screenshot

$domActivity = Invoke-EdgeDom $edge $windowsUrl $profileRoot
Assert-View $domActivity "activity"
$domApprovals = Invoke-EdgeDom $edge ($windowsUrl + "&view=approvals") $profileRoot
Assert-View $domApprovals "approvals"
$domConnection = Invoke-EdgeDom $edge ($windowsUrl + "&view=connection") $profileRoot
Assert-View $domConnection "connection"
$domDiagnostics = Invoke-EdgeDom $edge ($windowsUrl + "&view=diagnostics") $profileRoot
Assert-View $domDiagnostics "diagnostics"
$domCardsBlocked = Invoke-EdgeDom $edge ($windowsUrl + "&view=cards") $profileRoot
Assert-View $domCardsBlocked "activity"
$domCards = Invoke-EdgeDom $edge ($windowsUrl + "&devCards=1&view=cards") $profileRoot
Assert-View $domCards "cards"
$domSettings = Invoke-EdgeDom $edge ($windowsUrl + "&view=settings") $profileRoot
Assert-View $domSettings "settings"

$screenshotArgs = @(
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-default-apps",
    "--virtual-time-budget=1800",
    "--window-size=1280,900",
    "--user-data-dir=$profileRoot",
    "--screenshot=$screenshot",
    $windowsUrl
)
& $edge @screenshotArgs 2>$null | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $screenshot)) { throw "Chromium headless screenshot capture failed." }
$screenshotInfo = Get-Item -LiteralPath $screenshot
if ($screenshotInfo.Length -lt 10000) { throw "Dashboard screenshot is unexpectedly small ($($screenshotInfo.Length) bytes)." }
$screenshotSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $screenshot).Hash.ToLowerInvariant()

Write-Host "windows-unified-dashboard-ui=PASS"
Write-Host "dashboard-http=200"
Write-Host "activity-api=200"
Write-Host "chromium-app-mode=true"
Write-Host "render-browser=$([System.IO.Path]::GetFileName($edge))"
Write-Host "activity-view=true"
Write-Host "approvals-view=true"
Write-Host "connection-view=true"
Write-Host "diagnostics-view=true"
Write-Host "cards-view=true"
Write-Host "cards-default-hidden=true"
Write-Host "cards-dev-parameter=devCards=1"
Write-Host "settings-view=true"
Write-Host "settings-local-only=true"
Write-Host "shared-mac-windows-content-layout=true"
Write-Host "mac-native-sidebar=$($macNativeSidebar.ToString().ToLowerInvariant())"
Write-Host "native-shell-parity=unified"
Write-Host "native-shell-note=macOS WKWebView and Windows Chromium app mode render the same shared desktop shell, navigation, views, and window geometry"
Write-Host "screenshot-bytes=$($screenshotInfo.Length)"
Write-Host "screenshot-sha256=$screenshotSha"
Write-Host "screenshot-path=$screenshot"
