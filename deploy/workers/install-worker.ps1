[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = '__PUBLIC_BASE_URL__',
  [Alias('Code')][string]$JoinCode = '__JOIN_CODE__',
  [ValidateSet('vm','container')][string]$WindowsRuntime = 'vm',
  [string]$WindowsTemplatePath = '__WINDOWS_TEMPLATE_PATH__',
  [string]$WindowsTemplateDigest = '__WINDOWS_TEMPLATE_DIGEST__',
  [string]$WindowsContainerImage = '__WINDOWS_CONTAINER_IMAGE__',
  [string]$WindowsContainerPrefix = 'whitesmith',
  [int]$WindowsContainerReadyTimeoutMs = 15000,
  [int]$WindowsContainerJobTimeoutMs = 900000,
  [switch]$AllowInsecureHttp,
  [switch]$AllowLocalContainerImage
)
$ErrorActionPreference = 'Stop'
function Require-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required.' }
}
function Assert-ImageDigest([string]$Image) {
  if ($Image -match '^[^@\s]+@sha256:[0-9a-f]{64}$') { return }
  if ($AllowLocalContainerImage -and $Image -eq 'whitesmith/windows-job:local' -and (docker image inspect $Image 2>$null)) { return }
  throw "Windows container image must be a full lowercase digest reference: $Image"
}
function Assert-Digest([string]$Digest) {
  if ($Digest -notmatch '^sha256:[0-9a-fA-F]{64}$') { throw "Template digest must be sha256:hex: $Digest" }
}
function Assert-Template([string]$Path, [string]$Digest) {
  if ($Path -match '^__' -or $Digest -match '^__') { throw 'Windows Hyper-V template is not configured.' }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Windows Hyper-V template is missing: $Path" }
  Assert-Digest $Digest
  $actual = 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Digest.ToLowerInvariant()) { throw "Windows Hyper-V template checksum mismatch: expected $Digest, got $actual" }
}
function Ensure-HyperV {
  $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
  if ($feature.State -ne 'Enabled') { throw 'Microsoft-Hyper-V-All must be enabled.' }
  if (-not (Get-VMHost -ErrorAction SilentlyContinue)) { throw 'Hyper-V host is unavailable.' }
}
function Ensure-WindowsContainerRuntime([string]$Image, [string]$Prefix) {
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Engine is required.' }
  if ((docker info --format '{{.OSType}}') -ne 'windows') { throw 'Docker must be running the Windows engine.' }
  if ($AllowLocalContainerImage -and $Image -eq 'whitesmith/windows-job:local') {
    docker image inspect $Image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Local Windows image is not present: $Image" }
  } else {
    $digests = @(docker image inspect --format '{{json .RepoDigests}}' $Image | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0 -or -not ($digests -contains $Image)) { throw "Digest-pinned Windows image is not present locally: $Image" }
  }
  $name = "$Prefix-install-probe-$([guid]::NewGuid().ToString('N'))"
  try {
    docker create --name $name --isolation=hyperv --label whitesmith.managed=true --label "whitesmith.lease-id=$([guid]::NewGuid())" $Image cmd /c exit 0 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Hyper-V container probe.' }
    docker start $name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start the Hyper-V container probe.' }
    $inspection = @(docker inspect $name | ConvertFrom-Json)
    if ($inspection[0].HostConfig.Isolation -ne 'hyperv') { throw 'Docker did not enforce Hyper-V isolation.' }
    docker wait $name | Out-Null
  } finally {
    docker rm -f $name 2>$null | Out-Null
  }
}
function Ensure-ContainerFeatures {
  $containers = Get-WindowsOptionalFeature -Online -FeatureName Containers -ErrorAction SilentlyContinue
  if ($containers.State -ne 'Enabled') { throw 'Containers Windows feature must be enabled.' }
  $hyperv = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
  if ($hyperv.State -ne 'Enabled') { throw 'Microsoft-Hyper-V-All must be enabled.' }
  if (-not (Get-VMHost -ErrorAction SilentlyContinue)) { throw 'Hyper-V host is unavailable.' }
}
function Ensure-ControlPlane {
  $localHttp = $ControlPlaneUrl -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$'
  if ($ControlPlaneUrl -notmatch '^https://' -and -not $localHttp -and -not $AllowInsecureHttp) { throw 'Control-plane URL must use HTTPS.' }
  Invoke-WebRequest -Uri $ControlPlaneUrl -Method Get -UseBasicParsing -TimeoutSec 30 | Out-Null
}
Write-Host '[1/8] Checking administrator privileges'
Require-Administrator
Write-Host "[2/8] Checking Windows $WindowsRuntime runtime"
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
if ($WindowsRuntime -eq 'container') {
  Ensure-ContainerFeatures
  Assert-ImageDigest $WindowsContainerImage
  Ensure-WindowsContainerRuntime $WindowsContainerImage $WindowsContainerPrefix
} else {
  Ensure-HyperV
  Assert-Template $WindowsTemplatePath $WindowsTemplateDigest
}
Write-Host '[3/8] Checking control-plane connectivity'
Ensure-ControlPlane
if ($JoinCode -match '^__') { throw 'Join code is not configured.' }
$root = 'C:\ProgramData\Whitesmith'; $bin = 'C:\Program Files\Whitesmith'
Write-Host '[5/8] Preparing worker directories'
New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
$joinCodePath = Join-Path $root 'join-code'
[IO.File]::WriteAllText($joinCodePath, $JoinCode)
$joinCodeAcl = & icacls.exe $joinCodePath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' 2>&1
if ($LASTEXITCODE -ne 0) { throw "Failed to secure worker join credential: $($joinCodeAcl -join ' ')" }
$exe = Join-Path $bin 'whitesmith-orchestrator.exe'
$serviceHost = Join-Path $bin 'whitesmith-service-host.exe'
$stagedExe = Join-Path $root 'whitesmith-orchestrator.download'
$stagedServiceHost = Join-Path $root 'whitesmith-service-host.download'
Write-Host '[6/8] Downloading Windows worker runtime and service host'
Invoke-WebRequest -Uri "$ControlPlaneUrl/api/workers/orchestrator?audience=windows-x64" -OutFile $stagedExe -TimeoutSec 120
Invoke-WebRequest -Uri "$ControlPlaneUrl/api/workers/service-host?audience=windows-x64" -OutFile $stagedServiceHost -TimeoutSec 120
Write-Host '[7/8] Registering LocalSystem worker service'
if (Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) {
  Stop-Service WhitesmithWorker -Force -ErrorAction SilentlyContinue
  $serviceDelete = & sc.exe delete WhitesmithWorker 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to remove existing WhitesmithWorker service: $($serviceDelete -join ' ')" }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) { throw 'Timed out removing existing WhitesmithWorker service.' }
}
Move-Item -LiteralPath $stagedExe -Destination $exe -Force
Move-Item -LiteralPath $stagedServiceHost -Destination $serviceHost -Force
$workerLogPath = Join-Path $root 'logs\worker.log'
$previousWorkerLogPath = Join-Path $root 'logs\worker.previous.log'
if (Test-Path -LiteralPath $workerLogPath) { Move-Item -LiteralPath $workerLogPath -Destination $previousWorkerLogPath -Force }
$service = New-Service -Name WhitesmithWorker -BinaryPathName "`"$serviceHost`" `"$exe`" windows-worker" -StartupType Automatic -ErrorAction Stop
$serviceEnvironment = @(
  "WHITESMITH_CONTROL_PLANE_URL=$ControlPlaneUrl"
  "WHITESMITH_JOIN_CODE_FILE=$joinCodePath"
  "WHITESMITH_WINDOWS_RUNTIME=$WindowsRuntime"
)
if ($WindowsRuntime -eq 'container') {
  $serviceEnvironment += "WHITESMITH_WINDOWS_CONTAINER_IMAGE=$WindowsContainerImage"
  $serviceEnvironment += "WHITESMITH_WINDOWS_CONTAINER_PREFIX=$WindowsContainerPrefix"
  $serviceEnvironment += "WHITESMITH_WINDOWS_CONTAINER_READY_TIMEOUT_MS=$WindowsContainerReadyTimeoutMs"
  $serviceEnvironment += "WHITESMITH_WINDOWS_CONTAINER_JOB_TIMEOUT_MS=$WindowsContainerJobTimeoutMs"
} else {
  $serviceEnvironment += "WHITESMITH_WINDOWS_TEMPLATE_PATH=$WindowsTemplatePath"
  $serviceEnvironment += "WHITESMITH_WINDOWS_TEMPLATE_DIGEST=$WindowsTemplateDigest"
}
$serviceRegistryPath = 'HKLM:\SYSTEM\CurrentControlSet\Services\WhitesmithWorker'
New-ItemProperty -Path $serviceRegistryPath -Name Environment -PropertyType MultiString -Value $serviceEnvironment -Force | Out-Null
$serviceFailure = & sc.exe failure WhitesmithWorker "reset= 86400" "actions= restart/5000/restart/30000/none/0" 2>&1
if ($LASTEXITCODE -ne 0) { throw "Failed to configure WhitesmithWorker recovery: $($serviceFailure -join ' ')" }
Get-Service WhitesmithWorker -ErrorAction Stop | Out-Null
Write-Host '[8/8] Starting Whitesmith worker service'
try {
  Start-Service WhitesmithWorker -ErrorAction Stop
  $service = Get-Service WhitesmithWorker -ErrorAction Stop
  $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
  Start-Sleep -Seconds 2
  $service.Refresh()
  if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) { throw "WhitesmithWorker stopped immediately with status $($service.Status)." }
} catch {
  $startupError = $_.Exception.Message
  $recoveryDeadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 500
    $currentService = Get-Service WhitesmithWorker -ErrorAction SilentlyContinue
  } while ($currentService -and $currentService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running -and (Get-Date) -lt $recoveryDeadline)
  if ($currentService -and $currentService.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) {
    Write-Warning "WhitesmithWorker recovered after initial startup failure: $startupError"
  } else {
    $events = Get-WinEvent -FilterHashtable @{ LogName='System'; ProviderName='Service Control Manager'; StartTime=(Get-Date).AddMinutes(-5) } -ErrorAction SilentlyContinue |
      Where-Object Message -Match 'WhitesmithWorker' | Select-Object -First 5 | ForEach-Object { "[$($_.Id)] $($_.Message)" }
    $workerLog = if (Test-Path -LiteralPath $workerLogPath) { (Get-Content -LiteralPath $workerLogPath -Tail 50 -ErrorAction SilentlyContinue) -join [Environment]::NewLine } else { 'Worker log not created.' }
    throw "WhitesmithWorker failed to reach Running.`nStartup error: $startupError`nSCM events:`n$($events -join [Environment]::NewLine)`nWorker log:`n$workerLog"
  }
}
Write-Output "Windows $WindowsRuntime worker setup complete."
