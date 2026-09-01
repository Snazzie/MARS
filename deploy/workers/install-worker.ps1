[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = '',
  [Alias('Code')][string]$JoinCode = '',
  [string]$JoinCodeFile = 'C:\ProgramData\Mars\join-code',
  [ValidateSet('container')][string]$WindowsRuntime = 'container',
  [ValidateSet('production','local')][string]$WindowsArtifactMode = 'production',
  [string]$WindowsOrchestratorUrl = '',
  [string]$WindowsOrchestratorSha256 = '',
  [string]$WindowsServiceHostUrl = '',
  [string]$WindowsServiceHostSha256 = '',
  [string]$WindowsJobAgentUrl = '',
  [string]$WindowsJobAgentSha256 = '',
  [string]$WindowsContainerBaseImage = '',
  [string]$WindowsContainerRunnerUrl = '',
  [string]$WindowsContainerRunnerSha256 = '',
  [string]$WindowsContainerGitUrl = '',
  [string]$WindowsContainerGitSha256 = '',
  [string]$WindowsContainerVcRuntimeUrl = '',
  [string]$WindowsContainerVcRuntimeSha256 = '',
  [string]$WindowsContainerBuilderUrl = '',
  [string]$WindowsContainerBuilderSha256 = '',
  [string]$WindowsContainerVerifierUrl = '',
  [string]$WindowsContainerVerifierSha256 = '',
  [string]$WindowsContainerfileUrl = '',
  [string]$WindowsContainerfileSha256 = '',
  [string]$WindowsContainerEntrypointUrl = '',
  [string]$WindowsContainerEntrypointSha256 = '',
  [string]$WindowsContainerImage = 'mars/windows-job:local',
  [string]$WindowsContainerPrefix = 'mars',
  [int]$WindowsContainerReadyTimeoutMs = 15000,
  [int]$WindowsContainerJobTimeoutMs = 900000,
  [switch]$AllowInsecureHttp,
  [switch]$AllowLocalContainerImage,
  [switch]$Upgrade,
  [switch]$Resume
)
$ErrorActionPreference = 'Stop'
$windowsImageManifestPath = 'C:\ProgramData\Mars\windows-job-image.json'
function Require-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required.' }
}
function Assert-HttpsUrl([string]$Url, [string]$Name) {
  $parsed = $null
  if ($Url -match '\s' -or -not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsed) -or
      ($parsed.Scheme -ne [Uri]::UriSchemeHttp -and $parsed.Scheme -ne [Uri]::UriSchemeHttps) -or
      [string]::IsNullOrWhiteSpace($parsed.Host)) { throw "$Name must be an absolute HTTP or HTTPS URL." }
  try { $null = $parsed.Port } catch { throw "$Name must be an absolute HTTP or HTTPS URL." }
  if (-not [string]::IsNullOrEmpty($parsed.UserInfo) -or $Url -match '#') { throw "$Name must not include credentials or fragments." }
  if ($parsed.Scheme -eq [Uri]::UriSchemeHttp -and -not $parsed.IsLoopback -and -not $AllowInsecureHttp) { throw "$Name must use HTTPS unless -AllowInsecureHttp is specified." }
}
function Assert-Sha256([string]$Hash, [string]$Name) {
  if ($Hash -notmatch '^[0-9a-f]{64}$') { throw "$Name must be a lowercase SHA-256 value." }
}
function Assert-ArtifactConfiguration {
  $required = @(
    @('WindowsOrchestratorUrl', $WindowsOrchestratorUrl, $WindowsOrchestratorSha256),
    @('WindowsServiceHostUrl', $WindowsServiceHostUrl, $WindowsServiceHostSha256),
    @('WindowsJobAgentUrl', $WindowsJobAgentUrl, $WindowsJobAgentSha256),
    @('WindowsContainerRunnerUrl', $WindowsContainerRunnerUrl, $WindowsContainerRunnerSha256),
    @('WindowsContainerGitUrl', $WindowsContainerGitUrl, $WindowsContainerGitSha256),
    @('WindowsContainerVcRuntimeUrl', $WindowsContainerVcRuntimeUrl, $WindowsContainerVcRuntimeSha256),
    @('WindowsContainerBuilderUrl', $WindowsContainerBuilderUrl, $WindowsContainerBuilderSha256),
    @('WindowsContainerVerifierUrl', $WindowsContainerVerifierUrl, $WindowsContainerVerifierSha256),
    @('WindowsContainerfileUrl', $WindowsContainerfileUrl, $WindowsContainerfileSha256),
    @('WindowsContainerEntrypointUrl', $WindowsContainerEntrypointUrl, $WindowsContainerEntrypointSha256)
  )
  $missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace($_[1]) -or [string]::IsNullOrWhiteSpace($_[2]) } | ForEach-Object { $_[0] })
  if ([string]::IsNullOrWhiteSpace($WindowsContainerBaseImage)) { $missing += 'WindowsContainerBaseImage' }
  if ($missing.Count -gt 0) { throw "Windows worker artifacts are not configured: $($missing -join ', ')." }
  if ($WindowsContainerBaseImage -notmatch '^mcr\.microsoft\.com/windows/server:ltsc2025@sha256:[0-9a-f]{64}$') { throw 'WindowsContainerBaseImage must be a digest-pinned Windows Server LTSC 2025 reference.' }
  foreach ($item in $required) { Assert-HttpsUrl $item[1] $item[0]; Assert-Sha256 $item[2] "$($item[0]) SHA-256" }
}
function Write-State([string]$Stage, [string]$Status) {
  $statePath = 'C:\ProgramData\Mars\install-state.json'
  New-Item -ItemType Directory -Force -Path (Split-Path $statePath) | Out-Null
  [ordered]@{ stage = $Stage; status = $Status; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -Encoding utf8
}
function Refresh-ProcessPath {
  $entries = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
  $entries += (Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\bin')
  $env:Path = ($entries | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_ -split ';' } | Select-Object -Unique) -join ';'
}
function Install-DockerDesktop {
  Refresh-ProcessPath
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'winget is required to install Docker Desktop.' }
    winget install --id Docker.DockerDesktop --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Docker Desktop installation failed with exit code $LASTEXITCODE." }
    Refresh-ProcessPath
  }
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Get-Command docker.exe -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Refresh-ProcessPath; Start-Sleep -Seconds 2 }
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Desktop did not install.' }
}
function Switch-DockerWindowsEngine {
  Refresh-ProcessPath
  $dockerCli = Join-Path ${env:ProgramFiles} 'Docker\Docker\DockerCli.exe'
  if (-not (Test-Path -LiteralPath $dockerCli)) { throw 'DockerCli.exe is required to switch Docker Desktop to the Windows engine.' }
  & $dockerCli -SwitchWindowsEngine
  if ($LASTEXITCODE -ne 0) { throw "Docker Desktop Windows engine switch failed with exit code $LASTEXITCODE." }
  $deadline = (Get-Date).AddMinutes(3)
  do { try { $engine = (docker info --format '{{.OSType}}' 2>$null).Trim() } catch { $engine = '' }; if ($engine -eq 'windows') { return }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $deadline)
  throw 'Docker Desktop did not become ready on the Windows engine.'
}
function Assert-HostPreflight {
  $os = Get-CimInstance Win32_OperatingSystem
  if ($os.Caption -notmatch '^Microsoft Windows 11 (Pro|Enterprise)') { throw 'Windows 11 Pro or Enterprise is required.' }
  if ([int]$os.BuildNumber -lt 26100) { throw 'Windows 11 24H2 (build 26100 or newer) is required.' }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $computerSystem = Get-CimInstance Win32_ComputerSystem
  if (-not [bool]$cpu.VirtualizationFirmwareEnabled -or (-not [bool]$computerSystem.HypervisorPresent -and -not [bool]$cpu.SecondLevelAddressTranslationExtensions)) { throw 'hardware virtualization is required.' }
}
function Quote-TaskArgument([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Register-ResumeTask {
  param([string]$ScriptPath)
  $resumeParameters = @('-ControlPlaneUrl',$ControlPlaneUrl,'-JoinCodeFile',$JoinCodeFile,'-WindowsArtifactMode',$WindowsArtifactMode,'-WindowsOrchestratorUrl',$WindowsOrchestratorUrl,'-WindowsOrchestratorSha256',$WindowsOrchestratorSha256,'-WindowsServiceHostUrl',$WindowsServiceHostUrl,'-WindowsServiceHostSha256',$WindowsServiceHostSha256,'-WindowsJobAgentUrl',$WindowsJobAgentUrl,'-WindowsJobAgentSha256',$WindowsJobAgentSha256,'-WindowsContainerBaseImage',$WindowsContainerBaseImage,'-WindowsContainerRunnerUrl',$WindowsContainerRunnerUrl,'-WindowsContainerRunnerSha256',$WindowsContainerRunnerSha256,'-WindowsContainerGitUrl',$WindowsContainerGitUrl,'-WindowsContainerGitSha256',$WindowsContainerGitSha256,'-WindowsContainerVcRuntimeUrl',$WindowsContainerVcRuntimeUrl,'-WindowsContainerVcRuntimeSha256',$WindowsContainerVcRuntimeSha256,'-WindowsContainerBuilderUrl',$WindowsContainerBuilderUrl,'-WindowsContainerBuilderSha256',$WindowsContainerBuilderSha256,'-WindowsContainerVerifierUrl',$WindowsContainerVerifierUrl,'-WindowsContainerVerifierSha256',$WindowsContainerVerifierSha256,'-WindowsContainerfileUrl',$WindowsContainerfileUrl,'-WindowsContainerfileSha256',$WindowsContainerfileSha256,'-WindowsContainerEntrypointUrl',$WindowsContainerEntrypointUrl,'-WindowsContainerEntrypointSha256',$WindowsContainerEntrypointSha256,'-WindowsContainerImage',$WindowsContainerImage,'-WindowsContainerPrefix',$WindowsContainerPrefix,'-WindowsContainerReadyTimeoutMs',$WindowsContainerReadyTimeoutMs,'-WindowsContainerJobTimeoutMs',$WindowsContainerJobTimeoutMs,'-WindowsRuntime','container','-Resume')
  if ($AllowInsecureHttp) { $resumeParameters += '-AllowInsecureHttp' }; if ($AllowLocalContainerImage) { $resumeParameters += '-AllowLocalContainerImage' }; if ($Upgrade) { $resumeParameters += '-Upgrade' }
  $argumentText = ($resumeParameters | ForEach-Object { Quote-TaskArgument ([string]$_) }) -join ' '
  $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File $(Quote-TaskArgument $ScriptPath) $argumentText"
  $trigger = New-ScheduledTaskTrigger -AtStartup; $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName 'MarsWorkerInstallResume' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
}
function Remove-ResumeTask { Unregister-ScheduledTask -TaskName 'MarsWorkerInstallResume' -Confirm:$false -ErrorAction SilentlyContinue }
function Resolve-CachePort([string]$Name, [int]$DefaultPort) {
  $raw = [Environment]::GetEnvironmentVariable($Name); if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultPort }
  $port = 0; if (-not [int]::TryParse($raw, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw "$Name must be an integer between 1 and 65535." }; return $port
}
function Ensure-ContainerFeatures {
  $restart = $false
  foreach ($featureName in @('Microsoft-Hyper-V-All','Containers')) { $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName -ErrorAction SilentlyContinue; if ($feature.State -ne 'Enabled') { $result = Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart; if ($result.RestartNeeded) { $restart = $true } } }
  if ($restart) { return $true }; return $false
}
function Assert-WindowsContainerHost {
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Engine is required.' }
  try { $engine = (docker info --format '{{.OSType}}' 2>$null).Trim() } catch { $engine = '' }
  if ($engine -ne 'windows') { throw 'Docker must be running the Windows engine.' }
}
function Ensure-ControlPlane {
  $localHttp = $ControlPlaneUrl -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$'
  if ($ControlPlaneUrl -notmatch '^https://' -and -not $localHttp -and -not $AllowInsecureHttp) { throw 'Control-plane URL must use HTTPS.' }
  Invoke-WebRequest -Uri "$ControlPlaneUrl/api/healthz" -Method Get -UseBasicParsing -TimeoutSec 30 | Out-Null
}
function Download-WorkerArtifact([string]$Url, [string]$Destination, [int]$TimeoutSec = 120) {
  $parent = Split-Path -Parent $Destination; New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $staged = "$Destination.download.$([guid]::NewGuid().ToString('N'))"
  try { for ($attempt = 1; $attempt -le 3; $attempt++) { try { $response = Invoke-WebRequest -Uri $Url -OutFile $staged -UseBasicParsing -TimeoutSec $TimeoutSec; Move-Item -LiteralPath $staged -Destination $Destination -Force; return $response } catch { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue; if ($attempt -eq 3) { throw }; Start-Sleep -Seconds $attempt } } } finally { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
}
function Verify-DownloadedFile([string]$Path, [string]$Expected, [string]$Name, $Response) {
  Assert-Sha256 $Expected "$Name SHA-256"
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant(); if ($actual -ne $Expected) { throw "$Name checksum mismatch: expected $Expected, got $actual" }
  $responseHash = if ($Response -and $Response.Headers['X-Content-SHA256']) { ([string]$Response.Headers['X-Content-SHA256']).ToLowerInvariant() } else { '' }
  if ($responseHash -and $responseHash -ne $Expected) { throw "$Name response hash mismatch." }
}
function Download-Verified([string]$Url, [string]$Hash, [string]$Destination, [string]$Name) { $response = Download-WorkerArtifact $Url $Destination 900; Verify-DownloadedFile $Destination $Hash $Name $response }
function Set-WorkerJoinCredential([string]$Path, [string]$Code) {
  $parent = Split-Path -Parent $Path; New-Item -ItemType Directory -Force -Path $parent | Out-Null; [IO.File]::WriteAllText($Path, $Code)
  $joinCodeAcl = & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to secure worker join credential: $($joinCodeAcl -join ' ')" }
}
function Reset-WorkerIdentity([string]$Path, [bool]$Preserve) { if (-not $Preserve -and (Test-Path -LiteralPath $Path)) { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop } }
function Wait-WorkerEnrollment([string]$IdentityPath, [int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do { $service = Get-Service MarsWorker -ErrorAction SilentlyContinue; if (-not $service -or "$($service.Status)" -ne 'Running') { throw 'MarsWorker stopped before enrollment completed. See C:\ProgramData\Mars\logs\worker.log.' }; if (Test-Path -LiteralPath $IdentityPath) { try { $identity = Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json; if ($identity.workerId -is [string] -and -not [string]::IsNullOrWhiteSpace($identity.workerId)) { return } } catch {} }; if ((Get-Date) -ge $deadline) { break }; Start-Sleep -Milliseconds 500 } while ($true)
  throw "MarsWorker did not enroll within $TimeoutSeconds seconds. See C:\ProgramData\Mars\logs\worker.log."
}
Write-Host '[1/7] Checking administrator privileges'; Require-Administrator
Write-Host '[2/7] Checking Windows 11 Pro/Enterprise 24H2 x64 host'; Assert-HostPreflight; Assert-ArtifactConfiguration
$root = 'C:\ProgramData\Mars'; $bin = 'C:\Program Files\Mars'; $identityPath = Join-Path $root 'worker-identity.json'; $persistentInstallerPath = Join-Path $root 'install-worker.ps1'; $staging = Join-Path ([IO.Path]::GetTempPath()) ('mars-worker-' + [guid]::NewGuid().ToString('N'))
$transcriptStarted = $false; try { Start-Transcript -LiteralPath (Join-Path $root 'install.log') -Append | Out-Null; $transcriptStarted = $true } catch { Write-Warning "Unable to start persistent installer log: $($_.Exception.Message)" }
try {
  if (($Upgrade -or $Resume) -and [string]::IsNullOrWhiteSpace($JoinCode) -and (Test-Path -LiteralPath $JoinCodeFile)) { $JoinCode = (Get-Content -LiteralPath $JoinCodeFile -Raw).Trim() }
  Write-Host '[3/7] Checking control-plane connectivity and validating worker artifacts'; Ensure-ControlPlane
  if (-not $Upgrade -and ([string]::IsNullOrWhiteSpace($JoinCode) -or $JoinCode -notmatch '^[A-Za-z0-9_-]{43}$')) { throw 'Join code is not configured.' }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $paths = [ordered]@{ orchestrator = Join-Path $staging 'mars-orchestrator.exe'; serviceHost = Join-Path $staging 'mars-service-host.exe'; jobAgent = Join-Path $staging 'mars-job-agent.exe'; runner = Join-Path $staging 'runner.zip'; git = Join-Path $staging 'git.zip'; vc = Join-Path $staging 'vc_redist.x64.exe'; builder = Join-Path $staging 'build-image.ps1'; verifier = Join-Path $staging 'verify-runtime.ps1'; containerfile = Join-Path $staging 'Containerfile'; entrypoint = Join-Path $staging 'entrypoint.ps1' }
  Download-Verified $WindowsOrchestratorUrl $WindowsOrchestratorSha256 $paths.orchestrator 'Windows orchestrator'; Download-Verified $WindowsServiceHostUrl $WindowsServiceHostSha256 $paths.serviceHost 'Windows service host'; Download-Verified $WindowsJobAgentUrl $WindowsJobAgentSha256 $paths.jobAgent 'Windows job agent'; Download-Verified $WindowsContainerRunnerUrl $WindowsContainerRunnerSha256 $paths.runner 'Actions Runner'; Download-Verified $WindowsContainerGitUrl $WindowsContainerGitSha256 $paths.git 'Git'; Download-Verified $WindowsContainerVcRuntimeUrl $WindowsContainerVcRuntimeSha256 $paths.vc 'VC runtime'; Download-Verified $WindowsContainerBuilderUrl $WindowsContainerBuilderSha256 $paths.builder 'Windows image builder'; Download-Verified $WindowsContainerVerifierUrl $WindowsContainerVerifierSha256 $paths.verifier 'Windows runtime verifier'; Download-Verified $WindowsContainerfileUrl $WindowsContainerfileSha256 $paths.containerfile 'Windows Containerfile'; Download-Verified $WindowsContainerEntrypointUrl $WindowsContainerEntrypointSha256 $paths.entrypoint 'Windows image entrypoint'
  Write-State 'artifact-download' 'complete'
  Write-Host '[4/7] Checking container runtime and installing prerequisites'
  if (-not $Upgrade -and -not (Test-Path -LiteralPath $JoinCodeFile)) { Set-WorkerJoinCredential $JoinCodeFile $JoinCode }
  if (Ensure-ContainerFeatures) { New-Item -ItemType Directory -Force -Path $root | Out-Null; if ([IO.Path]::GetFullPath($PSCommandPath) -ne [IO.Path]::GetFullPath($persistentInstallerPath)) { Copy-Item -LiteralPath $PSCommandPath -Destination $persistentInstallerPath -Force }; Register-ResumeTask $persistentInstallerPath; Write-State 'reboot-required' 'pending'; Write-Host 'Windows features require a reboot; MarsWorkerInstallResume will continue automatically.'; Restart-Computer -Force; exit 0 }
  Install-DockerDesktop; Switch-DockerWindowsEngine; Assert-WindowsContainerHost
  if (Test-Path -LiteralPath $windowsImageManifestPath) { Remove-Item -LiteralPath $windowsImageManifestPath -Force -ErrorAction Stop }
  & $paths.builder -BaseImage $WindowsContainerBaseImage -RunnerArchivePath $paths.runner -RunnerSha256 $WindowsContainerRunnerSha256 -GitArchivePath $paths.git -GitSha256 $WindowsContainerGitSha256 -VcRuntimePath $paths.vc -VcRuntimeSha256 $WindowsContainerVcRuntimeSha256 -JobAgent $paths.jobAgent -Image $WindowsContainerImage -ManifestPath $windowsImageManifestPath -VerifierPath $paths.verifier -ContainerfilePath $paths.containerfile -EntrypointPath $paths.entrypoint
  if ($LASTEXITCODE -ne 0) { throw "Windows job image build failed with exit code $LASTEXITCODE." }
  Write-State 'prerequisites' 'complete'
  Write-Host '[5/7] Preparing worker replacement'
  $existingService = Get-Service MarsWorker -ErrorAction SilentlyContinue; $existingInstall = $existingService -or (Test-Path -LiteralPath $identityPath)
  if ($Upgrade -and -not (Test-Path -LiteralPath $identityPath)) { throw 'Upgrade requires an existing worker identity.' }
  if ($existingInstall -and $Upgrade) { Write-Host 'Existing Windows worker installation detected; preserving identity and resuming checkpoints.' }; if ($existingInstall -and -not $Upgrade) { Write-Host 'Existing Windows worker installation detected; replacing identity and runtime for a fresh enrollment.' }
  if ($Upgrade -and -not $existingService) { Write-Warning 'MarsWorker service is missing; recreating it during upgrade.' }
  if (-not $Upgrade) { Reset-WorkerIdentity $identityPath $false; Set-WorkerJoinCredential $JoinCodeFile $JoinCode }
  if ($existingService) { Stop-Service MarsWorker -Force -ErrorAction SilentlyContinue; $serviceDelete = & sc.exe delete MarsWorker 2>&1; if ($LASTEXITCODE -ne 0) { throw "Failed to remove existing MarsWorker service: $($serviceDelete -join ' ')" }; $deadline = (Get-Date).AddSeconds(15); while ((Get-Service MarsWorker -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }; if (Get-Service MarsWorker -ErrorAction SilentlyContinue) { throw 'Timed out removing existing MarsWorker service.' } }
  Write-Host '[6/7] Registering LocalSystem worker service'; New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
  Move-Item -LiteralPath $paths.orchestrator -Destination (Join-Path $bin 'mars-orchestrator.exe') -Force; Move-Item -LiteralPath $paths.serviceHost -Destination (Join-Path $bin 'mars-service-host.exe') -Force
  $exe = Join-Path $bin 'mars-orchestrator.exe'; $serviceHost = Join-Path $bin 'mars-service-host.exe'; $cacheProxyPort = Resolve-CachePort 'MARS_CACHE_PROXY_PORT' 8788; $cacheDataPort = Resolve-CachePort 'MARS_CACHE_DATA_PORT' 8789; $cacheFirewallPorts = @($cacheProxyPort,$cacheDataPort) | Sort-Object -Unique
  Get-NetFirewallRule -DisplayName 'Mars Worker Cache' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop; New-NetFirewallRule -DisplayName 'Mars Worker Cache' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $cacheFirewallPorts -Program $exe -Profile Domain,Private -RemoteAddress LocalSubnet | Out-Null
  $workerLogPath = Join-Path $root 'logs\worker.log'; $previousWorkerLogPath = Join-Path $root 'logs\worker.previous.log'; if (Test-Path -LiteralPath $workerLogPath) { New-Item -ItemType Directory -Force -Path (Split-Path $previousWorkerLogPath) | Out-Null; Move-Item -LiteralPath $workerLogPath -Destination $previousWorkerLogPath -Force }
  $service = New-Service -Name MarsWorker -BinaryPathName "`"$serviceHost`" `"$exe`" windows-worker" -StartupType Automatic -ErrorAction Stop; $serviceDependency = & sc.exe config MarsWorker depend= docker 2>&1; if ($LASTEXITCODE -ne 0) { throw "Failed to configure Docker dependency: $($serviceDependency -join ' ')" }
  $serviceEnvironment = @("MARS_CONTROL_PLANE_URL=$ControlPlaneUrl","MARS_JOIN_CODE_FILE=$JoinCodeFile","MARS_WINDOWS_RUNTIME=container","MARS_WINDOWS_CONTAINER_IMAGE=$WindowsContainerImage","MARS_WINDOWS_CONTAINER_PREFIX=$WindowsContainerPrefix","MARS_WINDOWS_CONTAINER_READY_TIMEOUT_MS=$WindowsContainerReadyTimeoutMs","MARS_WINDOWS_CONTAINER_JOB_TIMEOUT_MS=$WindowsContainerJobTimeoutMs","MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST=$windowsImageManifestPath")
  if ($AllowLocalContainerImage -or $WindowsContainerImage -eq 'mars/windows-job:local') { $serviceEnvironment += 'MARS_ALLOW_LOCAL_CONTAINER_IMAGE=true' }
  foreach ($name in @('MARS_ACTION_CACHE_ROOT','MARS_CACHE_PROXY_PORT','MARS_CACHE_DATA_PORT','MARS_CACHE_PROXY_URL','MARS_CACHE_ADVERTISE_URL','MARS_CACHE_TOKEN_ISSUER','MARS_CACHE_JWKS_URL')) { $value = [Environment]::GetEnvironmentVariable($name); if (-not [string]::IsNullOrWhiteSpace($value)) { $serviceEnvironment += "$name=$value" } }
  New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\MarsWorker' -Name Environment -PropertyType MultiString -Value $serviceEnvironment -Force | Out-Null; $serviceFailure = & sc.exe failure MarsWorker 'reset= 86400' 'actions= restart/5000/restart/30000/none/0' 2>&1; if ($LASTEXITCODE -ne 0) { throw "Failed to configure MarsWorker recovery: $($serviceFailure -join ' ')" }
  Write-Host '[7/7] Starting worker service and waiting for enrollment'; try { Start-Service MarsWorker -ErrorAction Stop; $service = Get-Service MarsWorker -ErrorAction Stop; $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30)); Start-Sleep -Seconds 2; $service.Refresh(); if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) { throw "MarsWorker stopped immediately with status $($service.Status)." } } catch { $startupError = $_.Exception.Message; $recoveryDeadline = (Get-Date).AddSeconds(15); do { Start-Sleep -Milliseconds 500; $currentService = Get-Service MarsWorker -ErrorAction SilentlyContinue } while ($currentService -and $currentService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running -and (Get-Date) -lt $recoveryDeadline); if (-not $currentService -or $currentService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) { throw "MarsWorker failed to reach Running. Startup error: $startupError" }; Write-Warning "MarsWorker recovered after initial startup failure: $startupError" }
  Wait-WorkerEnrollment $identityPath; Remove-ResumeTask; Write-State 'complete' 'complete'; Write-Output 'Windows container worker setup complete; join-code remains until authenticated.'
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
