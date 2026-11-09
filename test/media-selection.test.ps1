$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot '..\lib\smtc-bridge.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptFile, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$select = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Select-Session' }, $true)
. ([scriptblock]::Create($select.Extent.Text))
$identified = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Select-IdentifiedSession' }, $true)
. ([scriptblock]::Create($identified.Extent.Text))
$patterns = @('cloudmusic','netease','com.netease','qqmusic')
function New-Media($id, $status) {
  $session = [pscustomobject]@{ SourceAppUserModelId=$id; TestStatus=$status }
  $session | Add-Member ScriptMethod GetPlaybackInfo { [pscustomobject]@{PlaybackStatus=$this.TestStatus} }
  return $session
}
$ncm = New-Media 'cloudmusic.exe' 'Paused'
$qq = New-Media 'QQMusic.exe' 'Playing'
$web = New-Media 'msedge.exe' 'Playing'
$chrome = New-Media 'Chrome' 'Playing'
$edgeStore = New-Media 'Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!MicrosoftEdge' 'Playing'
$other = New-Media 'Spotify.exe' 'Playing'
$webPaused = New-Media 'msedge.exe' 'Paused'
if ((Select-Session @($ncm,$qq)).SourceAppUserModelId -ne 'QQMusic.exe') { throw 'Paused NetEase stole QQ' }
if ((Select-Session @($web,$qq)).SourceAppUserModelId -ne 'QQMusic.exe') { throw 'Supported QQ should beat browser' }
if ((Select-Session @($ncm,$web)).SourceAppUserModelId -ne 'msedge.exe') { throw 'Playing fallback failed' }
$qq.TestStatus = 'Paused'
if ((Select-Session @($web,$qq)).SourceAppUserModelId -ne 'msedge.exe') { throw 'Paused QQ stole playing browser' }
if ($null -ne (Select-Session @())) { throw 'Empty sessions must return null' }
if ((Select-Session @($qq)).SourceAppUserModelId -ne 'QQMusic.exe') { throw 'Paused fallback failed' }
# browser tier: playing browser beats a playing non-music, non-browser app
if ((Select-Session @($other,$web)).SourceAppUserModelId -ne 'msedge.exe') { throw 'Playing browser should beat other playing' }
if ((Select-Session @($web,$other)).SourceAppUserModelId -ne 'msedge.exe') { throw 'Browser tier order-dependent' }
# Chrome bare AUMID and the Edge store AUMID both hit the browser fragments
if ((Select-Session @($other,$chrome)).SourceAppUserModelId -ne 'Chrome') { throw 'Chrome AUMID not detected' }
if ((Select-Session @($other,$edgeStore)).SourceAppUserModelId -ne $edgeStore.SourceAppUserModelId) { throw 'Edge store AUMID not detected' }
# a paused browser must not win over a playing other app, and must not beat a paused music client either? No: paused browser stays below paused music (preferredPaused tier above nothing - browser paused is simply ignored)
$web.TestStatus = 'Paused'
if ((Select-Session @($web,$other)).SourceAppUserModelId -ne 'Spotify.exe') { throw 'Paused browser stole playing other' }
if ((Select-Session @($web,$qq)).SourceAppUserModelId -ne 'QQMusic.exe') { throw 'Paused browser stole paused music' }
# user-added browser fragment in AppPattern ($patterns script var) makes the browser preferred (explicit opt-in)
$web.TestStatus = 'Playing'
$patterns = @('cloudmusic','netease','com.netease','qqmusic','msedge')
if ((Select-Session @($other,$web)).SourceAppUserModelId -ne 'msedge.exe') { throw 'User browser pattern not preferred' }
$patterns = @('cloudmusic','netease','com.netease','qqmusic')
Write-Output 'PASS: 12 Select-Session cases: music > playing browser > other playing > paused music; Chrome/Edge-store AUMIDs; explicit pattern opt-in.'

# ------------------------------------------------------------------------ #
# Select-IdentifiedSession: a session without media identity must never
# shadow one that has it (live 2026-11-09: a lingering Chrome/phantom session
# with an empty title was picked over a playing player, so the capsule showed
# "未知曲目" and - once identity-less states were masked - vanished).
$ghost = New-Media 'Chrome' 'Playing'                 # playing, but no title
$player = New-Media 'cloudmusic.exe' 'Paused'         # the real (paused) player
$video = New-Media 'msedge.exe' 'Playing'             # a real video session
$probeFor = {
  param($s)
  switch ($s.SourceAppUserModelId) {
    'Chrome' { '' }                       # identity-less phantom
    'cloudmusic.exe' { '海蛍' }
    'msedge.exe' { '某个视频_哔哩哔哩_bilibili' }
    default { '' }
  }
}
if ((Select-IdentifiedSession @($ghost, $player) $probeFor).SourceAppUserModelId -ne 'cloudmusic.exe') {
  throw 'An identity-less playing session shadowed a titled player'
}
if ((Select-IdentifiedSession @($ghost, $video) $probeFor).SourceAppUserModelId -ne 'msedge.exe') {
  throw 'An identity-less session shadowed a titled playing browser'
}
# all candidates identity-less -> plain preference still answers (never null)
if ((Select-IdentifiedSession @($ghost) $probeFor).SourceAppUserModelId -ne 'Chrome') {
  throw 'An identity-less-only list must still fall back to the plain selection'
}
# a titled top candidate wins immediately, in preference order
if ((Select-IdentifiedSession @($player, $video) $probeFor).SourceAppUserModelId -ne 'msedge.exe') {
  throw 'Preference order must hold among titled sessions'
}
if ($null -ne (Select-IdentifiedSession @() $probeFor)) { throw 'Empty session list must return null' }
Write-Output 'PASS: 5 Select-IdentifiedSession cases: identity-less sessions never shadow a titled player; identity-less-only lists fall back; empty list is null.'
