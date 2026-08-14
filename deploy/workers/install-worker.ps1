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
  $localHttp = $ControlPlaneUrl -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$'
  if ($ControlPlaneUrl -notmatch '^https://' -and -not $localHttp -and -not $AllowInsecureHttp) { throw 'Control-plane URL must use HTTPS.' }
  Invoke-WebRequest -Uri $ControlPlaneUrl -Method Get -UseBasicParsing -TimeoutSec 30 | Out-Null
}
Write-Host '[1/8] Checking administrator privileges'
Require-Administrator
Write-Host '[2/8] Checking Windows and Hyper-V'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
Ensure-HyperV
Write-Host '[3/8] Checking control-plane connectivity'
Ensure-ControlPlane
Write-Host '[4/8] Verifying Windows template and checksum'
Assert-Template $WindowsTemplatePath $WindowsTemplateDigest 'Windows'
if ($LinuxTemplatePath -and $LinuxTemplateDigest) { Assert-Template $LinuxTemplatePath $LinuxTemplateDigest 'Linux' }
$root = 'C:\ProgramData\Whitesmith'; $bin = 'C:\Program Files\Whitesmith'
Write-Host '[5/8] Preparing worker directories'
New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
$joinCodePath = Join-Path $root 'join-code'
[IO.File]::WriteAllText($joinCodePath, $JoinCode)
$joinCodeAcl = & icacls.exe $joinCodePath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' 2>&1
if ($LASTEXITCODE -ne 0) { throw "Failed to secure worker join credential: $($joinCodeAcl -join ' ')" }
$exe = Join-Path $bin 'whitesmith-orchestrator.exe'
Write-Host '[6/8] Downloading Windows worker runtime'
Invoke-WebRequest -Uri "$ControlPlaneUrl/api/workers/orchestrator?audience=windows-x64" -OutFile $exe -TimeoutSec 120
[Environment]::SetEnvironmentVariable('WHITESMITH_CONTROL_PLANE_URL', $ControlPlaneUrl, 'Machine')
[Environment]::SetEnvironmentVariable('WHITESMITH_JOIN_CODE_FILE', (Join-Path $root 'join-code'), 'Machine')
[Environment]::SetEnvironmentVariable('WHITESMITH_WINDOWS_TEMPLATE_PATH', $WindowsTemplatePath, 'Machine')
[Environment]::SetEnvironmentVariable('WHITESMITH_WINDOWS_TEMPLATE_DIGEST', $WindowsTemplateDigest, 'Machine')
Write-Host '[7/8] Registering LocalSystem worker service'
if (Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) { Stop-Service WhitesmithWorker -Force -ErrorAction SilentlyContinue; & sc.exe delete WhitesmithWorker | Out-Null; if ($LASTEXITCODE -ne 0) { throw "Failed to remove existing WhitesmithWorker service." } }
$service = New-Service -Name WhitesmithWorker -BinaryPathName "`"$exe`" windows-worker --service" -StartupType Automatic -ErrorAction Stop
$serviceFailure = & sc.exe failure WhitesmithWorker "reset= 86400" "actions= restart/5000/restart/30000/none/0" 2>&1
if ($LASTEXITCODE -ne 0) { throw "Failed to configure WhitesmithWorker recovery: $($serviceFailure -join ' ')" }
Get-Service WhitesmithWorker -ErrorAction Stop | Out-Null
Write-Host '[8/8] Starting Whitesmith worker service'
Start-Service WhitesmithWorker
Write-Output 'Windows Hyper-V worker setup complete.'
