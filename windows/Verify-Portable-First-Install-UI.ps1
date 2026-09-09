param(
    [string]$OutputRoot = "build\windows-portable"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class C2ctPortableFirstInstallUi {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    private const int WM_GETTEXT = 0x000D;
    private const int WM_GETTEXTLENGTH = 0x000E;
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "SendMessage", CharSet = CharSet.Auto)] private static extern IntPtr SendMessageLength(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "SendMessage", CharSet = CharSet.Auto)] private static extern IntPtr SendMessageText(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    private static string TextOf(IntPtr hWnd) {
        var length = (int)SendMessageLength(hWnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero).ToInt64();
        var sb = new StringBuilder(Math.Max(512, length + 1));
        SendMessageText(hWnd, WM_GETTEXT, (IntPtr)sb.Capacity, sb);
        return sb.ToString();
    }
    private static string ClassOf(IntPtr hWnd) {
        var sb = new StringBuilder(256);
        GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
    public static int CountClass(IntPtr parent, string needle) {
        int count = 0;
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr _) {
            var className = ClassOf(hWnd);
            if (className.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) count++;
            return true;
        }, IntPtr.Zero);
        return count;
    }
    public static string FirstTextForClass(IntPtr parent, string needle) {
        string found = "";
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr _) {
            if (found.Length > 0) return true;
            if (ClassOf(hWnd).IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) found = TextOf(hWnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static string DescribeChildren(IntPtr parent) {
        var sb = new StringBuilder();
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr _) {
            var text = TextOf(hWnd);
            if (!string.IsNullOrWhiteSpace(text)) {
                if (sb.Length > 0) sb.Append(" | ");
                sb.Append(ClassOf(hWnd)).Append(":").Append(text.Replace("\r", " ").Replace("\n", " "));
            }
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }
}
"@

function Get-FreePort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function Wait-LauncherWindow([System.Diagnostics.Process]$Process, [int]$Seconds = 20) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        Start-Sleep -Milliseconds 200
        $Process.Refresh()
        if ($Process.HasExited) { throw "Portable launcher exited before its window appeared (exit $($Process.ExitCode))." }
    } while ($Process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($Process.MainWindowHandle -eq 0) { throw "Portable launcher window did not appear." }
}

function Wait-Health([int]$Port, [int]$Seconds = 40) {
    $url = "http://127.0.0.1:$Port/healthz"
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        try {
            $health = Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 -Uri $url
            if ($health.ok) { return $health }
        } catch {}
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Portable runtime did not become healthy on port $Port."
}

function Get-ListenerEvidence([int]$Port, [string]$ExpectedNode) {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($connections.Count -ne 1) { throw "Expected exactly one listener on port $Port, found $($connections.Count)." }
    $pidValue = [int]$connections[0].OwningProcess
    $process = Get-Process -Id $pidValue -ErrorAction Stop
    $actualPath = [System.IO.Path]::GetFullPath($process.Path)
    $expectedPath = [System.IO.Path]::GetFullPath($ExpectedNode)
    if (-not [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Listener is not using bundled Node. Expected $expectedPath, got $actualPath"
    }
    return [pscustomobject]@{ Pid = $pidValue; Path = $actualPath }
}

function Stop-LauncherTree([System.Diagnostics.Process]$Process, [int]$Port) {
    try {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            & taskkill.exe /pid $Process.Id /t /f 2>$null | Out-Null
        }
    } catch {}
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess) { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Milliseconds 500
    $remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($remaining.Count -ne 0) { throw "Listener on port $Port remained after launcher tree shutdown." }
}

$sourceNode = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $sourceNode) { throw "Source-test Node.js is unavailable. Run this verifier from a configured source-development environment." }
$expectedArch = (& $sourceNode.Source -p "process.arch").Trim()
if (-not $expectedArch) { throw "Could not determine source-test Node architecture." }
$bundleName = "chatgpt2codex-windows-$expectedArch"
$outputBase = if ([System.IO.Path]::IsPathRooted($OutputRoot)) { [System.IO.Path]::GetFullPath($OutputRoot) } else { [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot)) }
$zip = Join-Path $outputBase ($bundleName + ".zip")
if (-not (Test-Path -LiteralPath $zip)) { throw "Portable $expectedArch ZIP is missing at $zip. Run npm run build:windows-portable first." }
$zipSha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$tempRoot = Join-Path $env:TEMP ("c2ct-portable-first-install-" + [guid]::NewGuid().ToString("N"))
$extractRoot = Join-Path $tempRoot "extract"
$profile = Join-Path $tempRoot "profile"
$localAppData = Join-Path $tempRoot "localappdata"
$appData = Join-Path $tempRoot "appdata"
$stateDir = Join-Path $tempRoot "state"
$workspace = Join-Path $tempRoot "workspace"
$moduleCache = Join-Path $tempRoot "ps-module-cache"
New-Item -ItemType Directory -Force -Path $extractRoot, $profile, $localAppData, $appData, $stateDir, $workspace | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extractRoot)
$portableRoot = Join-Path $extractRoot $bundleName
$launcher = Join-Path $portableRoot "ChatGPT To Codex.exe"
$portableNode = Join-Path $portableRoot "runtime\node.exe"
$portableNpmCli = Join-Path $portableRoot "npm\bin\npm-cli.js"
$portableCli = Join-Path $portableRoot "dist\cli.js"
$manifestPath = Join-Path $portableRoot "portable-manifest.json"
foreach ($required in @($launcher, $portableNode, $portableNpmCli, $portableCli, $manifestPath, (Join-Path $portableRoot "start-chatgpt.ps1"))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Portable artifact is missing: $required" }
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.architecture -ne $expectedArch) { throw "Portable manifest architecture mismatch. Expected $expectedArch, got $($manifest.architecture)." }
$portableNodeVersion = (& $portableNode --version).Trim()
$portableNpmVersion = (& $portableNode $portableNpmCli --version).Trim()
if (-not $portableNpmVersion) { throw "Bundled portable npm CLI did not execute." }
if ([string]$manifest.npmVersion -ne $portableNpmVersion) { throw "Portable manifest npmVersion does not match bundled npm." }
$portableNpmSha256 = (Get-FileHash -LiteralPath $portableNpmCli -Algorithm SHA256).Hash.ToLowerInvariant()
if ([string]$manifest.npmCliSha256 -ne $portableNpmSha256) { throw "Portable manifest npmCliSha256 does not match bundled npm CLI." }
$port = Get-FreePort
$tokenPath = Join-Path $stateDir "owner-token.json"
$safePath = @(
    (Join-Path $env:WINDIR "System32"),
    $env:WINDIR,
    (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0"),
    (Join-Path $env:WINDIR "System32\Wbem")
) -join ";"
if (($safePath -split ';' | Where-Object { Test-Path -LiteralPath (Join-Path $_ "node.exe") }).Count -ne 0) {
    throw "Isolated child PATH unexpectedly contains node.exe."
}
if (($safePath -split ';' | Where-Object { Test-Path -LiteralPath (Join-Path $_ "npm.cmd") }).Count -ne 0) {
    throw "Isolated child PATH unexpectedly contains npm.cmd."
}

$previousStateDir = $env:CHATGPT2CODEX_STATE_DIR
$previousWorkspace = $env:CHATGPT2CODEX_WORKSPACE
$previousWorkspaceAlias = $env:WORKSPACE
try {
    $env:CHATGPT2CODEX_STATE_DIR = $stateDir
    $env:CHATGPT2CODEX_WORKSPACE = $workspace
    $env:WORKSPACE = $workspace
    $seedJsonText = ((& $portableNode $portableCli owner-token --generate --workspace $workspace) -join "`n")
    if ($LASTEXITCODE -ne 0) { throw "Bundled portable CLI failed to seed the isolated owner token." }
    $seedResult = $seedJsonText | ConvertFrom-Json
    if (-not $seedResult.ownerToken) { throw "Bundled portable CLI did not return an owner token while seeding isolated state." }
    $seedResult = $null
} finally {
    if ([string]::IsNullOrEmpty($previousStateDir)) { Remove-Item Env:CHATGPT2CODEX_STATE_DIR -ErrorAction SilentlyContinue } else { $env:CHATGPT2CODEX_STATE_DIR = $previousStateDir }
    if ([string]::IsNullOrEmpty($previousWorkspace)) { Remove-Item Env:CHATGPT2CODEX_WORKSPACE -ErrorAction SilentlyContinue } else { $env:CHATGPT2CODEX_WORKSPACE = $previousWorkspace }
    if ([string]::IsNullOrEmpty($previousWorkspaceAlias)) { Remove-Item Env:WORKSPACE -ErrorAction SilentlyContinue } else { $env:WORKSPACE = $previousWorkspaceAlias }
}
if (-not (Test-Path -LiteralPath $tokenPath)) { throw "Bundled portable CLI did not create owner-token.json in isolated state." }

function Start-IsolatedPortableLauncher([string]$Arguments) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $launcher
    $psi.Arguments = $Arguments
    $psi.WorkingDirectory = $portableRoot
    $psi.UseShellExecute = $false
    $psi.EnvironmentVariables["USERPROFILE"] = $profile
    $psi.EnvironmentVariables["HOME"] = $profile
    $psi.EnvironmentVariables["LOCALAPPDATA"] = $localAppData
    $psi.EnvironmentVariables["APPDATA"] = $appData
    $psi.EnvironmentVariables["CHATGPT2CODEX_STATE_DIR"] = $stateDir
    $psi.EnvironmentVariables["CHATGPT2CODEX_RUNTIME_ROOT"] = $portableRoot
    $psi.EnvironmentVariables["CHATGPT2CODEX_WORKSPACE"] = $workspace
    $psi.EnvironmentVariables["WORKSPACE"] = $workspace
    $psi.EnvironmentVariables["CHATGPT2CODEX_TUNNEL_MODE"] = "loopback"
    $psi.EnvironmentVariables["PORT"] = "$port"
    $psi.EnvironmentVariables["CHATGPT2CODEX_PORT"] = "$port"
    $psi.EnvironmentVariables["PATH"] = $safePath
    $psi.EnvironmentVariables["PSModuleAnalysisCachePath"] = $moduleCache
    return [System.Diagnostics.Process]::Start($psi)
}

$first = $null
$second = $null
try {
    $first = Start-IsolatedPortableLauncher "-NoTunnel"
    Wait-LauncherWindow $first
    $buttonCount = [C2ctPortableFirstInstallUi]::CountClass($first.MainWindowHandle, "BUTTON")
    $editCount = [C2ctPortableFirstInstallUi]::CountClass($first.MainWindowHandle, "EDIT")
    if ($buttonCount -ne 0) {
        throw "Portable cold-boot window exposed $buttonCount actionable button(s). Children: $([C2ctPortableFirstInstallUi]::DescribeChildren($first.MainWindowHandle))"
    }
    if ($editCount -lt 1) { throw "Portable cold-boot log box was not found." }
    if ($first.MainWindowTitle -notmatch 'Cold Boot') { throw "Unexpected portable cold-boot title: $($first.MainWindowTitle)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $coldBootText = ""
    do {
        $coldBootText = [C2ctPortableFirstInstallUi]::FirstTextForClass($first.MainWindowHandle, "EDIT")
        if ($coldBootText -match 'Cold boot console') { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($coldBootText -notmatch 'Cold boot console') { throw "Portable cold-boot log text was not visible." }

    $tokenDoc1 = Get-Content -Raw -LiteralPath $tokenPath | ConvertFrom-Json
    if (-not $tokenDoc1.tokenHash) { throw "Seeded token state has no tokenHash." }
    if ($tokenDoc1.PSObject.Properties.Name -contains "ownerToken") { throw "Seeded token state persisted plaintext ownerToken." }
    $tokenHash1 = [string]$tokenDoc1.tokenHash
    $health1 = Wait-Health $port
    $listener1 = Get-ListenerEvidence $port $portableNode

    # The cold-boot window is intentionally log-only. Connector/status controls
    # live in the tray/dashboard/settings surfaces and must not be required here.
    $firstUi = [C2ctPortableFirstInstallUi]::DescribeChildren($first.MainWindowHandle)

    $logDir = Join-Path $localAppData "ChatGPT To Codex\logs"
    $firstLog = Get-ChildItem -LiteralPath $logDir -Filter "launcher-*.log" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $firstLog) { throw "First-run launcher log was not created." }
    $firstLogText = Get-Content -Raw -LiteralPath $firstLog.FullName
    if ($firstLogText -match '(?m)^\s{2}[A-Za-z0-9_-]{40,}\s*$') { throw "First-run launcher log contains a plaintext owner token." }
    if ($firstLogText -notmatch 'owner token already set') { throw "First-run log lacks configured owner-token evidence." }

    Stop-LauncherTree $first $port
    $first = $null
    if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -ne 0) { throw "Port remained busy after first launcher shutdown." }

    $second = Start-IsolatedPortableLauncher "-NoTunnel"
    Wait-LauncherWindow $second
    $secondButtonCount = [C2ctPortableFirstInstallUi]::CountClass($second.MainWindowHandle, "BUTTON")
    if ($secondButtonCount -ne 0) { throw "Restarted portable cold-boot window exposed actionable buttons." }
    $health2 = Wait-Health $port
    $listener2 = Get-ListenerEvidence $port $portableNode
    $tokenDoc2 = Get-Content -Raw -LiteralPath $tokenPath | ConvertFrom-Json
    if ([string]$tokenDoc2.tokenHash -ne $tokenHash1) { throw "Owner token hash changed across launcher restart." }
    if ($tokenDoc2.PSObject.Properties.Name -contains "ownerToken") { throw "Restarted token state persisted plaintext ownerToken." }

    $secondUi = [C2ctPortableFirstInstallUi]::DescribeChildren($second.MainWindowHandle)

    $secondLog = Get-ChildItem -LiteralPath $logDir -Filter "launcher-*.log" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $secondLog) { throw "Restarted launcher log was not created." }
    $secondLogText = Get-Content -Raw -LiteralPath $secondLog.FullName
    if ($secondLogText -match '(?m)^\s{2}[A-Za-z0-9_-]{40,}\s*$') { throw "Restarted launcher log contains a plaintext owner token." }
    if ($secondLogText -notmatch 'owner token already set') { throw "Restarted launcher log lacks configured owner-token evidence." }

    Write-Host "portable-first-install-ui=PASS"
    Write-Host "portable-arch=$($manifest.architecture)"
    Write-Host "portable-node-version=$portableNodeVersion"
    Write-Host "portable-npm-version=$portableNpmVersion"
    Write-Host "portable-npm-cli-sha256=$portableNpmSha256"
    Write-Host "system-node-required=false"
    Write-Host "system-npm-required=false"
    Write-Host "bundled-node-first-run=true"
    Write-Host "bundled-npm-cli=true"
    Write-Host "owner-token-seeded-with-bundled-cli=true"
    Write-Host "passive-coldboot-ui=true"
    Write-Host "main-window-buttons=0"
    Write-Host "owner-token-hash-only=true"
    Write-Host "first-run-health=true"
    Write-Host "coldboot-connector-controls=false"
    Write-Host "shutdown-clears-listener=true"
    Write-Host "restart-health=true"
    Write-Host "restart-token-hash-preserved=true"
    Write-Host "restart-passive-coldboot-ui=true"
    Write-Host "bundled-node-restart=true"
    Write-Host "plaintext-token-log=false"
    Write-Host "portable-sha256=$zipSha256"
}
finally {
    if ($first) { try { Stop-LauncherTree $first $port } catch {} }
    if ($second) { try { Stop-LauncherTree $second $port } catch {} }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tempRoot
}
