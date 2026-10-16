$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot '..\lib\smtc-bridge.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptFile, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$select = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Select-Session' }, $true)
. ([scriptblock]::Create($select.Extent.Text))
$patterns = @('cloudmusic','netease','com.netease','qqmusic')
function New-Media($id, $status) {
  $session = [pscustomobject]@{ SourceAppUserModelId=$id; TestStatus=$status }
  $session | Add-Member ScriptMethod GetPlaybackInfo { [pscustomobject]@{PlaybackStatus=$this.TestStatus} }
  return $session
}
$ncm = New-Media 'cloudmusic.exe' 'Paused'
$qq = New-Media 'QQMusic.exe' 'Playing'
$web = New-Media 'msedge.exe' 'Playing'
if ((Select-Session @($ncm,$qq)).SourceAppUserModelId -ne 'QQMusic.exe') { throw 'Paused NetEase stole QQ' }
if ((Select-Session @($web,$qq)).SourceAppUserModelId -ne 'QQMusic.exe') { throw 'Supported QQ should beat browser' }
if ((Select-Session @($ncm,$web)).SourceAppUserModelId -ne 'msedge.exe') { throw 'Playing fallback failed' }
$qq.TestStatus = 'Paused'
if ((Select-Session @($web,$qq)).SourceAppUserModelId -ne 'msedge.exe') { throw 'Paused QQ stole playing browser' }
if ($null -ne (Select-Session @())) { throw 'Empty sessions must return null' }
if ((Select-Session @($qq)).SourceAppUserModelId -ne 'QQMusic.exe') { throw 'Paused fallback failed' }
Write-Output 'PASS: 6 real Select-Session cases, QQ/NetEase/browser priority and no-session path.'
