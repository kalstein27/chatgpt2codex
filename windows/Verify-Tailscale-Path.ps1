$ErrorActionPreference = "Stop"

$resolverPath = Join-Path $PSScriptRoot "Tailscale-Path.ps1"
if (-not (Test-Path -LiteralPath $resolverPath -PathType Leaf)) { throw "Tailscale resolver script is missing." }
. $resolverPath

$quoted = Get-ExecutablePathFromCommandLine '"C:\Program Files\Tailscale\tailscaled.exe" --cleanup'
if ($quoted -ne 'C:\Program Files\Tailscale\tailscaled.exe') { throw "Quoted service command parsing failed: $quoted" }
$plain = Get-ExecutablePathFromCommandLine 'C:\Tailscale\tailscaled.exe --cleanup'
if ($plain -ne 'C:\Tailscale\tailscaled.exe') { throw "Plain service command parsing failed: $plain" }

$result = Resolve-TailscaleCli
if (-not $result -or [string]::IsNullOrWhiteSpace([string]$result.Path)) { throw "Tailscale resolver did not return a path." }
if (-not (Test-Path -LiteralPath $result.Path -PathType Leaf)) { throw "Resolved Tailscale CLI does not exist: $($result.Path)" }
if ((Split-Path -Leaf $result.Path) -ine "tailscale.exe") { throw "Resolved executable is not tailscale.exe: $($result.Path)" }

$versionOutput = (& $result.Path version 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Resolved Tailscale CLI failed to run: $versionOutput" }
$versionLine = (($versionOutput -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
if ([string]::IsNullOrWhiteSpace($versionLine)) { throw "Tailscale version output was empty." }

Write-Host "tailscale-path-resolver=PASS"
Write-Host "tailscale-path=$($result.Path)"
Write-Host "tailscale-source=$($result.Source)"
Write-Host "tailscale-version=$versionLine"
