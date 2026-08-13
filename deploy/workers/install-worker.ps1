[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = '__PUBLIC_BASE_URL__',
  [Alias('Code')][string]$JoinCode = '__JOIN_CODE__',
  [string]$WindowsContainerImage = '__WINDOWS_CONTAINER_IMAGE__',
  [switch]$AllowInsecureHttp
)
$ErrorActionPreference = 'Stop'
function Write-ChecklistStep([int]$Number, [string]$Title) { Write-Host ("[{0}/9] {1}" -f $Number, $Title) -ForegroundColor Cyan }
function Write-ChecklistPass([string]$Message) { Write-Host ("      PASS: {0}" -f $Message) -ForegroundColor Green }
function Write-ChecklistAction([string]$Message) { Write-Host ("      ACTION: {0}" -f $Message) -ForegroundColor Yellow }
function Require-Administrator {
  Write-ChecklistStep 1 'Administrator privileges'
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required. Rerun PowerShell as Administrator.' }
  Write-ChecklistPass 'elevated PowerShell session detected'
}
function Ensure-WindowsFeatures {
  Write-ChecklistStep 3 'Windows Containers and Hyper-V features'
  $containers = Get-WindowsOptionalFeature -Online -FeatureName Containers -ErrorAction SilentlyContinue
  $hyperv = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
  if ($containers.State -ne 'Enabled' -or $hyperv.State -ne 'Enabled') { throw 'Windows Containers and Hyper-V features must both be enabled before installing the worker.' }
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker CLI is required for the Windows-container worker.' }
  Write-ChecklistPass 'Windows Containers, Hyper-V, and Docker CLI detected'
}
function Assert-ImmutableImage([string]$Image) {
  if ($Image -notmatch '^[^@\s]+@sha256:[0-9a-fA-F]{64}$') { throw "Windows container image must be pinned with @sha256 digest: $Image" }
}
function Ensure-DockerWindowsHyperV([string]$Image) {
  Write-ChecklistStep 4 'Docker Windows-container engine'
  $ostype = (& docker info --format '{{.OSType}}' 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $ostype -ne 'windows') { throw 'Docker must be running in Windows-container mode.' }
  & docker pull $Image | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Unable to pull immutable Windows image $Image" }
  $repoDigest = (& docker image inspect --format '{{index .RepoDigests 0}}' $Image 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $repoDigest -ne $Image) { throw "Docker image digest mismatch: expected $Image, got $repoDigest" }
  Write-ChecklistPass "immutable Windows image available: $Image"
  Write-ChecklistStep 5 'Hyper-V container isolation'
  & docker run --rm --isolation=hyperv $Image cmd /c exit 0
  if ($LASTEXITCODE -ne 0) { throw 'Docker Hyper-V isolation probe failed; process isolation is not permitted.' }
  Write-ChecklistPass 'Hyper-V-isolated Windows container probe passed'
}
function Ensure-ControlPlane {
  Write-ChecklistStep 6 'Control-plane connectivity'
  if ($ControlPlaneUrl -notmatch '^https://' -and -not ($AllowInsecureHttp -and $ControlPlaneUrl -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$')) { throw 'Control-plane URL must use HTTPS, except local development with -AllowInsecureHttp.' }
  try { Invoke-WebRequest -Uri $ControlPlaneUrl -Method Get -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 | Out-Null } catch { throw "Control-plane is not reachable: $($_.Exception.Message)" }
  Write-ChecklistPass 'control-plane endpoint reachable'
}
function Ensure-WorkerFiles {
  Write-ChecklistStep 7 'Worker files and identity'
  $root = 'C:\ProgramData\Whitesmith'; $bin = 'C:\Program Files\Whitesmith'; New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
  $acl = Get-Acl $root; $acl.SetAccessRuleProtection($true,$false); foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','ContainerInherit,ObjectInherit','None','Allow'))); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('Administrators','FullControl','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl $root $acl
  [IO.File]::WriteAllText((Join-Path $root 'join-code'), $JoinCode)
  Write-ChecklistPass 'protected worker directories and one-use join code prepared'
}
Require-Administrator
Write-ChecklistStep 2 'Windows x64 architecture'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
Write-ChecklistPass '64-bit Windows detected'
Assert-ImmutableImage $WindowsContainerImage
Ensure-WindowsFeatures
Ensure-DockerWindowsHyperV $WindowsContainerImage
Ensure-ControlPlane
Ensure-WorkerFiles
$root = 'C:\ProgramData\Whitesmith'; $bin = 'C:\Program Files\Whitesmith'; $exe = Join-Path $bin 'whitesmith-orchestrator.exe'
Invoke-WebRequest -Uri "$ControlPlaneUrl/api/workers/orchestrator?audience=windows-x64" -OutFile $exe
$envLines = @("WHITESMITH_CONTROL_PLANE_URL=$ControlPlaneUrl", "WHITESMITH_JOIN_CODE_FILE=$root\join-code", "WHITESMITH_WINDOWS_CONTAINER_IMAGE=$WindowsContainerImage")
[Environment]::SetEnvironmentVariable('WHITESMITH_WORKER_ENV', ($envLines -join [Environment]::NewLine), 'Machine')
Write-ChecklistStep 8 'Windows service registration'
if (Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) { Stop-Service WhitesmithWorker -Force -ErrorAction SilentlyContinue; sc.exe delete WhitesmithWorker | Out-Null }
sc.exe create WhitesmithWorker binPath= "`"$exe`" windows-worker --service" start= auto obj= LocalSystem | Out-Null
sc.exe failure WhitesmithWorker reset= 86400 actions= restart/5000/restart/30000/none/0 | Out-Null
New-NetFirewallRule -DisplayName 'Whitesmith worker callbacks' -Direction Inbound -Protocol TCP -LocalPort 27182 -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
Write-ChecklistPass 'WhitesmithWorker service registered as LocalSystem'
Write-ChecklistStep 9 'Worker startup'
Start-Service WhitesmithWorker
Write-ChecklistPass 'WhitesmithWorker installed and started'
Write-Output 'Windows container worker setup complete.'
