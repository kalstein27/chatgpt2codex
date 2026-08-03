$ErrorActionPreference = "Stop"

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $user = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH = "$machine;$user;$env:PATH"
}

function Ensure-Command([string]$Command, [string]$WingetId) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        return
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Missing $Command and winget is not available. Install $Command manually, then run ChatGPT To Codex again."
    }
    Write-Host "[chatgpt2codex] installing $Command via winget..."
    winget install --exact --source winget --id $WingetId --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget failed to install $Command (exit code $LASTEXITCODE). Install it manually, then run ChatGPT To Codex again."
    }
    Refresh-Path
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Command was installed but is not on PATH yet. Open a new PowerShell window and run ChatGPT To Codex again."
    }
}

Ensure-Command node "OpenJS.NodeJS.LTS"
Ensure-Command cloudflared "Cloudflare.cloudflared"
