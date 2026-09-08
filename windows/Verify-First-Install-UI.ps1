$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class C2ctWin32TestUi {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    private const uint BM_CLICK = 0x00F5;

    private static string TextOf(IntPtr hWnd) {
        var sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
    private static string ClassOf(IntPtr hWnd) {
        var sb = new StringBuilder(256);
        GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
    public static IntPtr FindGenerateButton(IntPtr parent) {
        IntPtr found = IntPtr.Zero;
        int buttonCount = 0;
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr _) {
            var className = ClassOf(hWnd);
            if (className.IndexOf("BUTTON", StringComparison.OrdinalIgnoreCase) >= 0) {
                buttonCount++;
                found = hWnd;
            }
            return true;
        }, IntPtr.Zero);
        return buttonCount >= 5 ? found : IntPtr.Zero;
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
    public static void Click(IntPtr button) {
        SendMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }
}
"@

$tempRoot = Join-Path $env:TEMP ("c2ct-first-install-ui-" + [guid]::NewGuid().ToString("N"))
$stateDir = Join-Path $tempRoot "state"
$workspace = Join-Path $tempRoot "workspace"
$profile = Join-Path $tempRoot "profile"
$localAppData = Join-Path $tempRoot "localappdata"
$appData = Join-Path $tempRoot "appdata"
New-Item -ItemType Directory -Force -Path $stateDir, $workspace, $profile, $localAppData, $appData | Out-Null
$previousLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $localAppData

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$cscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw "Microsoft .NET Framework csc.exe was not found." }

$launcherSource = (Resolve-Path "windows\ChatGPTToCodexLauncher.cs").Path
$launcherSourceText = Get-Content -Raw -LiteralPath $launcherSource
$oauthWiringMarkers = @(
    'public LocalOAuthApprovalsInfo oauthApprovals',
    'ApplyOAuthApprovals(snapshot);',
    '"/oauth-approvals/" + Uri.EscapeDataString(request.requestId)',
    'pendingOAuthApprovalsMenu'
)
foreach ($marker in $oauthWiringMarkers) {
    if ($launcherSourceText.IndexOf($marker, [System.StringComparison]::Ordinal) -lt 0) {
        throw "Windows OAuth local-approval UI wiring is missing marker: $marker"
    }
}
$icon = (Resolve-Path "assets\chatgpt2codex-icon.ico").Path
$launcher = Join-Path $repoRoot "ChatGPT To Codex.e2e.exe"
Remove-Item -Force -ErrorAction SilentlyContinue $launcher
& $csc /nologo /target:winexe "/win32icon:$icon" /reference:System.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$launcher" $launcherSource
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed with exit code $LASTEXITCODE." }

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $launcher
$psi.WorkingDirectory = $repoRoot
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["USERPROFILE"] = $profile
$psi.EnvironmentVariables["HOME"] = $profile
$psi.EnvironmentVariables["LOCALAPPDATA"] = $localAppData
$psi.EnvironmentVariables["APPDATA"] = $appData
$psi.EnvironmentVariables["CHATGPT2CODEX_STATE_DIR"] = $stateDir
$psi.EnvironmentVariables["CHATGPT2CODEX_WORKSPACE"] = $workspace
$psi.EnvironmentVariables["WORKSPACE"] = $workspace
$psi.EnvironmentVariables["CHATGPT2CODEX_TUNNEL_MODE"] = "loopback"
$psi.EnvironmentVariables["PORT"] = "$port"
$psi.EnvironmentVariables["CHATGPT2CODEX_PORT"] = "$port"

$proc = [System.Diagnostics.Process]::Start($psi)
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200
        $proc.Refresh()
        if ($proc.HasExited) { throw "Launcher exited before its window appeared (exit $($proc.ExitCode))." }
    } while ($proc.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($proc.MainWindowHandle -eq 0) { throw "Launcher window did not appear." }

    $button = [IntPtr]::Zero
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $button = [C2ctWin32TestUi]::FindGenerateButton($proc.MainWindowHandle)
        if ($button -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($button -eq [IntPtr]::Zero) {
        $children = [C2ctWin32TestUi]::DescribeChildren($proc.MainWindowHandle)
        throw "Auto-generate Token button not found. Child windows: $children"
    }

    [C2ctWin32TestUi]::Click($button)

    $tokenPath = Join-Path $stateDir "owner-token.json"
    $healthUrl = "http://127.0.0.1:$port/healthz"
    $tokenCreated = $false
    $healthOk = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    do {
        if (Test-Path -LiteralPath $tokenPath) { $tokenCreated = $true }
        if ($tokenCreated) {
            try {
                $health = Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 -Uri $healthUrl
                if ($health.ok) { $healthOk = $true }
            } catch {}
        }
        if ($tokenCreated -and $healthOk) { break }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)

    if (-not $tokenCreated) { throw "Owner token file was not created in isolated state dir." }
    $tokenDoc = Get-Content -Raw -LiteralPath $tokenPath | ConvertFrom-Json
    if (-not $tokenDoc.tokenHash) { throw "Owner token state file does not contain tokenHash." }
    if ($tokenDoc.PSObject.Properties.Name -contains "ownerToken") { throw "Plaintext owner token was persisted unexpectedly." }
    if (-not $healthOk) {
        $diagLogDir = Join-Path $localAppData "ChatGPT To Codex\logs"
        $diagLog = if (Test-Path -LiteralPath $diagLogDir) {
            Get-ChildItem -LiteralPath $diagLogDir -Filter "launcher-*.log" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        }
        $diagText = if ($diagLog) {
            ((Get-Content -LiteralPath $diagLog.FullName -Tail 80) -join "`n")
        } else {
            "<no launcher log found>"
        }
        throw "MCP runtime did not become healthy on isolated port $port after token generation.`nLauncher tail:`n$diagText"
    }

    $logDir = Join-Path $localAppData "ChatGPT To Codex\logs"
    $recentLog = $null
    if (Test-Path -LiteralPath $logDir) {
        $recentLog = Get-ChildItem -LiteralPath $logDir -Filter "launcher-*.log" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    }
    if ($recentLog) {
        $logText = Get-Content -Raw -LiteralPath $recentLog.FullName
        if ($logText -match '(?m)^\s{2}[A-Za-z0-9_-]{40,}\s*$') {
            throw "Launcher log appears to contain a plaintext owner token."
        }
        if ($logText -notmatch 'Owner token generated\. Restarting MCP runtime') {
            throw "Launcher log does not contain the expected post-generation restart marker."
        }
    } else {
        throw "Isolated launcher log was not created."
    }

    Write-Host "first-install-owner-token-ui=PASS"
    Write-Host "button-invoked=true"
    Write-Host "token-file-created=true"
    Write-Host "token-hash-only=true"
    Write-Host "runtime-health=true"
    Write-Host "plaintext-token-log=false"
    Write-Host "oauth-local-approval-ui-wired=true"
    Write-Host "isolated-port=$port"
}
finally {
    try { if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch {}
    Start-Sleep -Milliseconds 300
    try {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($connection in $connections) {
            if ($connection.OwningProcess) { Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue }
        }
    } catch {}
    Remove-Item -Force -ErrorAction SilentlyContinue $launcher
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tempRoot
    if ([string]::IsNullOrEmpty($previousLocalAppData)) {
        Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue
    } else {
        $env:LOCALAPPDATA = $previousLocalAppData
    }
}
