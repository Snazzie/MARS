param([Parameter(Mandatory=$true)][string]$StateFile,[string]$IconPath='')
$ErrorActionPreference='Stop'
if ($StateFile -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)') { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$created=$false
$mutex = New-Object Threading.Mutex($false,'Local\MarsWorkerTray',[ref]$created)
if (-not $created) { exit 0 }
function Read-PickupJson([string]$path) {
  $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  $reader=New-Object IO.StreamReader($stream)
  try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}
function Read-State {
  $count=0
  try { $inventory=Read-PickupJson "$StateFile.inventory.json"; if ($inventory.activeCount -is [int] -and $inventory.activeCount -ge 0) { $count=$inventory.activeCount } } catch {}
  try {
    if (-not (Test-Path -LiteralPath $StateFile)) { return [pscustomobject]@{ accepting=$true; activeCount=$count } }
    $v=Read-PickupJson $StateFile
    if ($v.paused -isnot [bool]) { throw 'invalid state' }
    return [pscustomobject]@{ accepting=(-not $v.paused); activeCount=$count }
  } catch { return [pscustomobject]@{ accepting=$false; activeCount=$count } }
}
function Write-State([bool]$accepting, [int]$activeCount) { $dir=Split-Path $StateFile; New-Item -ItemType Directory -Force -Path $dir|Out-Null; $tmp="$StateFile.$([guid]::NewGuid().ToString('N')).tmp"; $json=@{paused=(-not $accepting);activeCount=$activeCount}|ConvertTo-Json -Compress; [IO.File]::WriteAllText($tmp,$json,(New-Object Text.UTF8Encoding($false))); Move-Item -LiteralPath $tmp -Destination $StateFile -Force }
$state=Read-State
$notify=New-Object Windows.Forms.NotifyIcon; $iconCandidate=if($IconPath){$IconPath}else{Join-Path $PSScriptRoot 'MARS.ico'}; if(Test-Path -LiteralPath $iconCandidate){$notify.Icon=New-Object Drawing.Icon($iconCandidate)}else{$notify.Icon=[Drawing.SystemIcons]::Application}; $notify.Visible=$true
$menu=New-Object Windows.Forms.ContextMenuStrip; $status=$menu.Items.Add(''); $status.Enabled=$false; [void]$menu.Items.Add('-'); $action=$menu.Items.Add('')
$refresh={ $mode=if($state.accepting){'Accepting new leases'}else{'New leases paused'}; $status.Text="$($state.activeCount) running - $mode"; $action.Text=if($state.accepting){'Pause New Leases'}else{'Resume New Leases'}; $notify.Text="Mars Worker - $($state.activeCount) running" }
$toggle={ try { Write-State (-not $state.accepting) $state.activeCount; $state.accepting=-not $state.accepting; & $refresh } catch { [void][Windows.Forms.MessageBox]::Show("Could not save job pickup state: $($_.Exception.Message)",'Mars Worker') } }
$action.Add_Click($toggle); $notify.Add_MouseClick({ if($_.Button -eq [Windows.Forms.MouseButtons]::Left){$menu.Show([Windows.Forms.Cursor]::Position)} })
$timer=New-Object Windows.Forms.Timer; $timer.Interval=1000; $timer.Add_Tick({$next=Read-State;if($next.accepting-ne$state.accepting -or $next.activeCount-ne$state.activeCount){$state.accepting=$next.accepting;$state.activeCount=$next.activeCount;&$refresh}});$timer.Start();&$refresh
[Windows.Forms.Application]::Run();$timer.Dispose();$notify.Visible=$false;$notify.Dispose();$mutex.Dispose()
