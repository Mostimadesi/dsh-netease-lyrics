#requires -Version 5.1
<#
  smtc-bridge.ps1 - Windows SMTC (System Media Transport Controls) bridge.

  Runs as a persistent child process of the DSH plugin host. It reads the
  Windows global media session - the same source the volume-flyout media keys
  use - which is how the NetEase Cloud Music desktop client exposes
  "now playing" and accepts play/pause/next/previous without any NetEase
  private API, network call, or account access.

  Protocol
  --------
  stdout: one compact JSON object per line. Every object has a "type".
    {"type":"ready"}                                     once, at startup
    {"type":"state", ...}                                every poll tick
    {"type":"cover","hash":"...","mime":"image/jpeg","dataBase64":"..."}
                                                         only when art changes
    {"type":"ack","cmd":"toggle","ok":true}              after a stdin command
    {"type":"error","message":"..."}                     non-fatal
    {"type":"fatal","message":"..."}                     SMTC unusable; exits

  stdin: one compact JSON object per line.
    {"cmd":"toggle"} | {"cmd":"play"} | {"cmd":"pause"}
    {"cmd":"next"}   | {"cmd":"prev"} | {"cmd":"seek","pos":12.5}

  Notes
  -----
  * WinRT projection means this MUST run under Windows PowerShell 5.1
    (powershell.exe), not PowerShell 7 (pwsh): pwsh is .NET Core and cannot
    load System.Runtime.WindowsRuntime. The host enforces this.
  * THIS FILE MUST STAY PURE ASCII. Windows PowerShell 5.1 reads a .ps1 with no
    BOM using the machine's ANSI code page (GBK on a Chinese Windows). A UTF-8
    CJK literal is therefore mis-decoded, and a comma following a multi-byte
    character can be swallowed into the decoded double-byte pair - which
    silently corrupts the -AppPattern default list. Keeping the file ASCII
    removes the entire failure class.
  * All stdout is UTF-8 (set explicitly below) so CJK song titles and artists
    survive the pipe.
  * Awaiting WinRT IAsyncOperation from 5.1 requires the AsTask() shim below;
    PowerShell 5.1 has no native `await`.
#>
param(
  # Poll cadence. 500 ms keeps the island feeling live without burning CPU.
  [int]$PollMs = 500,
  # Comma-separated, case-insensitive substrings matched against the SMTC
  # SourceAppUserModelId. The NetEase desktop client reports an ASCII app id,
  # so ASCII patterns are sufficient and encoding-proof.
  [string]$AppPattern = 'cloudmusic,netease,com.netease,qqmusic,kugou',
  # Emit a single state line and exit. Used by the host for one-shot probes.
  [switch]$Once,
  # Define the helper functions and return without emitting a ready line,
  # starting the stdin reader runspace, or entering the poll loop. Lets
  # dev/test-cover.ps1 dot-source this file and unit-test Get-CoverBase64
  # against a real WinRT stream reference.
  [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'

# CJK titles must survive the pipe regardless of the console code page.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

# ---------------------------------------------------------------- WinRT shim --
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

# Same shim, for the progress-reporting flavour. Only the cover-art copy needs it
# (RandomAccessStream.CopyAsync is an IAsyncOperationWithProgress<UInt64,UInt64>).
$asTaskProgressGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperationWithProgress`2'
  })[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($operation))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# Touching the type refs once makes the WinRT projection available by name.
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

function Write-Line($object) {
  try {
    [Console]::Out.WriteLine(($object | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
  } catch { }
}

function Write-Error-Line($message) {
  Write-Line @{ type = 'error'; message = [string]$message }
}

# ------------------------------------------------------- timeline staleness --
# The timeline is a *snapshot*: GetTimelineProperties() returns the value the
# manager captured when it was requested, and a long-lived manager does not
# refresh it on its own unless the player's updates keep being pushed into this
# process. When that push path goes quiet - observed after a cold boot, where the
# player's SMTC session registers while the broker is not pushing yet - the
# position freezes at the startup value and the lyric line, which is derived from
# it, sits still mid-song. Nothing throws, so this failure is completely silent.
# Requesting the manager a second time pulls a current snapshot, so the timeline
# is re-synced on demand instead of paying for a request on every tick.
#
# 2200 ms is a measured, not guessed, threshold: players report the position in
# steps (QQ Music: 1.0 s and 2.05 s steps, i.e. up to ~1.5 s of unchanged value),
# and the browser client already extrapolates for 2 s before it has to stop. A
# window below the reporting step would fire on a healthy player; this one stays
# quiet while normal, and when the snapshot really is frozen it lands a refresh
# just as the client's 2 s of extrapolation runs out.
$script:timelineSyncMs = 2200
$script:timelineRefreshes = 0
$script:timelineLastPos = $null
# Milliseconds since the epoch. NOT [Environment]::TickCount64: that property does
# not exist in .NET Framework, which is what Windows PowerShell 5.1 runs on - it
# silently evaluates to $null, which makes every interval below read as 0 and
# disables the stall detection entirely (v0.3.2 shipped with that regression).
$script:timelineLastChangeAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# Some players publish no timeline at all. KuGou is one: Position, EndTime and
# PlaybackRate are all 0 and IsPlaybackPositionEnabled is false, so no amount of
# re-requesting produces a moving position - the lyric line would sit on t=0
# forever. For those sessions (EndTime unknown) a local clock is advanced from the
# track identity + play state instead. A real timeline always wins over it.
$script:estimate = @{ key = $null; pos = 0.0; at = 0; playing = $false }

# Pure state machine (unit-tested by test/timeline-sync.test.ps1). Mutates $State
# (a hashtable, hence by reference) and returns the position in seconds.
function Get-EstimatedPosition {
  param($State, [string]$Key, [bool]$Playing, [long]$NowMs)
  if ($null -eq $State -or $NowMs -le 0) { return 0.0 }
  if ($State.key -ne $Key) {
    # New track: restart from zero and remember the play state of this sample.
    $State.key = $Key
    $State.pos = 0.0
    $State.at = $NowMs
    $State.playing = $Playing
    return 0.0
  }
  # Credit the interval only when both ends of it were playing: a pause or a
  # resume therefore costs at most one poll interval (<= 500 ms), and a paused
  # gap is never credited as playback.
  if ($State.playing -and $Playing -and $NowMs -gt $State.at) {
    $State.pos = $State.pos + (($NowMs - $State.at) / 1000.0)
  }
  $State.at = $NowMs
  $State.playing = $Playing
  return [Math]::Round([double]$State.pos, 3)
}

# Pure decision helper (unit-tested by test/timeline-sync.test.ps1): is the
# snapshot stale enough to be worth a fresh manager request?
function Test-TimelineStalled {
  param(
    [bool]$Playing,
    [double]$Position,
    $LastPosition,
    [long]$UnchangedMs,
    [int]$AfterMs = 2200
  )
  if (-not $Playing) { return $false }            # paused: standing still is correct
  if ($null -eq $LastPosition) { return $false }  # first sample: nothing to compare
  if ([math]::Abs($Position - [double]$LastPosition) -ge 0.05) { return $false }
  return ($UnchangedMs -ge $AfterMs)
}

# Re-request the manager when the position has stopped moving. Returns $true only
# when a new manager was actually obtained, so the caller can re-read the
# timeline within the same tick and publish the live position immediately.
function Sync-TimelineSnapshot {
  param([bool]$Playing, [double]$Position)
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($now -le 0) { return $false }   # clock unavailable: never refresh on a bad interval
  $moved = $true
  if ($null -ne $script:timelineLastPos) {
    $moved = ([math]::Abs($Position - [double]$script:timelineLastPos) -ge 0.05)
  }
  if ($moved) {
    # Movement in either direction (playback, seek, loop wrap) proves the
    # snapshot is live, so restart the stall window.
    $script:timelineLastPos = $Position
    $script:timelineLastChangeAt = $now
    return $false
  }
  $unchangedMs = $now - $script:timelineLastChangeAt
  # Positional call: this runs twice a second, and named-argument binding is the
  # expensive half of it.
  if (-not (Test-TimelineStalled $Playing $Position $script:timelineLastPos $unchangedMs $script:timelineSyncMs)) {
    return $false
  }
  try {
    $fresh = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    if ($null -ne $fresh) {
      $script:manager = $fresh
      $script:timelineRefreshes += 1
      # Rate limit: a still-frozen snapshot is retried once per window, not per tick.
      $script:timelineLastChangeAt = $now
      return $true
    }
  } catch {
    Add-Note ('timeline refresh failed: ' + $_.Exception.Message)
  }
  $script:timelineLastChangeAt = $now
  return $false
}

# ------------------------------------------------------------ session lookup --
$patterns = @($AppPattern -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ -ne '' })

$manager = $null
try {
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
  Write-Line @{ type = 'fatal'; message = "SMTC manager unavailable: $($_.Exception.Message)" }
  exit 1
}

if ($null -eq $manager) {
  Write-Line @{ type = 'fatal'; message = 'SMTC manager returned null.' }
  exit 1
}

# Prefer a playing supported player, then another playing source, and only
# then a paused supported player. A paused NetEase session must not steal QQ.
function Select-Session {
  param($Sessions)
  if ($null -eq $Sessions -or $Sessions.Count -eq 0) { return $null }

  $preferredPaused = $null
  $otherPlaying = $null
  foreach ($s in $Sessions) {
    $low = ([string]$s.SourceAppUserModelId).ToLowerInvariant()
    $preferred = $false
    foreach ($p in $patterns) { if ($low.Contains($p)) { $preferred = $true; break } }
    $playing = $false
    try { $playing = ([string]$s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') } catch { }
    if ($preferred -and $playing) { return $s }
    if ($preferred -and $null -eq $preferredPaused) { $preferredPaused = $s }
    if ($playing -and $null -eq $otherPlaying) { $otherPlaying = $s }
  }
  if ($null -ne $otherPlaying) { return $otherPlaying }
  if ($null -ne $preferredPaused) { return $preferredPaused }
  return $Sessions[0]
}

# ----------------------------------------------------------------- cover art --
# Reading a thumbnail is the one place in this bridge that cannot use the obvious
# code. RandomAccessStreamReference.OpenReadAsync() is an
# IAsyncOperation<IRandomAccessStreamWithContentType>, and PowerShell 5.1 cannot
# project a .NET Task whose result type parameter is a WinRT *interface*: that
# task's .Result arrives as a bare System.__ComObject whose members are all
# unreachable, so [int]$stream.Size silently evaluates to 0 and every caller
# concludes "this track has no artwork". The object cannot be cast to IInputStream
# either, and Marshal.GetTypedObjectForIUnknown refuses Windows Runtime types
# outright ("The object's type must not be a Windows Runtime type").
#
# What does work: let COM accept the unprojected object where reflection expects an
# IInputStream, copy it into a *projected* class instance with a reflected
# RandomAccessStream.CopyAsync - the destination must be cast to IOutputStream
# first, or PowerShell passes a PSObject wrapper and the call is rejected - then
# read that InMemoryRandomAccessStream with ordinary calls. Verified against a real
# WinRT stream in dev/test-cover.ps1.
$script:lastCoverKey = $null
$script:copyAsyncMethod = $null

function Get-CoverBase64 {
  param($Thumbnail)
  if ($null -eq $Thumbnail) { return $null }
  try {
    $src = Await ($Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $src) { return $null }

    $dest = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    if ($null -eq $script:copyAsyncMethod) {
      $script:copyAsyncMethod = [Windows.Storage.Streams.RandomAccessStream].GetMethod('CopyAsync', [Type[]]@(
          [Windows.Storage.Streams.IInputStream], [Windows.Storage.Streams.IOutputStream]))
    }
    $copyArgs = New-Object 'object[]' 2
    $copyArgs[0] = $src
    $copyArgs[1] = [Windows.Storage.Streams.IOutputStream]$dest
    $copyOp = $script:copyAsyncMethod.Invoke($null, $copyArgs)
    $copyTask = $asTaskProgressGeneric.MakeGenericMethod([uint64], [uint64]).Invoke($null, @($copyOp))
    $copyTask.Wait(-1) | Out-Null

    $null = $dest.Seek(0)
    $size = [int]$dest.Size
    if ($size -le 0 -or $size -gt 8388608) { $dest.Dispose(); return $null }

    $reader = [Windows.Storage.Streams.DataReader]::new($dest)
    Await ($reader.LoadAsync([uint32]$size)) ([uint32]) | Out-Null
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    $reader.Dispose()
    $dest.Dispose()

    # An InMemoryRandomAccessStream carries no content type, so sniff the magic
    # bytes rather than defaulting blindly to JPEG: the client renders this as a
    # data: URL, and a declared type that contradicts the payload is worse than a
    # correct guess.
    if ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) {
      $mime = 'image/png'
    } elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) {
      $mime = 'image/jpeg'
    } elseif ($bytes.Length -ge 6 -and $bytes[0] -eq 0x47 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x46) {
      $mime = 'image/gif'
    } elseif ($bytes.Length -ge 12 -and $bytes[8] -eq 0x57 -and $bytes[9] -eq 0x45 -and $bytes[10] -eq 0x42) {
      $mime = 'image/webp'
    } else {
      $mime = 'image/jpeg'
    }

    return @{ data = [Convert]::ToBase64String($bytes); mime = $mime }
  } catch {
    return $null
  }
}

# -------------------------------------------------------------- state builder --
# Diagnostics. Every WinRT call in Get-State is wrapped in a silent swallow, which
# once hid a wrong method receiver (the timeline was read from the playback-info
# object instead of the session) and left the progress bar permanently at 0.
# A note makes a player that maps onto SMTC differently explain itself instead.
$script:notes = New-Object System.Collections.ArrayList
function Add-Note {
  param([string]$Text)
  foreach ($n in $script:notes) { if ($n -eq $Text) { return } }
  if ($script:notes.Count -ge 6) { return }
  [void]$script:notes.Add($Text)
}

function Get-State {
  $sessions = @()
  try { $sessions = @($manager.GetSessions()) } catch { $sessions = @() }
  $session = Select-Session $sessions

  if ($null -eq $session) {
    return @{
      type         = 'state'
      active       = $false
      sessionCount = $sessions.Count
      atMs         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
  }

  $appId = [string]$session.SourceAppUserModelId

  $playback = $null
  try { $playback = $session.GetPlaybackInfo() } catch { Add-Note 'GetPlaybackInfo failed' }
  $status = 'Closed'
  $canToggle = $true; $canNext = $false; $canPrev = $false; $canSeek = $false
  $rate = 1.0
  $posSec = 0.0; $durSec = 0.0
  if ($null -ne $playback) {
    try { $status = [string]$playback.PlaybackStatus } catch { }
    try { $rate = [double]$playback.PlaybackRate } catch { }
    try {
      $c = $playback.Controls
      $canToggle = [bool]$c.IsPlayPauseToggleEnabled
      $canNext = [bool]$c.IsNextEnabled
      $canPrev = [bool]$c.IsPreviousEnabled
      $canSeek = [bool]$c.IsPlaybackPositionEnabled
    } catch { Add-Note 'playback Controls unavailable' }
    try {
      # GetTimelineProperties() belongs to the SESSION, not to the playback-info
      # object. Asking $playback for it throws, and because the throw used to be
      # swallowed the progress bar silently stayed at 0 / --:-- forever.
      $tl = $session.GetTimelineProperties()
      $posSec = [double]$tl.Position.TotalSeconds
      $durSec = [double]$tl.EndTime.TotalSeconds
    } catch { Add-Note 'GetTimelineProperties failed' }
  }

  # A frozen snapshot looks exactly like a paused track downstream: the client
  # stops extrapolating after two seconds and the lyrics sit on one line. Detect
  # it here, refresh the manager, and publish the live position in this same tick.
  # Only meaningful when the session actually publishes a timeline (EndTime > 0);
  # for players that publish none, re-requesting cannot help and the local clock
  # below takes over instead.
  try {
    if ($durSec -gt 0) {
      $refreshed = Sync-TimelineSnapshot -Playing ($status -eq 'Playing') -Position $posSec
      if ($refreshed) {
        $freshSession = Select-Session @($manager.GetSessions())
        if ($null -ne $freshSession -and ([string]$freshSession.SourceAppUserModelId) -eq $appId) {
          $session = $freshSession
          $freshTl = $session.GetTimelineProperties()
          $posSec = [double]$freshTl.Position.TotalSeconds
          $durSec = [double]$freshTl.EndTime.TotalSeconds
        }
      }
    }
  } catch {
    Add-Note ('timeline resync failed: ' + $_.Exception.Message)
  }

  $title = ''; $artist = ''; $album = ''
  $thumbnail = $null
  try {
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($null -ne $props) {
      $title = [string]$props.Title
      $artist = [string]$props.Artist
      $album = [string]$props.AlbumTitle
      $thumbnail = $props.Thumbnail
    }
  } catch { Add-Note ('media properties failed: ' + $_.Exception.Message) }

  # No timeline published (KuGou): advance a local clock so the lyric line still
  # moves. The identity is what the client uses for its own clock, so a track
  # change restarts both together.
  $positionEstimated = $false
  if ($durSec -le 0) {
    $estimateKey = $appId + '|' + $title + '|' + $artist + '|' + $album
    $posSec = Get-EstimatedPosition $script:estimate $estimateKey ($status -eq 'Playing') ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $positionEstimated = $true
  } else {
    # A real timeline is back (or a different player): drop any stale estimate.
    $script:estimate.key = $null
  }

  # Re-read the artwork only when the identity of the track changes; the raw
  # thumbnail stream reference has no stable id of its own.
  $coverKey = "$title|$artist|$album"
  if ($coverKey -ne $script:lastCoverKey) {
    $script:lastCoverKey = $coverKey
    if ($null -eq $thumbnail) {
      Add-Note 'this media session exposes no artwork thumbnail'
    } else {
      $cover = Get-CoverBase64 $thumbnail
      if ($null -ne $cover) {
        Write-Line @{ type = 'cover'; hash = $coverKey; mime = $cover.mime; dataBase64 = $cover.data }
      } else {
        Add-Note 'artwork thumbnail could not be read'
      }
    }
  }

  $matched = $false
  $lowId = $appId.ToLowerInvariant()
  foreach ($p in $patterns) { if ($lowId.Contains($p)) { $matched = $true; break } }

  $state = @{
    type         = 'state'
    active       = $true
    app          = $appId
    matched      = $matched
    sessionCount = $sessions.Count
    title        = $title
    artist       = $artist
    album        = $album
    status       = $status
    playing      = ($status -eq 'Playing')
    positionSec  = [Math]::Round($posSec, 3)
    durationSec  = [Math]::Round($durSec, 3)
    rate         = $rate
    canToggle    = $canToggle
    canNext      = $canNext
    canPrev      = $canPrev
    canSeek      = $canSeek
    # Diagnostics: how many times a stalled timeline had to be re-requested.
    timelineRefreshes = $script:timelineRefreshes
    # True when the player publishes no timeline and the position is our own work
    # clock (KuGou): seeking in that player will not be reflected until the track
    # changes.
    positionEstimated = $positionEstimated
    atMs         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  if ($script:notes.Count -gt 0) { $state.notes = @($script:notes) }
  return $state
}

# ------------------------------------------------------------------- control --
function Get-PlayStatus {
  param($Session)
  try { return [string]$Session.GetPlaybackInfo().PlaybackStatus } catch { return '' }
}

function Wait-PlayStatus {
  param($Session, [string]$Want, [int]$TimeoutMs = 1500)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ($true) {
    if ((Get-PlayStatus $Session) -eq $Want) { return $true }
    if ([DateTime]::UtcNow -ge $deadline) { return $false }
    Start-Sleep -Milliseconds 120
  }
}

function Invoke-Control {
  param([string]$Command, $Position, [string]$RequestId)

  $sessions = @()
  try { $sessions = @($manager.GetSessions()) } catch { $sessions = @() }
  $session = Select-Session $sessions
  if ($null -eq $session) {
    $miss = @{ type = 'ack'; cmd = $Command; ok = $false; reason = 'no-session' }
    if ($RequestId) { $miss.id = $RequestId }
    return $miss
  }

  $ok = $false
  $reason = $null
  $via = 'explicit'
  $before = Get-PlayStatus $session
  try {
    switch ($Command) {
      'toggle' { $ok = [bool](Await ($session.TryTogglePlayPauseAsync()) ([bool])) }
      'play' {
        if ($before -eq 'Playing') { $ok = $true; $via = 'already' }
        else {
          $ok = [bool](Await ($session.TryPlayAsync()) ([bool]))
          if ($ok -and -not (Wait-PlayStatus $session 'Playing')) {
            # Some players - Edge's MediaSession bridge among them - acknowledge
            # TryPlayAsync/TryPauseAsync successfully without ever changing
            # state. The toggle path is the one they actually honour, so verify
            # and fall back rather than reporting a lie to the UI.
            $ok = [bool](Await ($session.TryTogglePlayPauseAsync()) ([bool]))
            $via = 'toggle-fallback'
          }
        }
      }
      'pause' {
        if ($before -eq 'Paused') { $ok = $true; $via = 'already' }
        else {
          $ok = [bool](Await ($session.TryPauseAsync()) ([bool]))
          if ($ok -and -not (Wait-PlayStatus $session 'Paused')) {
            $ok = [bool](Await ($session.TryTogglePlayPauseAsync()) ([bool]))
            $via = 'toggle-fallback'
          }
        }
      }
      'next' { $ok = [bool](Await ($session.TrySkipNextAsync()) ([bool])) }
      'prev' { $ok = [bool](Await ($session.TrySkipPreviousAsync()) ([bool])) }
      'seek' {
        # SMTC positions are 100-nanosecond ticks.
        $ticks = [long]([double]$Position * 10000000.0)
        $ok = [bool](Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool]))
      }
      default { $reason = 'unknown-command' }
    }
  } catch {
    $reason = $_.Exception.Message
    $ok = $false
  }

  $ack = @{ type = 'ack'; cmd = $Command; ok = $ok; via = $via }
  # The id lets the host answer exactly the request the widget is waiting on,
  # even when several commands are in flight at once.
  if ($RequestId) { $ack.id = $RequestId }
  if ($Command -eq 'seek') { $ack.pos = [double]$Position }
  if ($null -ne $reason) { $ack.reason = $reason }
  return $ack
}

if ($LibraryOnly) { return }

# ---------------------------------------------------------------------- loop --
Write-Line @{ type = 'ready'; pollMs = $PollMs; patterns = $patterns }

if ($Once) {
  Write-Line (Get-State)
  exit 0
}

# Commands arrive on stdin. They are read by a BLOCKING reader in a background
# runspace and handed over through a locked list. Neither [Console]::In.ReadLineAsync()
# nor a bare ReadLine() can be used in the poll loop: Console.In is a synchronized
# TextReader whose async path blocks the calling thread, so "has a command arrived
# yet?" would park the loop until a command actually arrived - the host would then
# receive no state updates at all until it sent one, which defeats the bridge.
$stdinLock = New-Object object
$stdinLines = New-Object System.Collections.ArrayList

$reader = [powershell]::Create()
[void]$reader.AddScript({
  param($lock, $list)
  while ($true) {
    $line = $null
    try { $line = [Console]::In.ReadLine() } catch { $line = $null }
    # EOF is signalled with an explicit sentinel rather than $null: a $null pushed
    # into this list and returned from Receive-Lines is unrolled away by
    # PowerShell's output pipeline, so the poll loop would never notice that the
    # host had closed stdin and the process would outlive its host.
    if ($null -eq $line) { $line = '__DSH_STDIN_EOF__' }
    [System.Threading.Monitor]::Enter($lock)
    try { [void]$list.Add($line) } finally { [System.Threading.Monitor]::Exit($lock) }
    # Stop reading once stdin is gone. Testing $null here would never fire: the
    # sentinel was assigned above precisely so it would survive the pipeline.
    if ($line -eq '__DSH_STDIN_EOF__') { break }
  }
}).AddArgument($stdinLock).AddArgument($stdinLines)
$null = $reader.BeginInvoke()

function Receive-Lines {
  $batch = $null
  [System.Threading.Monitor]::Enter($stdinLock)
  try {
    if ($stdinLines.Count -gt 0) {
      $batch = @($stdinLines.ToArray())
      $stdinLines.Clear()
    }
  } finally { [System.Threading.Monitor]::Exit($stdinLock) }
  # The leading comma stops a single-element batch - and, critically, a batch whose
  # only element is the EOF sentinel - from being unrolled into a bare scalar.
  return ,$batch
}

$running = $true
while ($running) {
  try { Write-Line (Get-State) } catch { Write-Error-Line $_.Exception.Message }

  $batch = Receive-Lines
  if ($null -ne $batch) {
    foreach ($line in $batch) {
      # The sentinel means the host closed our stdin: shut down cleanly.
      if ($line -eq '__DSH_STDIN_EOF__') { $running = $false; break }

      $line = $line.Trim()
      if ($line -eq '') { continue }
      try {
        $msg = $line | ConvertFrom-Json
        if ($msg.cmd) {
          $requestId = if ($msg.id) { [string]$msg.id } else { '' }
          $ack = if ($msg.cmd -eq 'seek') {
            Invoke-Control -Command 'seek' -Position $msg.pos -RequestId $requestId
          } else {
            Invoke-Control -Command ([string]$msg.cmd) -RequestId $requestId
          }
          Write-Line $ack
        }
      } catch {
        Write-Error-Line "bad command line: $($_.Exception.Message)"
      }
    }
  }

  if ($running) { Start-Sleep -Milliseconds $PollMs }
}

# The reader runspace is parked inside a blocking ReadLine() that will never
# return, so there is nothing to join. Leave the process immediately instead of
# hanging on a Dispose() that cannot complete.
try { [Console]::Out.Flush() } catch { }
[Environment]::Exit(0)
