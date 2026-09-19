[CmdletBinding()]
param([string]$CheckpointExportPath = 'C:\ProgramData\Mars\golden-checkpoint')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\deploy\workers\windows-hyperv-checkpoint.psm1') -Force

function Test-MarsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-MarsAdministrator)) {
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-CheckpointExportPath',$CheckpointExportPath) -Wait -PassThru
  exit $process.ExitCode
}

$manifest = Test-MarsCheckpointManifest -Root $CheckpointExportPath -PassThru
$vmcx = @(Get-ChildItem -LiteralPath $CheckpointExportPath -Recurse -File -Filter '*.vmcx')
if ($vmcx.Count -ne 1) { throw "Expected exactly one exported VM configuration under $CheckpointExportPath." }
$cloneName = "mars-local-smoke-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$root = Join-Path ([IO.Path]::GetTempPath()) $cloneName
$created = $false
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $vm = Import-VM -Path $vmcx[0].FullName -Copy -GenerateNewId -VirtualMachinePath $root -VhdDestinationPath $root
  Rename-VM -VM $vm -NewName $cloneName; $created = $true
  Set-VM -Name $cloneName -AutomaticCheckpointsEnabled $false
  Enable-VMIntegrationService -VMName $cloneName -Name 'Guest Service Interface'
  Start-VM -Name $cloneName | Out-Null
  $deadline = [DateTime]::UtcNow.AddMinutes(5)
  do { $heartbeat = (Get-VMIntegrationService -VMName $cloneName -Name 'Heartbeat').PrimaryStatusDescription; if ($heartbeat -eq 'OK') { break }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
  if ($heartbeat -ne 'OK') { throw "Guest heartbeat did not become ready: $heartbeat" }
  $nonce = ([BitConverter]::ToString((New-MarsRandomBytes 32))).Replace('-','').ToLowerInvariant()
  $bootstrap = Join-Path $root 'probe.json'
  [ordered]@{ version=1;mode='probe';nonce=$nonce } | ConvertTo-Json -Compress | Set-Content -LiteralPath $bootstrap -Encoding utf8
  Copy-VMFile -Name $cloneName -SourcePath $bootstrap -DestinationPath 'C:\ProgramData\Mars\bootstrap.json' -FileSource Host -CreateFullPath -Force
  $deadline = [DateTime]::UtcNow.AddMinutes(10)
  do { $state = (Get-VM -Name $cloneName).State.ToString(); if ($state -eq 'Off') { break }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
  if ($state -ne 'Off') { throw "Probe guest did not shut down: $state" }
  $diskPath = (Get-VMHardDiskDrive -VMName $cloneName | Select-Object -First 1).Path
  $disk = Mount-VHD -Path $diskPath -ReadOnly -Passthru | Get-Disk
  $partition = Get-Partition -DiskNumber $disk.Number | Where-Object Type -eq 'Basic' | Sort-Object Size -Descending | Select-Object -First 1
  $letter = (68..90 | ForEach-Object { [char]$_ } | Where-Object { -not (Test-Path "$($_):\") } | Select-Object -First 1); $access = "$letter`:\"
  Add-PartitionAccessPath -DiskNumber $partition.DiskNumber -PartitionNumber $partition.PartitionNumber -AccessPath $access
  try {
    $result = Get-Content -LiteralPath (Join-Path $access 'ProgramData\Mars\provisioning-probe.json') -Raw | ConvertFrom-Json
    if ([int]$result.version -ne 1 -or $result.success -ne $true -or $result.nonce -cne $nonce) { throw 'Credential-free guest probe returned invalid evidence.' }
  } finally {
    Remove-PartitionAccessPath -DiskNumber $partition.DiskNumber -PartitionNumber $partition.PartitionNumber -AccessPath $access -ErrorAction SilentlyContinue
    Dismount-VHD -Path $diskPath -ErrorAction SilentlyContinue
  }
  Write-Host "LOCAL HYPER-V VM PROOF PASSED ($($manifest.imageDigest))" -ForegroundColor Green
} finally {
  if ($created -and (Get-VM -Name $cloneName -ErrorAction SilentlyContinue)) { Stop-VM -Name $cloneName -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -Name $cloneName -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
