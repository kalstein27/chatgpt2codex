$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

function Assert-Contains([string]$Text, [string]$Marker, [string]$Label) {
    if ($Text.IndexOf($Marker, [System.StringComparison]::Ordinal) -lt 0) {
        throw "$Label is missing required marker: $Marker"
    }
}

$launcherPath = (Resolve-Path -LiteralPath "windows\ChatGPTToCodexLauncher.cs").Path
$localControlPath = (Resolve-Path -LiteralPath "src\server\local-control.ts").Path
$launcher = Get-Content -Raw -LiteralPath $launcherPath
$localControl = Get-Content -Raw -LiteralPath $localControlPath

$launcherMarkers = @(
    'public LocalOAuthApprovalsInfo oauthApprovals',
    'ApplyOAuthApprovals(snapshot);',
    'private void PresentOAuthApproval(LocalPendingOAuthApproval request)',
    'MessageBoxButtons.YesNoCancel',
    'ResolveOAuthApproval(request, "approve")',
    'ResolveOAuthApproval(request, "reject")',
    '"/oauth-approvals/" + Uri.EscapeDataString(request.requestId)',
    'pendingOAuthApprovalsMenu'
)
foreach ($marker in $launcherMarkers) {
    Assert-Contains $launcher $marker "Windows launcher OAuth approval wiring"
}

$serverMarkers = @(
    'oauthApprovals: {',
    'pendingRequests: pendingOAuthApprovals',
    '${base}/oauth-approvals/:requestId/${decision}',
    'resolveLocalApproval(requestId, decision)'
)
foreach ($marker in $serverMarkers) {
    Assert-Contains $localControl $marker "Local-control OAuth approval wiring"
}

Write-Host "windows-oauth-approval-wiring=PASS"
Write-Host "launcher-pending-approval-model=true"
Write-Host "launcher-approval-dialog=true"
Write-Host "launcher-approve-reject=true"
Write-Host "server-pending-status=true"
Write-Host "server-approve-reject-endpoint=true"
