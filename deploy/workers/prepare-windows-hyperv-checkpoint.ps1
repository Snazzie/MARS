[CmdletBinding()]
param(
  [string]$VmName = 'Windows 11 dev environment',
  [string]$SnapshotName = $env:MARS_HYPERV_SNAPSHOT_NAME,
  [string]$CheckpointExportPath = 'C:\ProgramData\Mars\golden-checkpoint',
  [string]$ArtifactPath = 'C:\ProgramData\Mars\artifacts\windows-worker-checkpoint.zip',
  [string]$BackupPath = 'C:\ProgramData\Mars\backups\windows-worker-checkpoint.zip',
  [string]$JobAgentSha256 = $env:MARS_WINDOWS_JOB_AGENT_SHA256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows-hyperv-checkpoint.psm1') -Force

function Wait-MarsPublishedVmState {
  param([string]$Name,[string]$State,[TimeSpan]$Timeout)
  $deadline = [DateTime]::UtcNow.Add($Timeout)
  do { $current = (Get-VM -Name $Name -ErrorAction Stop).State.ToString(); if ($current -eq $State) { return }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
  throw "VM $Name did not reach $State; current state is $current."
}

function Wait-MarsPublishedHeartbeat {
  param([string]$Name,[TimeSpan]$Timeout)
  $deadline = [DateTime]::UtcNow.Add($Timeout)
  do { $heartbeat = (Get-VMIntegrationService -VMName $Name -Name 'Heartbeat').PrimaryStatusDescription; if ($heartbeat -eq 'OK') { return }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
  throw "Guest heartbeat did not become ready: $heartbeat"
}

function Invoke-MarsPublishedProbe {
  param([string]$ExportRoot,[string]$WorkingRoot)
  $vmcx = @(Get-ChildItem -LiteralPath $ExportRoot -Recurse -File -Filter '*.vmcx')
  if ($vmcx.Count -ne 1) { throw "Probe export must contain exactly one .vmcx; found $($vmcx.Count)." }
  $name = 'mars-provision-probe-' + [guid]::NewGuid().ToString('N').Substring(0,10)
  $cloneRoot = Join-Path $WorkingRoot 'clone'; $created = $false
  try {
    $vm = Import-VM -Path $vmcx[0].FullName -Copy -GenerateNewId -VirtualMachinePath $cloneRoot -VhdDestinationPath $cloneRoot
    Rename-VM -VM $vm -NewName $name; $created = $true
    Set-VM -Name $name -AutomaticCheckpointsEnabled $false
    Enable-VMIntegrationService -VMName $name -Name 'Guest Service Interface'
    Start-VM -Name $name | Out-Null; Wait-MarsPublishedHeartbeat $name ([TimeSpan]::FromMinutes(5))
    $nonce = ([BitConverter]::ToString((New-MarsRandomBytes 32))).Replace('-','').ToLowerInvariant()
    $bootstrap = Join-Path $WorkingRoot 'probe.json'
    [ordered]@{ version = 1; mode = 'probe'; nonce = $nonce } | ConvertTo-Json -Compress | Set-Content -LiteralPath $bootstrap -Encoding utf8
    Copy-VMFile -Name $name -SourcePath $bootstrap -DestinationPath 'C:\ProgramData\Mars\bootstrap.json' -FileSource Host -CreateFullPath -Force
    Wait-MarsPublishedVmState $name 'Off' ([TimeSpan]::FromMinutes(10))
    $disk = Get-VMHardDiskDrive -VMName $name | Select-Object -First 1
    $mounted = Mount-VHD -Path $disk.Path -ReadOnly -Passthru | Get-Disk
    $partition = Get-Partition -DiskNumber $mounted.Number | Where-Object Type -eq 'Basic' | Sort-Object Size -Descending | Select-Object -First 1
    $letter = (68..90 | ForEach-Object { [char]$_ } | Where-Object { -not (Test-Path "$($_):\") } | Select-Object -First 1); $access = "$letter`:\"
    Add-PartitionAccessPath -DiskNumber $partition.DiskNumber -PartitionNumber $partition.PartitionNumber -AccessPath $access
    try {
      $resultPath = Join-Path $access 'ProgramData\Mars\provisioning-probe.json'; $bytes = [IO.File]::ReadAllBytes($resultPath)
      $result = [Text.UTF8Encoding]::new($false).GetString($bytes) | ConvertFrom-Json
      if ([int]$result.version -ne 1 -or $result.success -ne $true -or $result.nonce -cne $nonce) { throw 'Published checkpoint probe failed.' }
      return [pscustomobject]@{ NonceSha256 = 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap).Hash.ToLowerInvariant(); ResultSha256 = Get-MarsSha256Digest $bytes; ObservedAt = [DateTime]::UtcNow.ToString('o') }
    } finally { Remove-PartitionAccessPath -DiskNumber $partition.DiskNumber -PartitionNumber $partition.PartitionNumber -AccessPath $access -ErrorAction SilentlyContinue; Dismount-VHD -Path $disk.Path -ErrorAction SilentlyContinue }
  } finally {
    if ($created -and (Get-VM -Name $name -ErrorAction SilentlyContinue)) { Stop-VM -Name $name -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -Name $name -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $cloneRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]$identity
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-VmName',$VmName,'-CheckpointExportPath',$CheckpointExportPath,'-ArtifactPath',$ArtifactPath,'-BackupPath',$BackupPath,'-JobAgentSha256',$JobAgentSha256)
  if ($SnapshotName) { $arguments += @('-SnapshotName',$SnapshotName) }
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru; exit $process.ExitCode
}
if ($JobAgentSha256 -notmatch '^[0-9a-f]{64}$') { throw '-JobAgentSha256 or MARS_WINDOWS_JOB_AGENT_SHA256 must be a lowercase SHA-256 value.' }
if ([string]::IsNullOrWhiteSpace($SnapshotName)) { $checkpoint = Get-VMSnapshot -VMName $VmName | Where-Object SnapshotType -eq 'Standard' | Sort-Object CreationTime -Descending | Select-Object -First 1; if (-not $checkpoint) { throw "No Standard checkpoint exists for VM: $VmName" }; $SnapshotName = $checkpoint.Name }
else { $checkpoint = Get-VMSnapshot -VMName $VmName -Name $SnapshotName -ErrorAction Stop }
if ($checkpoint.SnapshotType.ToString() -ne 'Standard') { throw 'Checkpoint must be Standard.' }
if ((Get-VM -Name $VmName).State.ToString() -ne 'Running') { throw 'Published checkpoint capture requires the VM to be running.' }
foreach ($path in @($CheckpointExportPath,$ArtifactPath,$BackupPath)) { if (Test-Path -LiteralPath $path) { throw "Output already exists: $path" } }

$working = Join-Path ([IO.Path]::GetTempPath()) ('mars-checkpoint-probe-' + [guid]::NewGuid().ToString('N'))
$tempExport = Join-Path $working 'export'
try {
  New-Item -ItemType Directory -Force -Path $working,(Split-Path -Parent $ArtifactPath),(Split-Path -Parent $BackupPath) | Out-Null
  Export-VMSnapshot -VMName $VmName -Name $SnapshotName -Path $tempExport
  $probe = Invoke-MarsPublishedProbe $tempExport $working
  $recipe = [pscustomobject][ordered]@{ type = 'external' }
  Export-MarsCheckpoint -VmName $VmName -CheckpointName $SnapshotName -OutputPath $CheckpointExportPath -Recipe $recipe -JobAgentSha256 "sha256:$JobAgentSha256" -NonceSha256 $probe.NonceSha256 -ProbeResultSha256 $probe.ResultSha256 -ProbeObservedAt $probe.ObservedAt | Out-Null
  $partial = "$ArtifactPath.partial.zip"
  try { & tar.exe -a -cf $partial -C $CheckpointExportPath .; if ($LASTEXITCODE -ne 0) { throw "Checkpoint archive creation failed with exit code $LASTEXITCODE." }; Move-Item -LiteralPath $partial -Destination $ArtifactPath }
  finally { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
  Copy-Item -LiteralPath $ArtifactPath -Destination $BackupPath
  $artifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArtifactPath).Hash.ToLowerInvariant(); $backupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BackupPath).Hash.ToLowerInvariant()
  if ($artifactHash -ne $backupHash) { throw 'Checkpoint backup digest does not match the downloadable artifact.' }
  Write-Host "MARS_WINDOWS_CHECKPOINT_PATH=$ArtifactPath"; Write-Host "MARS_WINDOWS_CHECKPOINT_SHA256=$artifactHash"
} finally { Remove-Item -LiteralPath $working -Recurse -Force -ErrorAction SilentlyContinue }
