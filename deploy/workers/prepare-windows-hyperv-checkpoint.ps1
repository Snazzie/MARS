[CmdletBinding()]
param(
  [string]$VmName = 'Windows 11 dev environment',
  [string]$SnapshotName = $env:MARS_HYPERV_SNAPSHOT_NAME,
  [string]$CheckpointExportPath = 'C:\ProgramData\Mars\golden-checkpoint',
  [string]$ArtifactPath = 'C:\ProgramData\Mars\artifacts\windows-worker-checkpoint.zip',
  [string]$BackupPath = 'C:\ProgramData\Mars\backups\windows-worker-checkpoint.zip'
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-VmName', $VmName)
  if (-not [string]::IsNullOrWhiteSpace($SnapshotName)) { $arguments += @('-SnapshotName', $SnapshotName) }
  $arguments += @('-CheckpointExportPath', $CheckpointExportPath, '-ArtifactPath', $ArtifactPath, '-BackupPath', $BackupPath)
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  exit $process.ExitCode
}
if ([string]::IsNullOrWhiteSpace($SnapshotName)) {
  $checkpoint = Get-VMSnapshot -VMName $VmName -ErrorAction Stop | Where-Object SnapshotType -eq 'Standard' | Sort-Object CreationTime -Descending | Select-Object -First 1
  if (-not $checkpoint) { throw "No Standard checkpoint exists for VM: $VmName" }
  $SnapshotName = $checkpoint.Name
} else {
  $checkpoint = Get-VMSnapshot -VMName $VmName -Name $SnapshotName -ErrorAction Stop
}
if ($checkpoint.SnapshotType -ne 'Standard') { throw "Checkpoint must be Standard: $SnapshotName" }
foreach ($path in @($CheckpointExportPath, $ArtifactPath, $BackupPath)) {
  if (Test-Path -LiteralPath $path) { throw "Output already exists: $path" }
}

New-Item -ItemType Directory -Force -Path $CheckpointExportPath,(Split-Path -Parent $ArtifactPath),(Split-Path -Parent $BackupPath) | Out-Null
Write-Host "Exporting checkpoint '$SnapshotName' to $CheckpointExportPath..."
Export-VMSnapshot -VMName $VmName -Name $SnapshotName -Path $CheckpointExportPath
$vmcx = @(Get-ChildItem -LiteralPath $CheckpointExportPath -Recurse -Filter '*.vmcx')
if ($vmcx.Count -ne 1) { throw "Checkpoint export must contain exactly one .vmcx configuration; found $($vmcx.Count)." }

$files = @(Get-ChildItem -LiteralPath $CheckpointExportPath -Recurse -File | ForEach-Object {
  [ordered]@{
    path = $_.FullName.Substring($CheckpointExportPath.TrimEnd('\').Length + 1)
    length = $_.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
  }
})
[ordered]@{
  format = 1
  kind = 'hyperv-checkpoint-export'
  vmName = $VmName
  snapshotName = $SnapshotName
  snapshotType = $checkpoint.SnapshotType.ToString()
  createdAt = [DateTime]::UtcNow.ToString('o')
  files = $files
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $CheckpointExportPath 'manifest.json') -Encoding utf8

$tempArtifact = "$ArtifactPath.partial.zip"
try {
  Write-Host "Creating downloadable checkpoint archive at $ArtifactPath..."
  & tar.exe -a -cf $tempArtifact -C $CheckpointExportPath .
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempArtifact -PathType Leaf)) { throw "Checkpoint archive creation failed with exit code $LASTEXITCODE." }
  Move-Item -LiteralPath $tempArtifact -Destination $ArtifactPath
  Copy-Item -LiteralPath $ArtifactPath -Destination $BackupPath
} finally {
  Remove-Item -LiteralPath $tempArtifact -Force -ErrorAction SilentlyContinue
}

$artifactSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArtifactPath).Hash.ToLowerInvariant()
$backupSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $BackupPath).Hash.ToLowerInvariant()
if ($artifactSha256 -ne $backupSha256) { throw 'Checkpoint backup digest does not match the downloadable artifact.' }

Write-Host 'Golden checkpoint export, downloadable artifact, and backup are ready.' -ForegroundColor Green
Write-Host "Export:   $CheckpointExportPath"
Write-Host "Artifact: $ArtifactPath"
Write-Host "Backup:   $BackupPath"
Write-Host "SHA-256:  $artifactSha256"
Write-Host "MARS_WINDOWS_CHECKPOINT_PATH=$ArtifactPath"
Write-Host "MARS_WINDOWS_CHECKPOINT_SHA256=$artifactSha256"
