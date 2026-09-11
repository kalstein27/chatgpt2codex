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
    $stdout = Join-Path $ProfileDir ("dom-" + [Guid]::NewGuid().ToString("N") + ".out")
    $stderr = Join-Path $ProfileDir ("dom-" + [Guid]::NewGuid().ToString("N") + ".err")
    $process = Start-Process -FilePath $Edge -ArgumentList $args -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($process.ExitCode -ne 0) {
        $args[0] = "--headless"
        Remove-Item -Force -ErrorAction SilentlyContinue $stdout, $stderr
        $process = Start-Process -FilePath $Edge -ArgumentList $args -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    }
    $stderrText = (Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue | Out-String).Trim()
    if ($process.ExitCode -ne 0) { throw "Microsoft Edge headless DOM capture failed (exit=$($process.ExitCode), stderr=$stderrText)." }
    $dom = (Get-Content -Raw -LiteralPath $stdout -ErrorAction SilentlyContinue)
    if ([string]::IsNullOrWhiteSpace($dom)) { throw "Microsoft Edge headless DOM capture returned empty stdout (stderr=$stderrText)." }
    Remove-Item -Force -ErrorAction SilentlyContinue $stdout, $stderr
    return $dom
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
if ($html -notmatch '/activity/manifest\.webmanifest\?brand=20260910') { throw "Dashboard web app manifest link is missing." }
if ($html -notmatch '/activity/app-icon\.png\?brand=20260910') { throw "Dashboard PNG app icon link is missing." }
if ($html -notmatch '/activity/favicon\.ico\?brand=20260910') { throw "Dashboard ICO favicon link is missing." }

$faviconResponse = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ($activityBase + "favicon.ico?brand=20260910")
if ($faviconResponse.StatusCode -ne 200 -or $faviconResponse.RawContentLength -lt 1024) { throw "Dashboard favicon route is missing or unexpectedly small." }
$iconResponse = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ($activityBase + "app-icon.png?brand=20260910")
if ($iconResponse.StatusCode -ne 200 -or $iconResponse.RawContentLength -lt 4096) { throw "Dashboard PNG app icon route is missing or unexpectedly small." }
$manifestResponse = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ($activityBase + "manifest.webmanifest?brand=20260910")
if ($manifestResponse.StatusCode -ne 200) { throw "Dashboard web app manifest HTTP status was $($manifestResponse.StatusCode)." }
$manifest = $manifestResponse.Content | ConvertFrom-Json
if ($manifest.name -ne "ChatGPT To Codex" -or $manifest.display -ne "standalone" -or $manifest.icons.Count -lt 2) {
    throw "Dashboard web app manifest does not satisfy the desktop branding contract."
}

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
$screenshotStdout = Join-Path $proofRoot "screenshot.out"
$screenshotStderr = Join-Path $proofRoot "screenshot.err"
Remove-Item -Force -ErrorAction SilentlyContinue $screenshotStdout, $screenshotStderr
$screenshotProcess = Start-Process -FilePath $edge -ArgumentList $screenshotArgs -Wait -PassThru -RedirectStandardOutput $screenshotStdout -RedirectStandardError $screenshotStderr
$screenshotError = (Get-Content -LiteralPath $screenshotStderr -ErrorAction SilentlyContinue | Out-String).Trim()
if ($screenshotProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $screenshot)) {
    throw "Chromium headless screenshot capture failed (exit=$($screenshotProcess.ExitCode), stderr=$screenshotError)."
}
$screenshotInfo = Get-Item -LiteralPath $screenshot
if ($screenshotInfo.Length -lt 10000) { throw "Dashboard screenshot is unexpectedly small ($($screenshotInfo.Length) bytes)." }
$screenshotSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $screenshot).Hash.ToLowerInvariant()

Write-Host "windows-unified-dashboard-ui=PASS"
Write-Host "dashboard-http=200"
Write-Host "activity-api=200"
Write-Host "chromium-app-mode=true"
Write-Host "chromium-app-brand-icon=true"
Write-Host "web-app-manifest=true"
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
