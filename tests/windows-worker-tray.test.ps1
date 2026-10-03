$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$directory = Join-Path ([IO.Path]::GetTempPath()) ('mars-tray-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$path = Join-Path $directory 'lease-pickup.json'
[IO.File]::WriteAllText($path, '{"paused":true,"activeCount":99}')
[IO.File]::WriteAllText("$path.inventory.json", '{"activeCount":3}')
$source = Get-Content -LiteralPath (Join-Path $root 'deploy/workers/mars-worker-tray.ps1') -Encoding UTF8 -Raw
$source = $source.Replace('Local\MarsWorkerTray', ('Local\MarsTrayTest-' + [guid]::NewGuid().ToString('N')))
$proof = @'
try {
  if (-not $notify.Visible) { throw 'Tray icon was not created' }
  if ($status.Text -notlike '3 running*') { throw 'Tray did not read separate worker inventory' }
  foreach ($expectedPause in @($false, $true, $false)) {
    $action.PerformClick()
    [Windows.Forms.Application]::DoEvents()
    $saved = [IO.File]::ReadAllText($StateFile) | ConvertFrom-Json
    if ($saved.paused -ne $expectedPause) { throw "Consecutive tray clicks failed: expected paused=$expectedPause, got $($saved.paused)" }
    $bytes = [IO.File]::ReadAllBytes($StateFile)
    if ($bytes[0] -eq 239) { throw 'Tray writes a UTF-8 BOM the worker cannot parse' }
  }
  [IO.File]::WriteAllText("$StateFile.inventory.json", '{"activeCount":1}')
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($clock.ElapsedMilliseconds -lt 1500) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
  if ($status.Text -notlike '1 running*') { throw 'Tray did not refresh worker inventory' }
  if (([IO.File]::ReadAllText($StateFile) | ConvertFrom-Json).paused) { throw 'Inventory update overwrote resume' }
  Write-Output 'PASS: tray resume/pause/resume, inventory refresh, and BOM-free state'
} finally { $timer.Dispose(); $notify.Visible=$false; $notify.Dispose(); $mutex.Dispose() }
'@
$source = $source.Replace('[Windows.Forms.Application]::Run()', $proof)
try { & ([scriptblock]::Create($source)) -StateFile $path -IconPath (Join-Path $root 'assets/MARS.ico') } finally { Remove-Item -LiteralPath $directory -Recurse -Force }
