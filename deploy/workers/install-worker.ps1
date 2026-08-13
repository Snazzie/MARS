[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = '__PUBLIC_BASE_URL__',
  [string]$JoinCode = '__JOIN_CODE__',
  [string]$WindowsVhdx = 'C:\ProgramData\Whitesmith\images\windows-job.vhdx',
  [string]$LinuxVhdx = '',
  [string]$HyperVSwitch = 'Default Switch',
  [string]$WindowsImageDigest = '__WINDOWS_IMAGE_DIGEST__',
  [string]$LinuxImageDigest = '__LINUX_IMAGE_DIGEST__',
  [switch]$AllowInsecureHttp
)
$ErrorActionPreference = 'Stop'

function Write-ChecklistStep([int]$Number, [string]$Title) {
  Write-Host ("[{0}/9] {1}" -f $Number, $Title) -ForegroundColor Cyan
}
function Write-ChecklistPass([string]$Message) { Write-Host ("      PASS: {0}" -f $Message) -ForegroundColor Green }
function Write-ChecklistSkip([string]$Message) { Write-Host ("      SKIP: {0}" -f $Message) -ForegroundColor DarkGray }
function Write-ChecklistAction([string]$Message) { Write-Host ("      ACTION: {0}" -f $Message) -ForegroundColor Yellow }
function Confirm-Remediation([string]$Message) {
  $answer = Read-Host "$Message [Y/N]"
  return $answer -match '^(?i)y(es)?$'
}
function Require-Administrator {
  Write-ChecklistStep 1 'Administrator privileges'
  if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-ChecklistAction 'Rerun PowerShell as Administrator.'
    throw 'Administrator privileges are required.'
  }
  Write-ChecklistPass 'elevated PowerShell session detected'
}
function Ensure-HyperV {
  Write-ChecklistStep 3 'Hyper-V feature and PowerShell tools'
  if (Get-Command Get-VM -ErrorAction SilentlyContinue) {
    Write-ChecklistPass 'Hyper-V PowerShell tools detected'
    return
  }
  Write-ChecklistAction 'Hyper-V and its PowerShell tools are not enabled.'
  if (-not (Confirm-Remediation 'Enable Microsoft-Hyper-V-All now?')) {
    throw 'Hyper-V PowerShell support is required.'
  }
  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null
  Write-ChecklistAction 'Restart Windows, then rerun this installer.'
  if (Confirm-Remediation 'Restart Windows now?') {
    Restart-Computer -Force
  }
  throw 'A Windows restart is required before Hyper-V can be used.'
}
function Ensure-HyperVSwitch {
  Write-ChecklistStep 4 'Hyper-V virtual switch'
  if (Get-VMSwitch -Name $HyperVSwitch -ErrorAction SilentlyContinue) {
    Write-ChecklistPass "switch '$HyperVSwitch' detected"
    return
  }
  Write-ChecklistAction "Hyper-V switch '$HyperVSwitch' was not found; creating it automatically."
  if ($HyperVSwitch -ne 'Default Switch' -and (Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue)) {
    $script:HyperVSwitch = 'Default Switch'
    Write-ChecklistPass "using existing 'Default Switch' instead"
    return
  }
  $adapter = Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'Up' } |
    Select-Object -First 1
  if (-not $adapter) {
    throw 'No active physical network adapter was found for the Hyper-V switch.'
  }
  Write-ChecklistAction "Creating external switch '$HyperVSwitch' on adapter '$($adapter.Name)'. Network connectivity may reset briefly."
  New-VMSwitch -Name $HyperVSwitch -NetAdapterName $adapter.Name -AllowManagementOS $true | Out-Null
  if (-not (Get-VMSwitch -Name $HyperVSwitch -ErrorAction SilentlyContinue)) {
    throw "Hyper-V switch '$HyperVSwitch' could not be created."
  }
  Write-ChecklistPass "external switch '$HyperVSwitch' created"
}
function Ensure-Template([int]$Number, [string]$Label, [string]$Path, [string]$Digest, [bool]$Required) {
  Write-ChecklistStep $Number $Label
  if (-not $Path) {
    if ($Required) { throw "$Label is required." }
    Write-ChecklistSkip 'not configured'
    return
  }
  if (-not (Test-Path $Path)) { throw "Template was not found: $Path" }
  Assert-Digest $Path $Digest
  Write-ChecklistPass "digest matches $Digest"
}
function Assert-Digest([string]$Path, [string]$Expected) {
  if ($Expected -notmatch '@sha256:[0-9a-fA-F]{64}$') { throw "Invalid immutable image digest: $Expected" }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  $expectedHash = $Expected.Split('@sha256:')[1].ToLowerInvariant()
  if ($actual -ne $expectedHash) { throw "Template digest mismatch for $Path" }
}

Require-Administrator
Write-ChecklistStep 2 'Windows x64 architecture'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
Write-ChecklistPass '64-bit Windows detected'
Ensure-HyperV
Ensure-HyperVSwitch
Ensure-Template 5 'Windows job image' $WindowsVhdx $WindowsImageDigest $true
Write-ChecklistStep 7 'Control-plane connectivity'
if ($ControlPlaneUrl -notmatch '^https://' -and -not ($AllowInsecureHttp -and $ControlPlaneUrl -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$')) { throw 'Control-plane URL must use HTTPS, except local development with -AllowInsecureHttp.' }
try { Invoke-WebRequest -Uri $ControlPlaneUrl -Method Get -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 | Out-Null } catch { throw "Control-plane is not reachable: $($_.Exception.Message)" }
Write-ChecklistPass 'control-plane endpoint reachable'
Write-ChecklistStep 8 'Worker files and identity'
$root = 'C:\ProgramData\Whitesmith'; $bin = 'C:\Program Files\Whitesmith'; New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
$acl = Get-Acl $root; $acl.SetAccessRuleProtection($true,$false); foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','ContainerInherit,ObjectInherit','None','Allow'))); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('Administrators','FullControl','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl $root $acl
[IO.File]::WriteAllText((Join-Path $root 'join-code'), $JoinCode); $joinAcl = Get-Acl (Join-Path $root 'join-code'); $joinAcl.SetAccessRuleProtection($true,$false); Set-Acl (Join-Path $root 'join-code') $joinAcl
Write-ChecklistPass 'protected worker directories and one-use join code prepared'
$exe = Join-Path $bin 'whitesmith-orchestrator.exe'; Invoke-WebRequest -Uri "$ControlPlaneUrl/api/workers/orchestrator?audience=windows-x64" -OutFile $exe
$envLines = @("WHITESMITH_CONTROL_PLANE_URL=$ControlPlaneUrl", "WHITESMITH_JOIN_CODE_FILE=$root\join-code", "WHITESMITH_WINDOWS_VHDX=$WindowsVhdx", "WHITESMITH_WINDOWS_IMAGE_DIGEST=$WindowsImageDigest", "WHITESMITH_HYPERV_SWITCH=$HyperVSwitch"); if ($LinuxVhdx) { $envLines += "WHITESMITH_LINUX_VHDX=$LinuxVhdx", "WHITESMITH_LINUX_IMAGE_DIGEST=$LinuxImageDigest" }; [Environment]::SetEnvironmentVariable('WHITESMITH_WORKER_ENV', ($envLines -join [Environment]::NewLine), 'Machine')
Write-ChecklistStep 9 'Windows service registration'
if (Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) { Stop-Service WhitesmithWorker -Force -ErrorAction SilentlyContinue; sc.exe delete WhitesmithWorker | Out-Null }
sc.exe create WhitesmithWorker binPath= "`"$exe`" windows-worker --service" start= auto obj= LocalSystem | Out-Null
sc.exe failure WhitesmithWorker reset= 86400 actions= restart/5000/restart/30000/none/0 | Out-Null
New-NetFirewallRule -DisplayName 'Whitesmith Hyper-V guest callbacks' -Direction Inbound -Protocol TCP -LocalPort 27182 -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
Start-Service WhitesmithWorker
Write-ChecklistPass 'WhitesmithWorker installed and started'
Write-Output 'Windows worker setup complete.'
