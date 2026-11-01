$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot '..\lib\smtc-bridge.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptFile, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }

# Extract only pure helpers. Do not dot-source the bridge or initialize WinRT,
# the session manager, stdin runspace, polling loop, or any external process.
foreach ($name in @('Get-CoverAction', 'Get-CoverKey')) {
  $functionName = $name
  $fn = $ast.Find({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true)
  if ($null -eq $fn) { throw ($name + ' not found in smtc-bridge.ps1') }
  . ([scriptblock]::Create($fn.Extent.Text))
}

# Keep the bridge encoding-safe for Windows PowerShell 5.1 without a UTF-8 BOM.
$raw = [System.IO.File]::ReadAllText($scriptFile)
if ($raw -match '[^\x00-\x7F]') { throw 'Bridge source must remain ASCII for Windows PowerShell 5.1' }

$keyA = Get-CoverKey 'cloudmusic' 'Song' 'Artist' 'Album'
$keyB = Get-CoverKey 'qqmusic' 'Song' 'Artist' 'Album'
if ($keyA -ceq $keyB) { throw 'Artwork identity must include the player app' }
# PS 5.1 emits a JSON array as one pipeline object; @(... | ConvertFrom-Json)
# would wrap that array in another array and incorrectly report Count=1.
$fields = ConvertFrom-Json -InputObject $keyA
if ($fields.Count -ne 4 -or $fields[0] -ne 'cloudmusic') { throw 'Artwork key must preserve four identity fields' }
$pipeA = Get-CoverKey 'app' 'a|b' 'c' 'd'
$pipeB = Get-CoverKey 'app' 'a' 'b|c' 'd'
if ($pipeA -ceq $pipeB) { throw 'Literal pipes must not collapse artwork identities' }

$state = @{ key = $null; attempts = 0; nextAt = 0; ready = $false }
$action = Get-CoverAction $state $null 0
if ($action.clear -or $action.read) { throw 'Initial inactive state must do no artwork work' }

# Missing thumbnail and failed stream read both leave ready=false. Each consumes
# one bounded attempt; the next poll must not immediately repeat the work.
$action = Get-CoverAction $state $keyA 1000
if (-not $action.clear -or -not $action.read) { throw 'New track must clear artwork and allow its first read' }
if ($state.attempts -ne 1 -or $state.nextAt -ne 6000) { throw 'First attempt must establish a five-second delay' }
$action = Get-CoverAction $state $keyA 1000
if ($action.clear -or $action.read) { throw 'Same-tick poll must neither clear nor retry' }
$action = Get-CoverAction $state $keyA 5999
if ($action.read) { throw 'Unavailable artwork must not retry before five seconds' }
$action = Get-CoverAction $state $keyA 6000
if ($action.clear -or -not $action.read -or $state.attempts -ne 2) { throw 'Second attempt must run at five seconds without another clear' }
$action = Get-CoverAction $state $keyA 11000
if (-not $action.read -or $state.attempts -ne 3) { throw 'Third attempt must run after another five seconds' }
foreach ($now in @(16000, 30000, 999999)) {
  $action = Get-CoverAction $state $keyA $now
  if ($action.clear -or $action.read) { throw 'Exhausted artwork retries must remain idle' }
}
if ($state.attempts -ne 3) { throw 'Artwork attempt budget must stay capped at three' }

# Switching apps with identical metadata clears the old bytes and starts fresh.
$action = Get-CoverAction $state $keyB 1000000
if (-not $action.clear -or -not $action.read -or $state.attempts -ne 1) { throw 'App change must clear artwork and reset the retry budget' }
$state.ready = $true
foreach ($now in @(1000001, 1005000, 2000000)) {
  $action = Get-CoverAction $state $keyB $now
  if ($action.clear -or $action.read) { throw 'Successfully read artwork must never be re-read for the same identity' }
}
if ($state.attempts -ne 1) { throw 'Successful artwork must consume no extra attempts' }

# Metadata is case-sensitive. It must also reset a successful track's latch.
$keyCase = Get-CoverKey 'qqmusic' 'song' 'Artist' 'Album'
$action = Get-CoverAction $state $keyCase 2001000
if (-not $action.clear -or -not $action.read -or $state.ready) { throw 'Changed track metadata must clear the success latch' }

# Loss of every session clears exactly once and cannot spend read attempts.
$action = Get-CoverAction $state $null 2002000
if (-not $action.clear -or $action.read) { throw 'Session loss must clear artwork without a read' }
if ($state.attempts -ne 0 -or $state.ready) { throw 'Session loss must reset cover state' }
$action = Get-CoverAction $state $null 2003000
if ($action.clear -or $action.read) { throw 'Repeated inactive polls must remain idle' }
$action = Get-CoverAction $state $keyCase 2004000
if (-not $action.clear -or -not $action.read) { throw 'Returning track must get a fresh read after session loss' }

Write-Output 'PASS: artwork identity, clear transitions, five-second retry spacing, three-attempt cap, success latch, session loss, ASCII bridge source; pure AST helpers only.'
