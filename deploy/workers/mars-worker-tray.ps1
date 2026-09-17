param([Parameter(Mandatory=$true)][string]$StateFile,[string]$IconPath='')
$ErrorActionPreference='Stop'
if (-not [IO.Path]::IsPathFullyQualified($StateFile)) { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mutex = New-Object Threading.Mutex($false,'Local\MarsWorkerTray',[ref]$created)
if (-not $created) { exit 0 }
function Read-State { try { if (-not (Test-Path -LiteralPath $StateFile)) { return [pscustomobject]@{ accepting = $true; activeCount = 0 } }; $v=Get-Content -LiteralPath $StateFile -Raw|ConvertFrom-Json; if ($null -eq $v.paused -or ($null -ne $v.activeCount -and ([int]$v.activeCount -lt 0))) { throw 'invalid state' }; $count=if($null -eq $v.activeCount){0}else{[int]$v.activeCount}; return [pscustomobject]@{ accepting = (-not [bool]$v.paused); activeCount = $count } } catch { return [pscustomobject]@{ accepting = $false; activeCount = 0 } } }
function Write-State([bool]$accepting, [int]$activeCount) { $dir=Split-Path $StateFile; New-Item -ItemType Directory -Force -Path $dir|Out-Null; $tmp="$StateFile.$([guid]::NewGuid().ToString('N')).tmp"; @{paused=(-not $accepting);activeCount=$activeCount}|ConvertTo-Json -Compress|Set-Content -LiteralPath $tmp -Encoding utf8; Move-Item -LiteralPath $tmp -Destination $StateFile -Force }
$state=Read-State; $accepting=$state.accepting; $activeCount=$state.activeCount
$notify=New-Object Windows.Forms.NotifyIcon; $iconCandidate=if($IconPath){$IconPath}else{Join-Path $PSScriptRoot 'MARS.ico'}; if(Test-Path -LiteralPath $iconCandidate){$notify.Icon=New-Object Drawing.Icon($iconCandidate)}else{$notify.Icon=[Drawing.SystemIcons]::Application}; $notify.Visible=$true
$menu=New-Object Windows.Forms.ContextMenuStrip; $status=$menu.Items.Add(''); $status.Enabled=$false; [void]$menu.Items.Add('-'); $action=$menu.Items.Add('')
$refresh={ $mode=if($accepting){'Accepting new leases'}else{'New leases paused'}; $status.Text="$activeCount running — $mode"; $action.Text=if($accepting){'Pause New Leases'}else{'Resume New Leases'}; $notify.Text="Mars Worker — $activeCount running" }
$toggle={ try { Write-State (-not $accepting) $activeCount; $accepting=-not $accepting; & $refresh } catch {} }
$action.Add_Click($toggle); $notify.Add_MouseClick({ if($_.Button -eq [Windows.Forms.MouseButtons]::Left){$menu.Show([Windows.Forms.Cursor]::Position)} })
$timer=New-Object Windows.Forms.Timer; $timer.Interval=1000; $timer.Add_Tick({$next=Read-State;if($next.accepting-ne$accepting -or $next.activeCount-ne$activeCount){$accepting=$next.accepting;$activeCount=$next.activeCount;&$refresh}});$timer.Start();&$refresh
[Windows.Forms.Application]::Run();$timer.Dispose();$notify.Visible=$false;$notify.Dispose();$mutex.Dispose()
