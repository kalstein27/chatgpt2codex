$ErrorActionPreference = "Stop"

function Get-ExecutablePathFromCommandLine([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
    $expanded = [Environment]::ExpandEnvironmentVariables($CommandLine.Trim())
    if ($expanded.StartsWith('"')) {
        $match = [regex]::Match($expanded, '^"([^\"]+\.exe)"', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($match.Success) { return $match.Groups[1].Value }
        return $null
    }
    $match = [regex]::Match($expanded, '^([^\s]+\.exe)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) { return $match.Groups[1].Value }
    return $null
}

function Add-TailscaleCandidate($Candidates, [string]$CandidatePath, [string]$Source) {
    if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return }
    $expanded = [Environment]::ExpandEnvironmentVariables($CandidatePath.Trim().Trim('"'))
    if ([string]::IsNullOrWhiteSpace($expanded)) { return }
    if ((Split-Path -Leaf $expanded) -ine "tailscale.exe") {
        $expanded = Join-Path $expanded "tailscale.exe"
    }
    foreach ($existing in $Candidates) {
        if ([string]::Equals([string]$existing.Path, $expanded, [StringComparison]::OrdinalIgnoreCase)) { return }
    }
    $Candidates.Add([pscustomobject]@{ Path = $expanded; Source = $Source }) | Out-Null
}

function Add-TailscaleRegistryAppPath($Candidates, [string]$RegistryPath, [string]$Source) {
    try {
        $key = Get-Item -LiteralPath $RegistryPath -ErrorAction Stop
        Add-TailscaleCandidate $Candidates ([string]$key.GetValue("")) $Source
        $registeredPath = [string]$key.GetValue("Path")
        if (-not [string]::IsNullOrWhiteSpace($registeredPath)) {
            Add-TailscaleCandidate $Candidates $registeredPath ($Source + "-path")
        }
    } catch { }
}

function Add-TailscaleUninstallCandidates($Candidates, [string]$RegistryRoot, [string]$Source) {
    if (-not (Test-Path -LiteralPath $RegistryRoot)) { return }
    foreach ($subKey in @(Get-ChildItem -LiteralPath $RegistryRoot -ErrorAction SilentlyContinue)) {
        try {
            $displayName = [string]$subKey.GetValue("DisplayName")
            if ($displayName -notmatch '^(?i:Tailscale)(?:\s|$)') { continue }
            $installLocation = [string]$subKey.GetValue("InstallLocation")
            if (-not [string]::IsNullOrWhiteSpace($installLocation)) {
                Add-TailscaleCandidate $Candidates $installLocation ($Source + "-install-location")
            }
            $displayIcon = [string]$subKey.GetValue("DisplayIcon")
            if (-not [string]::IsNullOrWhiteSpace($displayIcon)) {
                $iconExecutable = Get-ExecutablePathFromCommandLine $displayIcon
                if ($iconExecutable) {
                    if ((Split-Path -Leaf $iconExecutable) -ieq "tailscale.exe") {
                        Add-TailscaleCandidate $Candidates $iconExecutable ($Source + "-display-icon")
                    } else {
                        Add-TailscaleCandidate $Candidates (Split-Path -Parent $iconExecutable) ($Source + "-display-icon-sibling")
                    }
                }
            }
        } catch { }
    }
}

function Add-TailscaleServiceCandidate($Candidates, [string]$ServiceName) {
    $registryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
    try {
        $key = Get-Item -LiteralPath $registryPath -ErrorAction Stop
        $imagePath = [string]$key.GetValue("ImagePath")
        $serviceExecutable = Get-ExecutablePathFromCommandLine $imagePath
        if ($serviceExecutable) {
            Add-TailscaleCandidate $Candidates (Split-Path -Parent $serviceExecutable) ("service-" + $ServiceName)
        }
    } catch { }
}

function Resolve-TailscaleCli {
    $candidates = New-Object 'System.Collections.Generic.List[object]'

    # Prefer Windows machine-wide registration when available.
    Add-TailscaleRegistryAppPath $candidates "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\tailscale.exe" "hklm-app-paths"
    Add-TailscaleUninstallCandidates $candidates "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" "hklm-uninstall"
    Add-TailscaleUninstallCandidates $candidates "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" "hklm-wow6432-uninstall"

    # Tailscale's documented MSI default is under Program Files, but INSTALLDIR can be customized.
    if ($env:ProgramFiles) { Add-TailscaleCandidate $candidates (Join-Path $env:ProgramFiles "Tailscale") "program-files-default" }
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if ($programFilesX86) { Add-TailscaleCandidate $candidates (Join-Path $programFilesX86 "Tailscale") "program-files-x86-default" }

    # A custom installer location can still be inferred from the registered Windows service.
    foreach ($serviceName in @("Tailscale", "TailscaleTunnel", "TailscaleService")) {
        Add-TailscaleServiceCandidate $candidates $serviceName
    }

    # Per-user registration/install locations are valid fallbacks.
    Add-TailscaleRegistryAppPath $candidates "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\tailscale.exe" "hkcu-app-paths"
    Add-TailscaleUninstallCandidates $candidates "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" "hkcu-uninstall"
    if ($env:LOCALAPPDATA) {
        Add-TailscaleCandidate $candidates (Join-Path $env:LOCALAPPDATA "Programs\Tailscale") "localappdata-programs"
        Add-TailscaleCandidate $candidates (Join-Path $env:LOCALAPPDATA "Tailscale") "localappdata-direct"
        Add-TailscaleCandidate $candidates (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\tailscale.exe") "winget-link"
        Add-TailscaleCandidate $candidates (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\tailscale.exe") "windows-app-execution-alias"
    }

    # PATH is last so a user-writable shim does not override registered/system installs.
    foreach ($command in @(Get-Command tailscale.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $commandPath = if ($command.Path) { [string]$command.Path } else { [string]$command.Source }
        Add-TailscaleCandidate $candidates $commandPath "path"
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate.Path -PathType Leaf) {
            try {
                $resolved = (Resolve-Path -LiteralPath $candidate.Path -ErrorAction Stop).Path
            } catch {
                $resolved = [string]$candidate.Path
            }
            if ((Split-Path -Leaf $resolved) -ieq "tailscale.exe") {
                return [pscustomobject]@{
                    Path = $resolved
                    Source = [string]$candidate.Source
                }
            }
        }
    }

    throw "Tailscale CLI was not found via Windows App Paths, installer registration, Program Files, service registration, per-user install locations, or PATH."
}
