param([Parameter(Mandatory=$true)][string]$StateFile)
$ErrorActionPreference='Stop'
if (-not [IO.Path]::IsPathFullyQualified($StateFile)) { exit 2 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mutex = New-Object Threading.Mutex($false,'Local\MarsWorkerTray',[ref]$created)
if (-not $created) { exit 0 }
function Read-State { try { if (-not (Test-Path -LiteralPath $StateFile)) { return $true }; $v=Get-Content -LiteralPath $StateFile -Raw|ConvertFrom-Json; if ($null -eq $v.paused -or @($v.PSObject.Properties).Count -ne 1) { throw 'invalid state' }; return (-not [bool]$v.paused) } catch { return $false } }
function Write-State([bool]$accepting) { $dir=Split-Path $StateFile; New-Item -ItemType Directory -Force -Path $dir|Out-Null; $tmp="$StateFile.$([guid]::NewGuid().ToString('N')).tmp"; @{paused=(-not $accepting)}|ConvertTo-Json -Compress|Set-Content -LiteralPath $tmp -Encoding utf8; Move-Item -LiteralPath $tmp -Destination $StateFile -Force }
$accepting=Read-State
$notify=New-Object Windows.Forms.NotifyIcon; $notify.Icon=[Drawing.SystemIcons]::Application; $notify.Visible=$true
$menu=New-Object Windows.Forms.ContextMenuStrip; $status=$menu.Items.Add(''); $status.Enabled=$false; [void]$menu.Items.Add('-'); $action=$menu.Items.Add('')
$refresh={ $status.Text=if($accepting){'Accepting new leases'}else{'New leases paused'}; $action.Text=if($accepting){'Pause New Leases'}else{'Resume New Leases'}; $notify.Text=if($accepting){'Mars Worker — accepting new leases'}else{'Mars Worker — new leases paused'} }
$toggle={ try { Write-State (-not $accepting); $accepting=-not $accepting; & $refresh } catch {} }
$action.Add_Click($toggle); $notify.Add_MouseClick({ if($_.Button -eq [Windows.Forms.MouseButtons]::Left){$menu.Show([Windows.Forms.Cursor]::Position)} })
$timer=New-Object Windows.Forms.Timer; $timer.Interval=1000; $timer.Add_Tick({$next=Read-State;if($next-ne$accepting){$accepting=$next;&$refresh}});$timer.Start();&$refresh
[Windows.Forms.Application]::Run();$timer.Dispose();$notify.Visible=$false;$notify.Dispose();$mutex.Dispose()
