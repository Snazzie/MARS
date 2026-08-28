[CmdletBinding()]
param(
[string]$ControlPlaneUrl = '__PUBLIC_BASE_URL__',
[Alias('Code')][string]$JoinCode = '__JOIN_CODE__',
[string]$JoinCodeFile = 'C:\ProgramData\Mars\join-code',
  [ValidateSet('vm','container')][string]$WindowsRuntime = 'vm',
[string]$WindowsOrchestratorSha256 = '__WINDOWS_ORCHESTRATOR_SHA256__',
[string]$WindowsServiceHostSha256 = '__WINDOWS_SERVICE_HOST_SHA256__',
  [string]$WindowsTemplateUrl = '__WINDOWS_TEMPLATE_URL__',
  [string]$WindowsTemplatePath = '__WINDOWS_TEMPLATE_PATH__',
  [string]$WindowsTemplateDigest = '__WINDOWS_TEMPLATE_DIGEST__',
  [string]$WindowsContainerImage = '__WINDOWS_CONTAINER_IMAGE__',
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
  [string]$WindowsContainerPrefix = 'mars',
  [int]$WindowsContainerReadyTimeoutMs = 15000,
  [int]$WindowsContainerJobTimeoutMs = 900000,
  [switch]$AllowInsecureHttp,
  [switch]$AllowLocalContainerImage,
  [switch]$Upgrade
)
$ErrorActionPreference = 'Stop'
$windowsImageManifestPath = 'C:\ProgramData\Mars\windows-job-image.json'
function Require-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required.' }
}
function Assert-HttpsUrl([string]$Url, [string]$Name) {
  if ($Url -notmatch '^https://' -and $Url -notmatch '^http://(localhost|127\.0\.0\.1)(:\d+)?/') { throw "$Name must use HTTPS." }
}
function Assert-StrictHttpsUrl([string]$Url, [string]$Name) {
  if ($Url -notmatch '^https://') { throw "$Name must use HTTPS." }
}
function Write-State([string]$Stage, [string]$Status) {
  $statePath = 'C:\ProgramData\Mars\install-state.json'
  New-Item -ItemType Directory -Force -Path (Split-Path $statePath) | Out-Null
  [ordered]@{ stage = $Stage; status = $Status; updatedAt = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -Encoding utf8
}
function Install-DockerDesktop {
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'winget is required to install Docker Desktop.' }
    winget install --id Docker.DockerDesktop --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Docker Desktop installation failed with exit code $LASTEXITCODE." }
  }
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Get-Command docker.exe -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Desktop did not install.' }
}
function Switch-DockerWindowsEngine {
  $dockerCli = Join-Path ${env:ProgramFiles} 'Docker\Docker\DockerCli.exe'
  if (-not (Test-Path -LiteralPath $dockerCli)) { throw 'DockerCli.exe is required to switch Docker Desktop to the Windows engine.' }
  & $dockerCli -SwitchWindowsEngine
  if ($LASTEXITCODE -ne 0) { throw "Docker Desktop Windows engine switch failed with exit code $LASTEXITCODE." }
  $deadline = (Get-Date).AddMinutes(3)
  do {
    try { $engine = (docker info --format '{{.OSType}}' 2>$null).Trim() } catch { $engine = '' }
    if ($engine -eq 'windows') { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'Docker Desktop did not become ready on the Windows engine.'
}
function Assert-HostPreflight {
  $os = Get-CimInstance Win32_OperatingSystem
  if ($os.Caption -notmatch '^Microsoft Windows 11 (Pro|Enterprise)') { throw 'Windows 11 Pro or Enterprise is required.' }
  if ([int]$os.BuildNumber -lt 26100) { throw 'Windows 11 24H2 (build 26100 or newer) is required.' }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  if (-not $cpu.VirtualizationFirmwareEnabled -or -not $cpu.SecondLevelAddressTranslationExtensions) { throw 'hardware virtualization is required.' }
  $localHttp = $ControlPlaneUrl -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$'
  if ($ControlPlaneUrl -notmatch '^https://' -and -not $localHttp -and -not $AllowInsecureHttp) { throw 'Control-plane URL must use HTTPS.' }
  Invoke-WebRequest -Uri "$ControlPlaneUrl/api/healthz" -Method Get -UseBasicParsing -TimeoutSec 30 | Out-Null
  $joinFileExists = Test-Path -LiteralPath $JoinCodeFile
  if ($JoinCode -match '^__' -or [string]::IsNullOrWhiteSpace($JoinCode)) {
    if (-not $joinFileExists) { throw 'Join code is not configured.' }
  } elseif ($JoinCode -notmatch '^[A-Za-z0-9_-]{43}$') {
    throw 'Join code is not configured.'
  }
}
function Quote-TaskArgument([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}
function Register-ResumeTask {
  param([string]$ScriptPath)
  $resumeParameters = @(
    '-ControlPlaneUrl', $ControlPlaneUrl,
    '-JoinCodeFile', $JoinCodeFile,
    '-WindowsRuntime', $WindowsRuntime,
    '-WindowsOrchestratorSha256', $WindowsOrchestratorSha256,
    '-WindowsServiceHostSha256', $WindowsServiceHostSha256,
    '-WindowsTemplateUrl', $WindowsTemplateUrl,
    '-WindowsTemplatePath', $WindowsTemplatePath,
    '-WindowsTemplateDigest', $WindowsTemplateDigest,
    '-WindowsContainerImage', $WindowsContainerImage,
    '-WindowsContainerBaseImage', $WindowsContainerBaseImage,
    '-WindowsContainerRunnerUrl', $WindowsContainerRunnerUrl,
    '-WindowsContainerRunnerSha256', $WindowsContainerRunnerSha256,
    '-WindowsContainerGitUrl', $WindowsContainerGitUrl,
    '-WindowsContainerGitSha256', $WindowsContainerGitSha256,
    '-WindowsContainerVcUrl', $WindowsContainerVcUrl,
    '-WindowsContainerVcSha256', $WindowsContainerVcSha256,
    '-WindowsContainerBuilderUrl', $WindowsContainerBuilderUrl,
    '-WindowsContainerVerifierUrl', $WindowsContainerVerifierUrl,
    '-WindowsContainerfileUrl', $WindowsContainerfileUrl,
    '-WindowsContainerEntrypointUrl', $WindowsContainerEntrypointUrl,
    '-WindowsContainerJobAgentUrl', $WindowsContainerJobAgentUrl,
    '-WindowsContainerPrefix', $WindowsContainerPrefix,
    '-WindowsContainerReadyTimeoutMs', $WindowsContainerReadyTimeoutMs,
    '-WindowsContainerJobTimeoutMs', $WindowsContainerJobTimeoutMs
  )
  if ($AllowInsecureHttp) { $resumeParameters += '-AllowInsecureHttp' }
  if ($AllowLocalContainerImage) { $resumeParameters += '-AllowLocalContainerImage' }
  if ($Upgrade) { $resumeParameters += '-Upgrade' }
  $argumentText = ($resumeParameters | ForEach-Object { Quote-TaskArgument ([string]$_) }) -join ' '
  $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File $(Quote-TaskArgument $ScriptPath) $argumentText"
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName 'MarsWorkerInstallResume' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
}
function Remove-ResumeTask {
  Unregister-ScheduledTask -TaskName 'MarsWorkerInstallResume' -Confirm:$false -ErrorAction SilentlyContinue
}
function Resolve-CachePort([string]$Name, [int]$DefaultPort) {
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultPort }
  $port = 0
  if (-not [int]::TryParse($raw, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "$Name must be an integer between 1 and 65535."
  }
  return $port
}
function Assert-LocalImageManifest([string]$Path, [string]$Image) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Windows local image manifest is missing: $Path" }
  $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1) { throw 'Windows local image manifest schema is unsupported.' }
  foreach ($field in @('image','imageId','runtimeProbe','builtAt')) {
    if ($null -eq $manifest.$field -or [string]::IsNullOrWhiteSpace([string]$manifest.$field)) { throw "Windows local image manifest field is missing: $field" }
  }
  if ($manifest.image -ne $Image) { throw 'Windows local image manifest image mismatch.' }
  $runtimeProbe = $manifest.runtimeProbe
  $expectedEntrypoint = @('powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:/Mars/entrypoint.ps1') | ConvertTo-Json -Compress
  $imageInspection = (docker image inspect --format '{{json .}}' $Image | Select-Object -Last 1 | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or ($imageInspection.Config.Entrypoint | ConvertTo-Json -Compress) -ne $expectedEntrypoint) { throw 'Windows image entrypoint is invalid.' }
  $imageId = $imageInspection.Id
  if (-not $imageId -or $imageId -ne $manifest.imageId) { throw 'Windows local image manifest image ID mismatch.' }
  return $manifest
}
function Assert-ImageDigest([string]$Image) {
  if ($Image -eq 'mars/windows-job:local') { return }
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
function Download-Template {
  if ($WindowsTemplateUrl -match '^__' -or $WindowsTemplatePath -match '^__') { throw 'Windows Hyper-V template is not configured.' }
  Assert-StrictHttpsUrl $WindowsTemplateUrl 'Windows Hyper-V template URL'
  Assert-Digest $WindowsTemplateDigest
  $parent = Split-Path -Parent $WindowsTemplatePath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $staged = "$WindowsTemplatePath.download.$([guid]::NewGuid().ToString('N'))"
  try {
    Invoke-WebRequest -Uri $WindowsTemplateUrl -OutFile $staged -UseBasicParsing -TimeoutSec 900
    $actual = 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $staged).Hash.ToLowerInvariant()
    if ($actual -ne $WindowsTemplateDigest.ToLowerInvariant()) { throw "Windows Hyper-V template checksum mismatch: expected $WindowsTemplateDigest, got $actual" }
    Move-Item -LiteralPath $staged -Destination $WindowsTemplatePath -Force
  } finally {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
  }
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
  $root = Join-Path $env:ProgramData 'Mars\image-build-inputs'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $builder = Join-Path $root 'build-local.ps1'
  $verifier = Join-Path $root 'verify-runtime.ps1'
  $containerfile = Join-Path $root 'Containerfile'
  $entrypoint = Join-Path $root 'entrypoint.ps1'
  $jobAgent = Join-Path $root 'mars-job-agent.exe'
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
  if ($Image -eq 'mars/windows-job:local') {
    Build-LocalWindowsImage $Image
  } else {
    $digests = @(docker image inspect --format '{{json .RepoDigests}}' $Image | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0 -or -not ($digests -contains $Image)) { throw "Digest-pinned Windows image is not present locally: $Image" }
  }
  $name = "$Prefix-install-probe-$([guid]::NewGuid().ToString('N'))"
  try {
    docker create --name $name --entrypoint powershell.exe --isolation=hyperv --label mars.managed=true --label "mars.lease-id=$([guid]::NewGuid())" $Image -NoLogo -NoProfile -NonInteractive -File C:\Mars\verify-runtime.ps1 -RequireNetwork | Out-Null
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
  $restart = $false
  $features = @('Microsoft-Hyper-V-All')
  if ($WindowsRuntime -eq 'container') { $features += 'Containers' }
  foreach ($featureName in $features) {
    $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName -ErrorAction SilentlyContinue
    if ($feature.State -ne 'Enabled') {
      $result = Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart
      if ($result.RestartNeeded) { $restart = $true }
    }
  }
  if ($restart) { return $true }
  if (-not (Get-VMHost -ErrorAction SilentlyContinue)) { throw 'Hyper-V host is unavailable.' }
  return $false
}
function Ensure-ControlPlane {
  $localHttp = $ControlPlaneUrl -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$'
  if ($ControlPlaneUrl -notmatch '^https://' -and -not $localHttp -and -not $AllowInsecureHttp) { throw 'Control-plane URL must use HTTPS.' }
  Invoke-WebRequest -Uri "$ControlPlaneUrl/api/healthz" -Method Get -UseBasicParsing -TimeoutSec 30 | Out-Null
}
function Verify-DownloadedFile([string]$Path, [string]$Expected, [string]$Name, $Response) {
  if ($Expected -match '^__' -or $Expected -notmatch '^[0-9a-f]{64}$') { throw "$Name SHA-256 is not configured." }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "$Name checksum mismatch: expected $Expected, got $actual" }
  $responseHash = if ($Response -and $Response.Headers['X-Content-SHA256']) { [string]$Response.Headers['X-Content-SHA256'] } else { '' }
  if ($responseHash -and $responseHash -ne $Expected) { throw "$Name response hash mismatch." }
}

Write-Host '[1/8] Checking administrator privileges'
Require-Administrator
Write-Host '[2/8] Checking Windows 11 Pro/Enterprise 24H2 x64 host'
Assert-HostPreflight
$root = 'C:\ProgramData\Mars'; $bin = 'C:\Program Files\Mars'; $identityPath = Join-Path $root 'worker-identity.json'
New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
$transcriptStarted = $false
try { Start-Transcript -LiteralPath (Join-Path $root 'install.log') -Append | Out-Null; $transcriptStarted = $true } catch { Write-Warning "Unable to start persistent installer log: $($_.Exception.Message)" }
if (([string]::IsNullOrWhiteSpace($JoinCode) -or $JoinCode -match '^__') -and (Test-Path -LiteralPath $JoinCodeFile)) { $JoinCode = (Get-Content -LiteralPath $JoinCodeFile -Raw).Trim() }
if (-not $Upgrade) {
  $joinCodePath = $JoinCodeFile
  if (-not (Test-Path -LiteralPath $joinCodePath)) {
    [IO.File]::WriteAllText($joinCodePath, $JoinCode)
    $joinCodeAcl = & icacls.exe $joinCodePath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed to secure worker join credential: $($joinCodeAcl -join ' ')" }
  }
}
Write-State 'preflight' 'complete'
Write-Host "[3/8] Checking $WindowsRuntime runtime and installing prerequisites"
if (Ensure-ContainerFeatures) {
  Register-ResumeTask $PSCommandPath
  Write-State 'reboot-required' 'pending'
  Write-Host 'Windows features require a reboot; MarsWorkerInstallResume will continue automatically.'
  Restart-Computer -Force
  exit 0
}
Install-DockerDesktop
Switch-DockerWindowsEngine
if ($WindowsRuntime -eq 'container') {
  Assert-ImageDigest $WindowsContainerImage
  if ($Upgrade) {
    Write-Host 'Upgrade mode: preserving the worker-local runtime state.'
    Assert-LocalImageManifest $windowsImageManifestPath $WindowsContainerImage | Out-Null
  } elseif ($AllowLocalContainerImage -and (Test-Path -LiteralPath $windowsImageManifestPath)) {
    try { Assert-LocalImageManifest $windowsImageManifestPath $WindowsContainerImage | Out-Null }
    catch { Write-Warning 'Existing local Windows image state is stale; rebuilding the verified image.'; Ensure-WindowsContainerRuntime $WindowsContainerImage $WindowsContainerPrefix }
  } else {
    Ensure-WindowsContainerRuntime $WindowsContainerImage $WindowsContainerPrefix
  }
} else {
  Ensure-HyperV
  Download-Template
  Assert-Template $WindowsTemplatePath $WindowsTemplateDigest
}
Write-State 'prerequisites' 'complete'
Write-Host '[4/8] Checking control-plane connectivity'
Ensure-ControlPlane
if (-not $Upgrade -and $JoinCode -match '^__') { throw 'Join code is not configured.' }
$existingService = Get-Service MarsWorker -ErrorAction SilentlyContinue
$existingInstall = $existingService -or (Test-Path -LiteralPath $identityPath)
if ($Upgrade -and -not (Test-Path -LiteralPath $identityPath)) { throw 'Upgrade requires an existing worker identity.' }
if ($existingInstall) { Write-Host 'Existing Windows worker installation detected; preserving identity and resuming checkpoints.' }
if ($Upgrade -and -not $existingService) { Write-Warning 'MarsWorker service is missing; recreating it during upgrade.' }
Write-Host '[5/8] Preparing worker directories'
$exe = Join-Path $bin 'mars-orchestrator.exe'
$serviceHost = Join-Path $bin 'mars-service-host.exe'
$stagedExe = Join-Path $root 'mars-orchestrator.download'
$stagedServiceHost = Join-Path $root 'mars-service-host.download'
Write-Host '[6/8] Downloading Windows worker runtime and service host'
$orchestratorResponse = Invoke-WebRequest -Uri "$ControlPlaneUrl/api/workers/orchestrator?audience=windows-x64" -OutFile $stagedExe -TimeoutSec 120
$serviceHostResponse = Invoke-WebRequest -Uri "$ControlPlaneUrl/api/workers/service-host?audience=windows-x64" -OutFile $stagedServiceHost -TimeoutSec 120
Verify-DownloadedFile $stagedExe $WindowsOrchestratorSha256 'Windows orchestrator' $orchestratorResponse
Verify-DownloadedFile $stagedServiceHost $WindowsServiceHostSha256 'Windows service host' $serviceHostResponse
Write-State 'runtime-download' 'complete'
if ($existingService) {
  Stop-Service MarsWorker -Force -ErrorAction SilentlyContinue
  $serviceDelete = & sc.exe delete MarsWorker 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to remove existing MarsWorker service: $($serviceDelete -join ' ')" }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Service MarsWorker -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Get-Service MarsWorker -ErrorAction SilentlyContinue) { throw 'Timed out removing existing MarsWorker service.' }
}
Write-Host '[7/8] Registering LocalSystem worker service'
Move-Item -LiteralPath $stagedExe -Destination $exe -Force
Move-Item -LiteralPath $stagedServiceHost -Destination $serviceHost -Force
$cacheProxyPort = Resolve-CachePort 'MARS_CACHE_PROXY_PORT' 8788
$cacheDataPort = Resolve-CachePort 'MARS_CACHE_DATA_PORT' 8789
$cacheFirewallPorts = @($cacheProxyPort, $cacheDataPort) | Sort-Object -Unique
Get-NetFirewallRule -DisplayName 'Mars Worker Cache' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
New-NetFirewallRule -DisplayName 'Mars Worker Cache' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $cacheFirewallPorts -Program $exe -Profile Domain,Private -RemoteAddress LocalSubnet | Out-Null
$joinCodePath = $JoinCodeFile
$workerLogPath = Join-Path $root 'logs\worker.log'
$previousWorkerLogPath = Join-Path $root 'logs\worker.previous.log'
if (Test-Path -LiteralPath $workerLogPath) { Move-Item -LiteralPath $workerLogPath -Destination $previousWorkerLogPath -Force }
$service = New-Service -Name MarsWorker -BinaryPathName "`"$serviceHost`" `"$exe`" windows-worker" -StartupType Automatic -ErrorAction Stop
$serviceDependency = & sc.exe config MarsWorker depend= docker 2>&1
if ($LASTEXITCODE -ne 0) { throw "Failed to configure Docker dependency: $($serviceDependency -join ' ')" }
$serviceEnvironment = @(
  "MARS_CONTROL_PLANE_URL=$ControlPlaneUrl"
  "MARS_JOIN_CODE_FILE=$joinCodePath"
  "MARS_WINDOWS_RUNTIME=$WindowsRuntime"
)
foreach ($name in @('MARS_ACTION_CACHE_ROOT','MARS_CACHE_PROXY_PORT','MARS_CACHE_DATA_PORT','MARS_CACHE_PROXY_URL','MARS_CACHE_ADVERTISE_URL')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if (-not [string]::IsNullOrWhiteSpace($value)) { $serviceEnvironment += "$name=$value" }
}
if ($WindowsRuntime -eq 'container') {
  $serviceEnvironment += "MARS_WINDOWS_CONTAINER_IMAGE=$WindowsContainerImage"; $serviceEnvironment += "MARS_WINDOWS_CONTAINER_PREFIX=$WindowsContainerPrefix"; $serviceEnvironment += "MARS_WINDOWS_CONTAINER_READY_TIMEOUT_MS=$WindowsContainerReadyTimeoutMs"; $serviceEnvironment += "MARS_WINDOWS_CONTAINER_JOB_TIMEOUT_MS=$WindowsContainerJobTimeoutMs"; $serviceEnvironment += "MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST=$windowsImageManifestPath"
  if ($AllowLocalContainerImage -or $WindowsContainerImage -eq 'mars/windows-job:local') { $serviceEnvironment += 'MARS_ALLOW_LOCAL_CONTAINER_IMAGE=true' }
} else { $serviceEnvironment += "MARS_WINDOWS_TEMPLATE_PATH=$WindowsTemplatePath"; $serviceEnvironment += "MARS_WINDOWS_TEMPLATE_DIGEST=$WindowsTemplateDigest" }
$serviceRegistryPath = 'HKLM:\SYSTEM\CurrentControlSet\Services\MarsWorker'
New-ItemProperty -Path $serviceRegistryPath -Name Environment -PropertyType MultiString -Value $serviceEnvironment -Force | Out-Null
$serviceFailure = & sc.exe failure MarsWorker "reset= 86400" "actions= restart/5000/restart/30000/none/0" 2>&1
if ($LASTEXITCODE -ne 0) { throw "Failed to configure MarsWorker recovery: $($serviceFailure -join ' ')" }
try {
  Start-Service MarsWorker -ErrorAction Stop
  $service = Get-Service MarsWorker -ErrorAction Stop
  $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
  Start-Sleep -Seconds 2
  $service.Refresh()
  if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) { throw "MarsWorker stopped immediately with status $($service.Status)." }
} catch {
  $startupError = $_.Exception.Message
  $recoveryDeadline = (Get-Date).AddSeconds(15)
  do { Start-Sleep -Milliseconds 500; $currentService = Get-Service MarsWorker -ErrorAction SilentlyContinue } while ($currentService -and $currentService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running -and (Get-Date) -lt $recoveryDeadline)
  if (-not $currentService -or $currentService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
    throw "MarsWorker failed to reach Running. Startup error: $startupError"
  }
  Write-Warning "MarsWorker recovered after initial startup failure: $startupError"
}
Remove-ResumeTask
Write-State 'complete' 'complete'
if ($transcriptStarted) { Stop-Transcript | Out-Null }
Write-Output "Windows $WindowsRuntime worker setup complete; join-code remains until authenticated."
