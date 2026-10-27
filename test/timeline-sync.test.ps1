$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot '..\lib\smtc-bridge.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptFile, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
# Regression guard: [Environment]::TickCount64 does not exist in .NET Framework
# (Windows PowerShell 5.1) - it evaluates to $null, which silently turns every
# interval into 0 and disables the stall detection. v0.3.2 shipped that bug.
# Comment lines are stripped first: the source documents that very trap.
$raw = [System.IO.File]::ReadAllText($scriptFile)
$code = (($raw -split "`r?`n") | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
if ($code -match 'Environment\]::TickCount64') {
  throw 'TickCount64 is unavailable in .NET Framework; use a DateTimeOffset millisecond clock'
}
$fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-TimelineStalled' }, $true)
if ($null -eq $fn) { throw 'Test-TimelineStalled not found in smtc-bridge.ps1' }
. ([scriptblock]::Create($fn.Extent.Text))
$estFn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-EstimatedPosition' }, $true)
if ($null -eq $estFn) { throw 'Get-EstimatedPosition not found in smtc-bridge.ps1' }
. ([scriptblock]::Create($estFn.Extent.Text))

# A moving position proves the snapshot is live - forward playback or a wrap/seek.
if (Test-TimelineStalled -Playing $true -Position 42 -LastPosition 41 -UnchangedMs 60000) { throw 'Moving position must never count as stalled' }
if (Test-TimelineStalled -Playing $true -Position 3 -LastPosition 250 -UnchangedMs 60000) { throw 'Loop wrap / seek must not count as stalled' }

# A healthy QQ Music reports in 1.0-2.05 s steps, so ~1.5 s of an unchanged value
# is normal traffic and must not trigger a manager request.
if (Test-TimelineStalled -Playing $true -Position 42 -LastPosition 42 -UnchangedMs 1500) { throw 'Normal 1.5s reporting step must not count as stalled' }

# Past the window: stalled (the client's own 2 s extrapolation is about to run out).
if (-not (Test-TimelineStalled -Playing $true -Position 42 -LastPosition 42 -UnchangedMs 2200)) { throw '2200ms of no movement must be stalled' }
if (-not (Test-TimelineStalled -Playing $true -Position 42 -LastPosition 42 -UnchangedMs 9000)) { throw 'Long freeze must be stalled with the default window' }

# Paused playback is supposed to stand still - never refresh there.
if (Test-TimelineStalled -Playing $false -Position 42 -LastPosition 42 -UnchangedMs 60000) { throw 'Paused track must not trigger a refresh' }

# First sample: no previous value to compare against.
if (Test-TimelineStalled -Playing $true -Position 42 -LastPosition $null -UnchangedMs 60000) { throw 'First sample must not count as stalled' }

# Sub-threshold jitter (coarse reporting) still counts as frozen.
if (-not (Test-TimelineStalled -Playing $true -Position 42.01 -LastPosition 42.0 -UnchangedMs 3000)) { throw 'Jitter below 0.05s must count as frozen' }

# Above the movement threshold: live again.
if (Test-TimelineStalled -Playing $true -Position 42.5 -LastPosition 42.0 -UnchangedMs 3000) { throw 'Movement above 0.05s must clear the stall' }

# ---- local position clock for players that publish no timeline (KuGou) ----
$state = @{ key = $null; pos = 0.0; at = 0; playing = $false }
$p = Get-EstimatedPosition $state 'kugou|a|b|' $true 1000000
if ($p -ne 0) { throw 'A new track must start the local clock at 0' }
$p = Get-EstimatedPosition $state 'kugou|a|b|' $true 1002000
if ([Math]::Abs($p - 2.0) -gt 0.01) { throw "2s of playback must advance the clock by 2s (got $p)" }
$p = Get-EstimatedPosition $state 'kugou|a|b|' $false 1005000
if ([Math]::Abs($p - 2.0) -gt 0.01) { throw 'A paused sample must not advance the clock' }
$p = Get-EstimatedPosition $state 'kugou|a|b|' $true 1006000
if ([Math]::Abs($p - 2.0) -gt 0.01) { throw 'The paused gap must not be credited on resume' }
$p = Get-EstimatedPosition $state 'kugou|a|b|' $true 1007000
if ([Math]::Abs($p - 3.0) -gt 0.01) { throw 'Playback after resume continues from the held position' }
$p = Get-EstimatedPosition $state 'kugou|c|d|' $true 1008000
if ($p -ne 0) { throw 'A different track restarts the local clock' }
$p = Get-EstimatedPosition $state 'kugou|c|d|' $true 0
if ($p -ne 0) { throw 'A missing clock must not advance the position' }

Write-Output 'PASS: 9 Test-TimelineStalled cases + 7 local-clock cases (players with no timeline), .NET-Framework clock guard.'
