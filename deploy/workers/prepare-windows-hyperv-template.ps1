[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceVhdx,
  [Parameter(Mandatory)][string]$SourceSha256,
  [Parameter(Mandatory)][string]$JobAgentPath,
  [Parameter(Mandatory)][string]$OutputVhdx,
  [Parameter(Mandatory)][string]$OutputManifest,
  [Parameter(Mandatory)][System.Management.Automation.PSCredential]$GuestCredential,
  [string]$SourceUrl = 'https://developer.microsoft.com/en-us/windows/downloads/virtual-machines/'
)
$ErrorActionPreference = 'Stop'
function Digest([string]$path) { 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
function AssertDigest([string]$actual, [string]$expected, [string]$label) { $normalized = $expected.ToLowerInvariant(); if ($normalized -notmatch '^sha256:[0-9a-f]{64}$' -or $actual -ne $normalized) { throw "$label checksum mismatch: expected $expected, got $actual" } }
if (-not (Test-Path -LiteralPath $SourceVhdx -PathType Leaf)) { throw "Source VHDX not found: $SourceVhdx" }
if (-not (Test-Path -LiteralPath $JobAgentPath -PathType Leaf)) { throw "Job agent not found: $JobAgentPath" }
AssertDigest (Digest $SourceVhdx) ("sha256:" + $SourceSha256.Trim().ToLowerInvariant().Replace('sha256:','')) 'source VHDX'
if ((Get-VHD -Path $SourceVhdx).VhdType -eq 'Differencing') { throw 'Source VHDX must be a sealed non-differencing parent.' }
$name = "whitesmith-template-$([guid]::NewGuid().ToString('N'))"
$temp = Join-Path ([IO.Path]::GetTempPath()) $name
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$working = Join-Path $temp 'template.vhdx'
Copy-Item -LiteralPath $SourceVhdx -Destination $working
try {
  New-VM -Name $name -Generation 2 -MemoryStartupBytes 4GB -VHDPath $working | Out-Null
  Set-VMProcessor -VMName $name -Count 2
  Set-VM -VMName $name -AutomaticStopAction ShutDown -StaticMemory
  Set-VM -VMName $name -AutomaticCheckpointsEnabled $false
  Enable-VMIntegrationService -VMName $name -Name 'Guest Service Interface'
  Start-VM -Name $name | Out-Null
  $deadline = (Get-Date).AddMinutes(10)
  do { Start-Sleep -Seconds 2; $heartbeat = (Get-VMIntegrationService -VMName $name -Name 'Heartbeat').PrimaryStatusDescription } while ($heartbeat -ne 'OK' -and (Get-Date) -lt $deadline)
  if ($heartbeat -ne 'OK') { throw 'Windows template guest heartbeat did not become ready.' }
  Copy-VMFile -VMName $name -SourcePath $JobAgentPath -DestinationPath 'C:\Windows\Temp\whitesmith-job-agent.exe' -FileSource Host -CreateFullPath
  Invoke-Command -VMName $name -Credential $GuestCredential -ScriptBlock {
    New-Item -ItemType Directory -Force -Path 'C:\ProgramData\Whitesmith' | Out-Null
    Copy-Item 'C:\Windows\Temp\whitesmith-job-agent.exe' 'C:\ProgramData\Whitesmith\whitesmith-job-agent.exe' -Force
    New-Item -ItemType File -Force -Path 'C:\ProgramData\Whitesmith\guest-service.ready' | Out-Null
    $action = New-ScheduledTaskAction -Execute 'C:\ProgramData\Whitesmith\whitesmith-job-agent.exe' -Argument 'guest-service --platform windows-x64 --bootstrap-file C:\ProgramData\Whitesmith\bootstrap.json'
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
    Register-ScheduledTask -TaskName 'WhitesmithGuestService' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Remove-Item 'C:\Windows\Temp\whitesmith-job-agent.exe' -Force
    Remove-Item 'C:\Users\*\AppData\Local\Temp\*' -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item 'C:\ProgramData\Whitesmith\worker-identity.json' -Force -ErrorAction SilentlyContinue
  }
  Invoke-Command -VMName $name -Credential $GuestCredential -ScriptBlock { Start-Process 'C:\Windows\System32\Sysprep\Sysprep.exe' -ArgumentList '/generalize','/oobe','/shutdown','/quiet' -Wait }
  $deadline = (Get-Date).AddMinutes(10)
  do { Start-Sleep -Seconds 2 } while ((Get-VM -Name $name).State -ne 'Off' -and (Get-Date) -lt $deadline)
  if ((Get-VM -Name $name).State -ne 'Off') { throw 'Sysprep did not shut down the template.' }
  Optimize-VHD -Path $working -Mode Full
  New-Item -ItemType Directory -Force -Path (Split-Path $OutputVhdx) | Out-Null
  Move-Item -LiteralPath $working -Destination $OutputVhdx -Force
  $manifest = [ordered]@{ format = 1; guestPlatform = 'windows-x64'; source = [ordered]@{ url = $SourceUrl; sha256 = Digest $SourceVhdx }; template = [ordered]@{ sha256 = Digest $OutputVhdx; path = [IO.Path]::GetFileName($OutputVhdx) }; hyperv = [ordered]@{ generation = 2; secureBoot = $true; guestServiceInterface = $true }; guestAgentVersion = (Get-Item $JobAgentPath).VersionInfo.FileVersion; preparedAt = (Get-Date).ToUniversalTime().ToString('o') }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputManifest -Encoding utf8
} finally { Remove-VM -Name $name -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
