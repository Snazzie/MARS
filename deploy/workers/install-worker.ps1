[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = '__PUBLIC_BASE_URL__',
  [Alias('Code')][string]$JoinCode = '__JOIN_CODE__',
  [string]$WindowsTemplatePath = '__WINDOWS_TEMPLATE_PATH__',
  [string]$WindowsTemplateDigest = '__WINDOWS_TEMPLATE_DIGEST__',
  [string]$LinuxTemplatePath = '__LINUX_TEMPLATE_PATH__',
  [string]$LinuxTemplateDigest = '__LINUX_TEMPLATE_DIGEST__',
  [switch]$AllowInsecureHttp
)
$ErrorActionPreference = 'Stop'
function Require-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required.' }
}
function Assert-Digest([string]$Digest) {
  if ($Digest -notmatch '^sha256:[0-9a-fA-F]{64}$') { throw "Template digest must be sha256:hex: $Digest" }
}
function Assert-Template([string]$Path, [string]$Digest, [string]$Platform) {
  if ($Path -match '^__' -or $Digest -match '^__') { throw "$Platform Hyper-V template is not configured." }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Platform Hyper-V template is missing: $Path" }
  Assert-Digest $Digest
  $actual = 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Digest.ToLowerInvariant()) { throw "$Platform Hyper-V template checksum mismatch: expected $Digest, got $actual" }
}
function Ensure-HyperV {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
  if ($feature.State -ne 'Enabled') { throw 'Microsoft-Hyper-V-All must be enabled.' }
  if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V PowerShell cmdlets are required.' }
  if (-not (Get-VMHost -ErrorAction SilentlyContinue)) { throw 'Hyper-V host is unavailable.' }
}
function Ensure-ControlPlane {
  if ($ControlPlaneUrl -notmatch '^https://' -and -not ($AllowInsecureHttp -and $ControlPlaneUrl -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$')) { throw 'Control-plane URL must use HTTPS.' }
  Invoke-WebRequest -Uri $ControlPlaneUrl -Method Get -UseBasicParsing -TimeoutSec 30 | Out-Null
}
Require-Administrator
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
Ensure-HyperV
Ensure-ControlPlane
Assert-Template $WindowsTemplatePath $WindowsTemplateDigest 'Windows'
if ($LinuxTemplatePath -notmatch '^__' -or $LinuxTemplateDigest -notmatch '^__') { Assert-Template $LinuxTemplatePath $LinuxTemplateDigest 'Linux' }
$root = 'C:\ProgramData\Whitesmith'; $bin = 'C:\Program Files\Whitesmith'
New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'join-code'), $JoinCode)
$acl = Get-Acl $root; $acl.SetAccessRuleProtection($true,$false); Set-Acl $root $acl
$exe = Join-Path $bin 'whitesmith-orchestrator.exe'
Invoke-WebRequest -Uri "$ControlPlaneUrl/api/workers/orchestrator?audience=windows-x64" -OutFile $exe
[Environment]::SetEnvironmentVariable('WHITESMITH_CONTROL_PLANE_URL', $ControlPlaneUrl, 'Machine')
[Environment]::SetEnvironmentVariable('WHITESMITH_JOIN_CODE_FILE', (Join-Path $root 'join-code'), 'Machine')
[Environment]::SetEnvironmentVariable('WHITESMITH_WINDOWS_TEMPLATE_PATH', $WindowsTemplatePath, 'Machine')
[Environment]::SetEnvironmentVariable('WHITESMITH_WINDOWS_TEMPLATE_DIGEST', $WindowsTemplateDigest, 'Machine')
if (Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) { Stop-Service WhitesmithWorker -Force -ErrorAction SilentlyContinue; sc.exe delete WhitesmithWorker | Out-Null }
sc.exe create WhitesmithWorker binPath= "`"$exe`" windows-worker --service" start= auto obj= LocalSystem | Out-Null
sc.exe failure WhitesmithWorker reset= 86400 actions= restart/5000/restart/30000/none/0 | Out-Null
Start-Service WhitesmithWorker
Write-Output 'Windows Hyper-V worker setup complete.'
