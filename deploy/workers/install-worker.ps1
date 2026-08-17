[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = '__PUBLIC_BASE_URL__',
  [Alias('Code')][string]$JoinCode = '__JOIN_CODE__',
  [ValidateSet('vm','container')][string]$WindowsRuntime = 'vm',
  [string]$WindowsTemplatePath = '__WINDOWS_TEMPLATE_PATH__',
  [string]$WindowsTemplateDigest = '__WINDOWS_TEMPLATE_DIGEST__',
  [string]$WindowsContainerImage = 'whitesmith/windows-job:local',
  [string]$WindowsContainerBaseImage = '__WINDOWS_CONTAINER_BASE_IMAGE__',
  [string]$WindowsContainerRunnerUrl = '__WINDOWS_CONTAINER_RUNNER_URL__',
  [string]$WindowsContainerRunnerSha256 = '__WINDOWS_CONTAINER_RUNNER_SHA256__',
  [string]$WindowsContainerGitUrl = '__WINDOWS_CONTAINER_GIT_URL__',
  [string]$WindowsContainerGitSha256 = '__WINDOWS_CONTAINER_GIT_SHA256__',
  [string]$WindowsContainerVcUrl = '__WINDOWS_CONTAINER_VC_URL__',
  [string]$WindowsContainerVcSha256 = '__WINDOWS_CONTAINER_VC_SHA256__',
  [string]$WindowsContainerBuilderUrl = '__WINDOWS_CONTAINER_BUILDER_URL__',
  [string]$WindowsContainerVerifierUrl = '__WINDOWS_CONTAINER_VERIFIER_URL__',
  [string]$WindowsContainerfileUrl = '__WINDOWS_CONTAINERFILE_URL__',
  [string]$WindowsContainerEntrypointUrl = '__WINDOWS_CONTAINER_ENTRYPOINT_URL__',
  [string]$WindowsContainerJobAgentUrl = '__WINDOWS_CONTAINER_JOB_AGENT_URL__',
  [string]$WindowsContainerPrefix = 'whitesmith',
  [int]$WindowsContainerReadyTimeoutMs = 15000,
  [int]$WindowsContainerJobTimeoutMs = 900000,
  [switch]$AllowInsecureHttp,
  [switch]$AllowLocalContainerImage
)
$ErrorActionPreference = 'Stop'
$windowsImageManifestPath = 'C:\ProgramData\Whitesmith\windows-job-image.json'
function Require-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required.' }
}
function Assert-HttpsUrl([string]$Url, [string]$Name) {
  if ($Url -notmatch '^https://' -and $Url -notmatch '^http://(localhost|127\.0\.0\.1)(:\d+)?/') { throw "$Name must use HTTPS." }
}
function Assert-LocalImageManifest([string]$Path, [string]$Image) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Windows local image manifest is missing: $Path" }
  $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1) { throw 'Windows local image manifest schema is unsupported.' }
  foreach ($field in @('baseImage','runnerSha256','gitSha256','vcRuntimeSha256','jobAgentSha256','image','imageId','runtimeProbe','builtAt')) {
    if ($null -eq $manifest.$field -or [string]::IsNullOrWhiteSpace([string]$manifest.$field)) { throw "Windows local image manifest field is missing: $field" }
  }
  if ($manifest.image -ne $Image) { throw 'Windows local image manifest image mismatch.' }
  $runtimeProbe = $manifest.runtimeProbe
  if (-not $runtimeProbe -or -not $runtimeProbe.mediaFoundation -or -not $runtimeProbe.dns -or -not $runtimeProbe.tcp443) { throw 'Windows local image manifest runtime probe is not verified.' }
  $imageId = (docker image inspect --format '{{.Id}}' $Image).Trim()
  if ($LASTEXITCODE -ne 0 -or $imageId -ne $manifest.imageId) { throw 'Windows local image manifest image ID mismatch.' }
  return $manifest
}
function Assert-ImageDigest([string]$Image) {
  if ($Image -eq 'whitesmith/windows-job:local') { return }
  if ($Image -match '^[^@\s]+@sha256:[0-9a-f]{64}$') { return }
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
function Build-LocalWindowsImage([string]$Image) {
  $values = @(
    @{ Name = 'WindowsContainerBaseImage'; Value = $WindowsContainerBaseImage },
    @{ Name = 'WindowsContainerRunnerUrl'; Value = $WindowsContainerRunnerUrl },
    @{ Name = 'WindowsContainerRunnerSha256'; Value = $WindowsContainerRunnerSha256 },
    @{ Name = 'WindowsContainerGitUrl'; Value = $WindowsContainerGitUrl },
    @{ Name = 'WindowsContainerGitSha256'; Value = $WindowsContainerGitSha256 },
    @{ Name = 'WindowsContainerVcUrl'; Value = $WindowsContainerVcUrl },
    @{ Name = 'WindowsContainerVcSha256'; Value = $WindowsContainerVcSha256 },
    @{ Name = 'WindowsContainerBuilderUrl'; Value = $WindowsContainerBuilderUrl },
    @{ Name = 'WindowsContainerVerifierUrl'; Value = $WindowsContainerVerifierUrl },
    @{ Name = 'WindowsContainerfileUrl'; Value = $WindowsContainerfileUrl },
    @{ Name = 'WindowsContainerEntrypointUrl'; Value = $WindowsContainerEntrypointUrl },
    @{ Name = 'WindowsContainerJobAgentUrl'; Value = $WindowsContainerJobAgentUrl }
  )
  foreach ($value in $values) { if ([string]::IsNullOrWhiteSpace($value.Value) -or $value.Value -match '^__') { throw "Windows container build input is not configured: $($value.Name)" } }
  foreach ($value in @($WindowsContainerBuilderUrl, $WindowsContainerVerifierUrl, $WindowsContainerfileUrl, $WindowsContainerEntrypointUrl, $WindowsContainerJobAgentUrl)) { Assert-HttpsUrl $value 'Windows container artifact URL' }
  $root = Join-Path $env:ProgramData 'Whitesmith\image-build-inputs'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $builder = Join-Path $root 'build-local.ps1'
  $verifier = Join-Path $root 'verify-runtime.ps1'
  $containerfile = Join-Path $root 'Containerfile'
  $entrypoint = Join-Path $root 'entrypoint.ps1'
  $jobAgent = Join-Path $root 'whitesmith-job-agent.exe'
  Invoke-WebRequest -Uri $WindowsContainerBuilderUrl -OutFile $builder -UseBasicParsing -TimeoutSec 300
  Invoke-WebRequest -Uri $WindowsContainerVerifierUrl -OutFile $verifier -UseBasicParsing -TimeoutSec 300
  Invoke-WebRequest -Uri $WindowsContainerfileUrl -OutFile $containerfile -UseBasicParsing -TimeoutSec 300
  Invoke-WebRequest -Uri $WindowsContainerEntrypointUrl -OutFile $entrypoint -UseBasicParsing -TimeoutSec 300
  Invoke-WebRequest -Uri $WindowsContainerJobAgentUrl -OutFile $jobAgent -UseBasicParsing -TimeoutSec 300
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $builder `
    -BaseImage $WindowsContainerBaseImage -RunnerUrl $WindowsContainerRunnerUrl -RunnerSha256 $WindowsContainerRunnerSha256 `
    -GitUrl $WindowsContainerGitUrl -GitSha256 $WindowsContainerGitSha256 -VcRuntimeUrl $WindowsContainerVcUrl `
    -VcRuntimeSha256 $WindowsContainerVcSha256 -JobAgent $jobAgent -Image $Image -ManifestPath $windowsImageManifestPath `
    -VerifierPath $verifier -ContainerfilePath $containerfile -EntrypointPath $entrypoint
  if ($LASTEXITCODE -ne 0) { throw "Local Windows image build failed with exit code $LASTEXITCODE." }
  Assert-LocalImageManifest $windowsImageManifestPath $Image | Out-Null
}
function Ensure-WindowsContainerRuntime([string]$Image, [string]$Prefix) {
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Engine is required.' }
  if ((docker info --format '{{.OSType}}') -ne 'windows') { throw 'Docker must be running the Windows engine.' }
  if ($Image -eq 'whitesmith/windows-job:local') {
    Build-LocalWindowsImage $Image
  } else {
    $digests = @(docker image inspect --format '{{json .RepoDigests}}' $Image | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0 -or -not ($digests -contains $Image)) { throw "Digest-pinned Windows image is not present locally: $Image" }
  }
  $name = "$Prefix-install-probe-$([guid]::NewGuid().ToString('N'))"
  try {
    docker create --name $name --entrypoint powershell.exe --isolation=hyperv --label whitesmith.managed=true --label "whitesmith.lease-id=$([guid]::NewGuid())" $Image -NoLogo -NoProfile -NonInteractive -File C:\Whitesmith\verify-runtime.ps1 -RequireNetwork | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Hyper-V container probe.' }
    docker start $name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start the Hyper-V container probe.' }
    $inspection = @(docker inspect $name | ConvertFrom-Json)
    if ($inspection[0].HostConfig.Isolation -ne 'hyperv') { throw 'Docker did not enforce Hyper-V isolation.' }
    $exitCode = [int](docker wait $name)
    if ($LASTEXITCODE -ne 0) { throw 'Failed waiting for the Hyper-V container probe.' }
    if ($exitCode -ne 0) {
      $logs = ((docker logs $name 2>&1) -join ' ') -replace '\s+', ' '
      if ($logs.Length -gt 2000) { $logs = $logs.Substring(0, 2000) }
      throw "Windows container runtime prerequisite probe failed with exit code ${exitCode}: $logs"
    }
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
$root = 'C:\ProgramData\Whitesmith'; $bin = 'C:\Program Files\Whitesmith'; $identityPath = Join-Path $root 'worker-identity.json'
Write-Host '[5/8] Preparing worker directories'
New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
$existingService = Get-Service WhitesmithWorker -ErrorAction SilentlyContinue
$existingInstall = $existingService -or (Test-Path -LiteralPath $identityPath)
if ($existingInstall) { Write-Host 'Existing Windows worker installation detected; reinstalling.' }
if ($existingService) {
  Stop-Service WhitesmithWorker -Force -ErrorAction SilentlyContinue
  $serviceDelete = & sc.exe delete WhitesmithWorker 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to remove existing WhitesmithWorker service: $($serviceDelete -join ' ')" }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Get-Service WhitesmithWorker -ErrorAction SilentlyContinue) { throw 'Timed out removing existing WhitesmithWorker service.' }
}
if ($existingInstall -and (Test-Path -LiteralPath $identityPath)) { Remove-Item -LiteralPath $identityPath -Force }
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
  $serviceEnvironment += "WHITESMITH_WINDOWS_CONTAINER_IMAGE_MANIFEST=$windowsImageManifestPath"
  if ($AllowLocalContainerImage -or $WindowsContainerImage -eq 'whitesmith/windows-job:local') { $serviceEnvironment += "WHITESMITH_ALLOW_LOCAL_CONTAINER_IMAGE=true" }
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
