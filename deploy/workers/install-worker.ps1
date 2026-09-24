[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = '',
  [Alias('Code')][string]$JoinCode = '',
  [string]$JoinCodeFile = 'C:\ProgramData\Mars\join-code',
  [ValidateSet('container','vm')][string]$WindowsRuntime = 'container',
  [ValidateSet('production','local')][string]$WindowsArtifactMode = 'production',
  [string]$WorkerVersion = '',
  [string]$WorkerContractVersion = '',
  [string]$WindowsOrchestratorUrl = '',
  [string]$WindowsOrchestratorSha256 = '',
  [string]$WindowsTrayScriptUrl = '',
  [string]$WindowsTrayScriptSha256 = '',
  [string]$WindowsServiceHostUrl = '',
  [string]$WindowsServiceHostSha256 = '',
  [string]$WindowsJobAgentUrl = '',
  [string]$WindowsJobAgentSha256 = '',
  [ValidateSet('checkpoint','iso','vhdx')][string]$WindowsVmImageSource = 'checkpoint',
  [string]$WindowsSourcePath = '',
  [string]$WindowsSourceSha256 = '',
  [string]$WindowsImageName = 'Windows 11 Pro',
  [string]$WindowsCustomProvisioningScriptPath = '',
  [string]$WindowsCustomProvisioningScriptSha256 = '',
  [switch]$AcceptWindowsLicenseTerms,
  [string]$WindowsCheckpointUrl = '',
  [string]$WindowsCheckpointSha256 = '',
  [string]$WindowsVmProvisionerUrl = '',
  [string]$WindowsVmProvisionerSha256 = '',
  [string]$WindowsRunnerUrl = '',
  [string]$WindowsRunnerSha256 = '',
  [string]$WindowsGitUrl = '',
  [string]$WindowsGitSha256 = '',
  [string]$WindowsVcRuntimeUrl = '',
  [string]$WindowsVcRuntimeSha256 = '',
  [string]$WindowsContainerBaseImage = '',
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
  $core = @(
    @('WindowsOrchestratorUrl', $WindowsOrchestratorUrl, $WindowsOrchestratorSha256),
    @('WindowsServiceHostUrl', $WindowsServiceHostUrl, $WindowsServiceHostSha256),
    @('WindowsTrayScriptUrl', $WindowsTrayScriptUrl, $WindowsTrayScriptSha256)
  )
  $shared = @(
    @('WindowsJobAgentUrl', $WindowsJobAgentUrl, $WindowsJobAgentSha256),
    @('WindowsRunnerUrl', $WindowsRunnerUrl, $WindowsRunnerSha256),
    @('WindowsGitUrl', $WindowsGitUrl, $WindowsGitSha256),
    @('WindowsVcRuntimeUrl', $WindowsVcRuntimeUrl, $WindowsVcRuntimeSha256)
  )
  $checkpoint = @('WindowsCheckpointUrl', $WindowsCheckpointUrl, $WindowsCheckpointSha256)
  $provisioner = @('WindowsVmProvisionerUrl', $WindowsVmProvisionerUrl, $WindowsVmProvisionerSha256)
  $container = @(
    @('WindowsContainerBuilderUrl', $WindowsContainerBuilderUrl, $WindowsContainerBuilderSha256),
    @('WindowsContainerVerifierUrl', $WindowsContainerVerifierUrl, $WindowsContainerVerifierSha256),
    @('WindowsContainerfileUrl', $WindowsContainerfileUrl, $WindowsContainerfileSha256),
    @('WindowsContainerEntrypointUrl', $WindowsContainerEntrypointUrl, $WindowsContainerEntrypointSha256)
  )
  $required = @($core)
  if ($Upgrade) {
    if ($WindowsVmImageSource -ne 'checkpoint' -or $WindowsSourcePath -or $WindowsSourceSha256 -or $AcceptWindowsLicenseTerms) { throw 'Upgrade does not accept VM source selection; persisted image state chooses the source.' }
    foreach ($item in @($shared) + @($checkpoint,$provisioner) + @($container)) {
      $hasUrl = -not [string]::IsNullOrWhiteSpace([string]$item[1]); $hasHash = -not [string]::IsNullOrWhiteSpace([string]$item[2])
      if ($hasUrl -ne $hasHash) { throw "$($item[0]) URL and SHA-256 must be supplied together." }
      if ($hasUrl) { Assert-HttpsUrl $item[1] $item[0]; Assert-Sha256 $item[2] "$($item[0]) SHA-256" }
    }
  } elseif ($WindowsRuntime -eq 'container') {
    $required += $shared + $container
    if ([string]::IsNullOrWhiteSpace($WindowsContainerBaseImage)) { throw 'WindowsContainerBaseImage is required.' }
    if ($WindowsContainerBaseImage -notmatch '^mcr\.microsoft\.com/windows/server:ltsc2025@sha256:[0-9a-f]{64}$') { throw 'WindowsContainerBaseImage must be a digest-pinned Windows Server LTSC 2025 reference.' }
  } elseif ($WindowsVmImageSource -eq 'checkpoint') {
    $required += @($checkpoint,$provisioner)
    if ($WindowsSourcePath -or $WindowsSourceSha256 -or $AcceptWindowsLicenseTerms) { throw 'Checkpoint mode does not accept local Windows media fields.' }
  } else {
    $required += @($provisioner) + $shared
    if ([string]::IsNullOrWhiteSpace($WindowsSourcePath) -or [string]::IsNullOrWhiteSpace($WindowsSourceSha256)) { throw 'ISO/VHDX mode requires source path and SHA-256.' }
    Assert-Sha256 $WindowsSourceSha256 'Windows source SHA-256'
    if (-not (Test-Path -LiteralPath $WindowsSourcePath -PathType Leaf)) { throw "Windows source file does not exist: $WindowsSourcePath" }
    if ($WindowsVmImageSource -eq 'iso' -and -not $AcceptWindowsLicenseTerms) { throw 'ISO mode requires -AcceptWindowsLicenseTerms.' }
    if ($WindowsVmImageSource -eq 'iso' -and [string]::IsNullOrWhiteSpace($WindowsImageName)) { throw 'ISO mode requires WindowsImageName.' }
  }
  if ([string]::IsNullOrWhiteSpace($WindowsCustomProvisioningScriptPath) -ne [string]::IsNullOrWhiteSpace($WindowsCustomProvisioningScriptSha256)) { throw 'Custom provisioning script path and SHA-256 must be supplied together.' }
  if ($WindowsCustomProvisioningScriptPath) {
    Assert-Sha256 $WindowsCustomProvisioningScriptSha256 'Custom provisioning script SHA-256'
    if (-not (Test-Path -LiteralPath $WindowsCustomProvisioningScriptPath -PathType Leaf)) { throw "Custom provisioning script does not exist: $WindowsCustomProvisioningScriptPath" }
  }
  $missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace([string]$_[1]) -or [string]::IsNullOrWhiteSpace([string]$_[2]) } | ForEach-Object { $_[0] })
  if ($missing.Count -gt 0) { throw "Windows worker artifacts are not configured: $($missing -join ', ')." }
  foreach ($item in $required) { Assert-HttpsUrl $item[1] $item[0]; Assert-Sha256 $item[2] "$($item[0]) SHA-256" }
}
function Write-State([string]$Stage, [string]$Status) {
  $statePath = 'C:\ProgramData\Mars\install-state.json'
  New-Item -ItemType Directory -Force -Path (Split-Path $statePath) | Out-Null
  [ordered]@{ stage = $Stage; status = $Status; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -Encoding utf8
}
function Save-MarsProvisioningInput {
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Sha256,[Parameter(Mandatory)][string]$Name)
  Assert-Sha256 $Sha256 "$Name SHA-256"
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Name file does not exist: $Path" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { throw "$Name SHA-256 mismatch: expected $Sha256, got $actual" }
  $root = 'C:\ProgramData\Mars\vm-provisioning\sources'; $destination = Join-Path $root $Sha256
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
    $partial = "$destination.partial.$([guid]::NewGuid().ToString('N'))"
    try { Copy-Item -LiteralPath $Path -Destination $partial; Move-Item -LiteralPath $partial -Destination $destination }
    finally { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant() -ne $Sha256) { throw "$Name durable copy is invalid." }
  $acl = & icacls.exe $destination /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to secure $Name durable copy: $($acl -join ' ')" }
  return $destination
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
  if ($WorkerVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'WorkerVersion must use major.minor.patch.' }
  if ($WorkerContractVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'WorkerContractVersion must use major.minor.patch.' }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $computerSystem = Get-CimInstance Win32_ComputerSystem
  if (-not [bool]$cpu.VirtualizationFirmwareEnabled -or (-not [bool]$computerSystem.HypervisorPresent -and -not [bool]$cpu.SecondLevelAddressTranslationExtensions)) { throw 'hardware virtualization is required.' }
}
function Quote-TaskArgument([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Register-ResumeTask {
  param([string]$ScriptPath)
  $resumeParameters = @(
    '-ControlPlaneUrl',$ControlPlaneUrl,'-JoinCodeFile',$JoinCodeFile,'-WindowsArtifactMode',$WindowsArtifactMode,
    '-WorkerVersion',$WorkerVersion,'-WorkerContractVersion',$WorkerContractVersion,'-WindowsRuntime',$WindowsRuntime,
    '-WindowsVmImageSource',$WindowsVmImageSource,'-WindowsSourcePath',$WindowsSourcePath,'-WindowsSourceSha256',$WindowsSourceSha256,
    '-WindowsImageName',$WindowsImageName,'-WindowsCustomProvisioningScriptPath',$WindowsCustomProvisioningScriptPath,'-WindowsCustomProvisioningScriptSha256',$WindowsCustomProvisioningScriptSha256,
    '-WindowsOrchestratorUrl',$WindowsOrchestratorUrl,'-WindowsOrchestratorSha256',$WindowsOrchestratorSha256,
    '-WindowsServiceHostUrl',$WindowsServiceHostUrl,'-WindowsServiceHostSha256',$WindowsServiceHostSha256,
    '-WindowsTrayScriptUrl',$WindowsTrayScriptUrl,'-WindowsTrayScriptSha256',$WindowsTrayScriptSha256,
    '-WindowsCheckpointUrl',$WindowsCheckpointUrl,'-WindowsCheckpointSha256',$WindowsCheckpointSha256,
    '-WindowsVmProvisionerUrl',$WindowsVmProvisionerUrl,'-WindowsVmProvisionerSha256',$WindowsVmProvisionerSha256,
    '-WindowsJobAgentUrl',$WindowsJobAgentUrl,'-WindowsJobAgentSha256',$WindowsJobAgentSha256,
    '-WindowsRunnerUrl',$WindowsRunnerUrl,'-WindowsRunnerSha256',$WindowsRunnerSha256,
    '-WindowsGitUrl',$WindowsGitUrl,'-WindowsGitSha256',$WindowsGitSha256,
    '-WindowsVcRuntimeUrl',$WindowsVcRuntimeUrl,'-WindowsVcRuntimeSha256',$WindowsVcRuntimeSha256,
    '-WindowsContainerBaseImage',$WindowsContainerBaseImage,'-WindowsContainerBuilderUrl',$WindowsContainerBuilderUrl,'-WindowsContainerBuilderSha256',$WindowsContainerBuilderSha256,
    '-WindowsContainerVerifierUrl',$WindowsContainerVerifierUrl,'-WindowsContainerVerifierSha256',$WindowsContainerVerifierSha256,
    '-WindowsContainerfileUrl',$WindowsContainerfileUrl,'-WindowsContainerfileSha256',$WindowsContainerfileSha256,
    '-WindowsContainerEntrypointUrl',$WindowsContainerEntrypointUrl,'-WindowsContainerEntrypointSha256',$WindowsContainerEntrypointSha256,
    '-WindowsContainerImage',$WindowsContainerImage,'-WindowsContainerPrefix',$WindowsContainerPrefix,
    '-WindowsContainerReadyTimeoutMs',$WindowsContainerReadyTimeoutMs,'-Resume'
  )
  if ($AcceptWindowsLicenseTerms) { $resumeParameters += '-AcceptWindowsLicenseTerms' }
  if ($AllowInsecureHttp) { $resumeParameters += '-AllowInsecureHttp' }; if ($AllowLocalContainerImage) { $resumeParameters += '-AllowLocalContainerImage' }; if ($Upgrade) { $resumeParameters += '-Upgrade' }
  $argumentText = ($resumeParameters | ForEach-Object { Quote-TaskArgument ([string]$_) }) -join ' '
  $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File $(Quote-TaskArgument $ScriptPath) $argumentText"
  $trigger = New-ScheduledTaskTrigger -AtStartup; $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 120 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  Register-ScheduledTask -TaskName 'MarsWorkerInstallResume' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}
function Remove-ResumeTask { Unregister-ScheduledTask -TaskName 'MarsWorkerInstallResume' -Confirm:$false -ErrorAction SilentlyContinue }
function Resolve-CachePort([string]$Name, [int]$DefaultPort) {
  $raw = [Environment]::GetEnvironmentVariable($Name); if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultPort }
  $port = 0; if (-not [int]::TryParse($raw, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw "$Name must be an integer between 1 and 65535." }; return $port
}
function Resolve-ContainerCacheOrigins {
  $proxy = [Environment]::GetEnvironmentVariable('MARS_CACHE_PROXY_URL')
  $advertise = [Environment]::GetEnvironmentVariable('MARS_CACHE_ADVERTISE_URL')
  if ((-not [string]::IsNullOrWhiteSpace($proxy)) -or (-not [string]::IsNullOrWhiteSpace($advertise))) {
    if ([string]::IsNullOrWhiteSpace($proxy) -or [string]::IsNullOrWhiteSpace($advertise)) { throw 'MARS_CACHE_PROXY_URL and MARS_CACHE_ADVERTISE_URL must be configured together.' }
    return @{ Proxy = $proxy.Trim(); Advertise = $advertise.Trim() }
  }
  return @{ Proxy = 'http://host.docker.internal:8788'; Advertise = 'https://host.docker.internal:8789' }
}
function Ensure-WindowsFeatures {
  $restart = $false
  $features = if ($WindowsRuntime -eq 'container') { @('Microsoft-Hyper-V-All','Containers') } else { @('Microsoft-Hyper-V-All') }
  foreach ($featureName in $features) { $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName -ErrorAction SilentlyContinue; if ($feature.State -ne 'Enabled') { $result = Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart; if ($result.RestartNeeded) { $restart = $true } } }
  return $restart
}
function Assert-WindowsContainerHost {
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Engine is required.' }
  try { $engine = (docker info --format '{{.OSType}}' 2>$null).Trim() } catch { $engine = '' }
  if ($engine -ne 'windows') { throw 'Docker must be running the Windows engine.' }
}
function Assert-HyperVHost {
  Get-VMHost -ErrorAction Stop | Out-Null
  $switchName = [Environment]::GetEnvironmentVariable('MARS_HYPERV_SWITCH_NAME')
  if ([string]::IsNullOrWhiteSpace($switchName)) { $switchName = 'Default Switch' }
  if (-not (Get-VMSwitch -Name $switchName -ErrorAction SilentlyContinue)) { throw "Hyper-V switch '$switchName' was not found. Set MARS_HYPERV_SWITCH_NAME to an existing external or NAT switch." }
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
function Invoke-MarsInstalledCheckpointProbe {
  param([Parameter(Mandatory)][string]$CheckpointPath)
  $vmcx = @(Get-ChildItem -LiteralPath $CheckpointPath -Recurse -File -Filter '*.vmcx')
  if ($vmcx.Count -ne 1) { throw 'Disposable probe requires exactly one .vmcx file.' }
  $name = 'mars-provision-probe-' + [guid]::NewGuid().ToString('N').Substring(0,10)
  $root = Join-Path ([IO.Path]::GetTempPath()) $name; $created = $false
  try {
    $vm = Import-VM -Path $vmcx[0].FullName -Copy -GenerateNewId -VirtualMachinePath $root -VhdDestinationPath $root
    Rename-VM -VM $vm -NewName $name; $created = $true
    Set-VM -Name $name -AutomaticCheckpointsEnabled $false; Enable-VMIntegrationService -VMName $name -Name 'Guest Service Interface'
    Start-VM -Name $name | Out-Null
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    do { $heartbeat = (Get-VMIntegrationService -VMName $name -Name 'Heartbeat').PrimaryStatusDescription; if ($heartbeat -eq 'OK') { break }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
    if ($heartbeat -ne 'OK') { throw 'Disposable probe guest heartbeat did not become ready.' }
    $nonce = ([BitConverter]::ToString((New-MarsRandomBytes 32))).Replace('-','').ToLowerInvariant()
    $bootstrap = Join-Path $root 'probe.json'; [ordered]@{ version = 1; mode = 'probe'; nonce = $nonce } | ConvertTo-Json -Compress | Set-Content -LiteralPath $bootstrap -Encoding utf8
    Copy-VMFile -Name $name -SourcePath $bootstrap -DestinationPath 'C:\ProgramData\Mars\bootstrap.json' -FileSource Host -CreateFullPath -Force
    $deadline = [DateTime]::UtcNow.AddMinutes(10)
    do { $state = (Get-VM -Name $name).State.ToString(); if ($state -eq 'Off') { break }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
    if ($state -ne 'Off') { throw 'Legacy checkpoint guest cannot answer the credential-free nonce probe. Rebuild it with the current Mars guest agent.' }
    $diskPath = (Get-VMHardDiskDrive -VMName $name | Select-Object -First 1).Path
    $disk = Mount-VHD -Path $diskPath -ReadOnly -Passthru | Get-Disk
    $partition = Get-Partition -DiskNumber $disk.Number | Where-Object Type -eq 'Basic' | Sort-Object Size -Descending | Select-Object -First 1
    $letter = (68..90 | ForEach-Object { [char]$_ } | Where-Object { -not (Test-Path "$($_):\") } | Select-Object -First 1); $access = "$letter`:\"
    Add-PartitionAccessPath -DiskNumber $partition.DiskNumber -PartitionNumber $partition.PartitionNumber -AccessPath $access
    try {
      $resultPath = Join-Path $access 'ProgramData\Mars\provisioning-probe.json'; $bytes = [IO.File]::ReadAllBytes($resultPath); $result = [Text.UTF8Encoding]::new($false).GetString($bytes) | ConvertFrom-Json
      if ([int]$result.version -ne 1 -or $result.success -ne $true -or $result.nonce -cne $nonce) { throw 'Legacy checkpoint returned invalid probe evidence.' }
      return [pscustomobject]@{ passed = $true; nonceSha256 = 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap).Hash.ToLowerInvariant(); resultSha256 = Get-MarsSha256Digest $bytes; observedAt = [DateTime]::UtcNow.ToString('o') }
    } finally { Remove-PartitionAccessPath -DiskNumber $partition.DiskNumber -PartitionNumber $partition.PartitionNumber -AccessPath $access -ErrorAction SilentlyContinue; Dismount-VHD -Path $diskPath -ErrorAction SilentlyContinue }
  } finally {
    if ($created -and (Get-VM -Name $name -ErrorAction SilentlyContinue)) { Stop-VM -Name $name -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -Name $name -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-WindowsCheckpoint([string]$ArchivePath,[string]$Root,[string]$Sha256,[string]$ValidatorModule) {
  $checkpointPath = Join-Path $Root "checkpoints\$Sha256"; $checkpointStaging = "$checkpointPath.partial.$([guid]::NewGuid().ToString('N'))"
  try {
    if (-not (Test-Path -LiteralPath $checkpointPath -PathType Container)) {
      Expand-Archive -LiteralPath $ArchivePath -DestinationPath $checkpointStaging
      $checkpointConfigs = @(Get-ChildItem -LiteralPath $checkpointStaging -Recurse -File -Filter '*.vmcx')
      if ($checkpointConfigs.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $checkpointStaging 'manifest.json') -PathType Leaf)) { throw 'Windows VM checkpoint archive must contain one .vmcx configuration and manifest.json.' }
      Import-Module $ValidatorModule -Force
      $manifest = Get-Content -LiteralPath (Join-Path $checkpointStaging 'manifest.json') -Raw | ConvertFrom-Json
      if ([int]$manifest.format -eq 2) {
        $manifest = Test-MarsCheckpointManifest -Root $checkpointStaging -PassThru
        $probe = $manifest.probe; $imageDigest = $manifest.imageDigest; $contentDigest = $manifest.contentDigest; $ready = $true; $remediation = $null
      } elseif ([int]$manifest.format -eq 1) {
        $listed = @($manifest.files); $actual = @(Get-ChildItem -LiteralPath $checkpointStaging -Recurse -File | Where-Object Name -ne 'manifest.json')
        if ($listed.Count -ne $actual.Count) { throw 'Legacy checkpoint contains listed or unlisted payload.' }
        $stagingPrefix = [IO.Path]::GetFullPath($checkpointStaging).TrimEnd('\') + '\'; $seen = @{}
        foreach ($file in $listed) {
          $relative = ([string]$file.path).Replace('/','\'); $path = [IO.Path]::GetFullPath((Join-Path $checkpointStaging $relative))
          if (-not $path.StartsWith($stagingPrefix,[StringComparison]::OrdinalIgnoreCase) -or $seen.ContainsKey($path)) { throw "Legacy checkpoint path is invalid or duplicated: $($file.path)" }
          $seen[$path] = $true
          if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item $path).Length -ne [int64]$file.length -or (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne ([string]$file.sha256).Replace('sha256:','')) { throw "Legacy checkpoint file verification failed: $($file.path)" }
        }
        $imageDigest = "sha256:$Sha256"; $contentDigest = Get-MarsCheckpointContentDigest $checkpointStaging
        try { $probe = Invoke-MarsInstalledCheckpointProbe $checkpointStaging; $ready = $true; $remediation = $null }
        catch { $probe = $null; $ready = $false; $remediation = 'Rebuild or upgrade the checkpoint with the current Mars guest agent so it can answer the credential-free nonce probe.' }
      } else { throw 'Windows VM checkpoint manifest format must be 1 or 2.' }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $checkpointPath) | Out-Null
      Move-Item -LiteralPath $checkpointStaging -Destination $checkpointPath
    } else {
      Import-Module $ValidatorModule -Force
      $existingManifest = Get-Content -LiteralPath (Join-Path $checkpointPath 'manifest.json') -Raw | ConvertFrom-Json
      if ([int]$existingManifest.format -eq 1) {
        Get-ChildItem -LiteralPath $checkpointPath -Recurse -File | ForEach-Object { $_.IsReadOnly = $false }
        Remove-Item -LiteralPath $checkpointPath -Recurse -Force
        return Install-WindowsCheckpoint $ArchivePath $Root $Sha256 $ValidatorModule
      }
      $manifest = Test-MarsCheckpointManifest -Root $checkpointPath -PassThru
      $probe = $manifest.probe; $imageDigest = $manifest.imageDigest; $contentDigest = $manifest.contentDigest; $ready = $true; $remediation = $null
    }
    Get-ChildItem -LiteralPath $checkpointPath -Recurse -File | ForEach-Object { $_.IsReadOnly = $true }
    $checkpointAcl = & icacls.exe $checkpointPath /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)R' '*S-1-5-32-544:(OI)(CI)R' /t 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed to secure Windows VM checkpoint: $($checkpointAcl -join ' ')" }
    return [pscustomobject]@{ Path = $checkpointPath; ImageDigest = $imageDigest; ContentDigest = $contentDigest; Probe = $probe; Ready = $ready; Remediation = $remediation }
  } finally { Remove-Item -LiteralPath $checkpointStaging -Recurse -Force -ErrorAction SilentlyContinue }
}
function Set-WorkerCacheFirewall([string]$Program) {
  $ports = @(
    Resolve-CachePort 'MARS_CACHE_PROXY_PORT' 8788
    Resolve-CachePort 'MARS_CACHE_DATA_PORT' 8789
  )
  Get-NetFirewallRule -DisplayName 'Mars Worker Cache' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
  New-NetFirewallRule -DisplayName 'Mars Worker Cache' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ports -Program $Program -Profile Any -RemoteAddress LocalSubnet | Out-Null
}
function Set-WorkerCacheServiceEnvironment {
  $servicePath = 'HKLM:\SYSTEM\CurrentControlSet\Services\MarsWorker'
  $values = @((Get-ItemPropertyValue -Path $servicePath -Name Environment -ErrorAction Stop))
  $values = @($values | Where-Object { $_ -notmatch '^MARS_CACHE_(PROXY_URL|ADVERTISE_URL)=' })
  $origins = Resolve-ContainerCacheOrigins
  $values += "MARS_CACHE_PROXY_URL=$($origins.Proxy)","MARS_CACHE_ADVERTISE_URL=$($origins.Advertise)"
  New-ItemProperty -Path $servicePath -Name Environment -PropertyType MultiString -Value $values -Force | Out-Null
}
function Set-WorkerServiceRecovery {
  $failure = & sc.exe failure MarsWorker 'reset= 86400' 'actions= restart/5000/restart/30000/restart/60000' 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to configure MarsWorker recovery: $($failure -join ' ')" }
  $failureFlag = & sc.exe failureflag MarsWorker 1 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to configure MarsWorker failure flag: $($failureFlag -join ' ')" }
}
function Invoke-MarsUpgradeFault([string]$Boundary) {
  if ([Environment]::GetEnvironmentVariable('MARS_UPGRADE_FAIL_AT') -eq $Boundary) { throw "Injected upgrade failure at $Boundary." }
}
function Invoke-WorkerUpgrade {
  param([string]$Root, [string]$Bin)
  $identityPath = Join-Path $Root 'worker-identity.json'; if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf)) { throw 'Upgrade requires an existing worker identity.' }
  $service = Get-Service MarsWorker -ErrorAction SilentlyContinue; if (-not $service) { throw 'Upgrade requires an existing MarsWorker service.' }
  $serviceWasRunning = $service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running
  $orchestratorPath = Join-Path $Bin 'mars-orchestrator.exe'; $serviceHostPath = Join-Path $Bin 'mars-service-host.exe'; $trayPath = Join-Path $Bin 'mars-worker-tray.ps1'
  foreach ($required in @($orchestratorPath,$serviceHostPath)) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Upgrade requires installed file '$required'." } }
  $upgradeStaging = Join-Path ([IO.Path]::GetTempPath()) ('mars-worker-upgrade-' + [guid]::NewGuid().ToString('N')); $backup = Join-Path $upgradeStaging 'backup'; New-Item -ItemType Directory -Force -Path $upgradeStaging,$backup | Out-Null
  $servicePath = 'HKLM:\SYSTEM\CurrentControlSet\Services\MarsWorker'; $imageStatePath = Join-Path $Root 'vm-provisioning\image-state.json'
  $targets = [ordered]@{ orchestrator=$orchestratorPath; serviceHost=$serviceHostPath; tray=$trayPath; imageState=$imageStatePath }
  $present = @{}; $environmentKind = $null; $environmentValue = @()
  $newImagePath = $null; $newImageInstalled = $false; $checkpoint = $null; $stagedCheckpoint = $null; $committed = $false; $mutationStarted = $false; $upgradeSourceMode = 'checkpoint'; $upgradeSourcePath = ''; $upgradeCustomScript = ''
  try {
    $stagedOrchestrator = Join-Path $upgradeStaging 'mars-orchestrator.exe'; $stagedServiceHost = Join-Path $upgradeStaging 'mars-service-host.exe'; $stagedTray = Join-Path $upgradeStaging 'mars-worker-tray.ps1'
    Download-Verified $WindowsOrchestratorUrl $WindowsOrchestratorSha256 $stagedOrchestrator 'Windows orchestrator'; Download-Verified $WindowsServiceHostUrl $WindowsServiceHostSha256 $stagedServiceHost 'Windows service host'; Download-Verified $WindowsTrayScriptUrl $WindowsTrayScriptSha256 $stagedTray 'Windows tray script'
    if ($WindowsRuntime -eq 'vm') {
      Assert-HyperVHost
      if ($WindowsCheckpointUrl) {
        $archive = Join-Path $upgradeStaging 'checkpoint.zip'; $bundle = Join-Path $upgradeStaging 'provisioner.zip'; $bundleRoot = Join-Path $upgradeStaging 'provisioner'
        Download-Verified $WindowsCheckpointUrl $WindowsCheckpointSha256 $archive 'Windows VM checkpoint'; Download-Verified $WindowsVmProvisionerUrl $WindowsVmProvisionerSha256 $bundle 'Windows VM provisioner'; Expand-MarsProvisionerBundle $bundle $bundleRoot
        $stagedCheckpoint = Install-WindowsCheckpoint $archive (Join-Path $upgradeStaging 'image') $WindowsCheckpointSha256 (Join-Path $bundleRoot 'windows-hyperv-checkpoint.psm1')
      } elseif (Test-Path -LiteralPath $imageStatePath -PathType Leaf) {
        $priorImage = Get-Content -LiteralPath $imageStatePath -Raw | ConvertFrom-Json
        if ($priorImage.sourceMode -in @('iso','vhdx')) {
          $upgradeSourceMode = [string]$priorImage.sourceMode; $upgradeSourcePath = [string]$priorImage.source.path; $upgradeCustomScript = [string]$priorImage.source.customScriptPath
          $WindowsSourceSha256 = ([string]$priorImage.source.sha256).Replace('sha256:',''); $WindowsImageName = [string]$priorImage.source.imageName; $WindowsCustomProvisioningScriptSha256 = ([string]$priorImage.source.customScriptSha256).Replace('sha256:',''); $AcceptWindowsLicenseTerms = [bool]$priorImage.source.acceptedLicenseTerms
          if (-not $upgradeSourcePath -or -not (Test-Path -LiteralPath $upgradeSourcePath -PathType Leaf)) { throw 'Persisted local Windows source is unavailable; restore it before upgrading.' }
          if ($upgradeSourceMode -eq 'iso' -and -not $AcceptWindowsLicenseTerms) { throw 'Persisted ISO license acceptance evidence is missing; run a fresh enrollment to rebuild this image.' }
          $bundle = Join-Path $upgradeStaging 'provisioner.zip'; $bundleRoot = Join-Path $upgradeStaging 'provisioner'; $jobAgent = Join-Path $upgradeStaging 'mars-job-agent.exe'; $runner = Join-Path $upgradeStaging 'runner.zip'; $git = Join-Path $upgradeStaging 'git.zip'; $vc = Join-Path $upgradeStaging 'vc_redist.x64.exe'
          Download-Verified $WindowsVmProvisionerUrl $WindowsVmProvisionerSha256 $bundle 'Windows VM provisioner'; Expand-MarsProvisionerBundle $bundle $bundleRoot
          Download-Verified $WindowsJobAgentUrl $WindowsJobAgentSha256 $jobAgent 'Windows job agent'; Download-Verified $WindowsRunnerUrl $WindowsRunnerSha256 $runner 'Actions Runner'; Download-Verified $WindowsGitUrl $WindowsGitSha256 $git 'Git'; Download-Verified $WindowsVcRuntimeUrl $WindowsVcRuntimeSha256 $vc 'VC runtime'
          $switchName = [Environment]::GetEnvironmentVariable('MARS_HYPERV_SWITCH_NAME'); if ([string]::IsNullOrWhiteSpace($switchName)) { $switchName = 'Default Switch' }
          $arguments = @{ SourceType=$upgradeSourceMode;SourcePath=$upgradeSourcePath;SourceSha256=$WindowsSourceSha256;JobAgentPath=$jobAgent;JobAgentSha256=$WindowsJobAgentSha256;RunnerArchivePath=$runner;RunnerArchiveSha256=$WindowsRunnerSha256;GitArchivePath=$git;GitArchiveSha256=$WindowsGitSha256;VcRuntimePath=$vc;VcRuntimeSha256=$WindowsVcRuntimeSha256;ProvisionerSha256=$WindowsVmProvisionerSha256;OutputRoot=(Join-Path $upgradeStaging 'rebuilt');SwitchName=$switchName;WindowsImageName=$WindowsImageName;CustomScriptPath=$upgradeCustomScript;CustomScriptSha256=$WindowsCustomProvisioningScriptSha256;AcceptWindowsLicenseTerms=[bool]$AcceptWindowsLicenseTerms }
          $rebuiltPath = @(& (Join-Path $bundleRoot 'provision-windows-hyperv-image.ps1') @arguments)[-1]
          Import-Module (Join-Path $bundleRoot 'windows-hyperv-checkpoint.psm1') -Force; $rebuiltManifest = Test-MarsCheckpointManifest -Root $rebuiltPath -PassThru
          $stagedCheckpoint = [pscustomobject]@{ Path=$rebuiltPath;ImageDigest=$rebuiltManifest.imageDigest;ContentDigest=$rebuiltManifest.contentDigest;Probe=$rebuiltManifest.probe;Ready=$true;Remediation=$null }
        }
      }
      if ($stagedCheckpoint) {
        $newImagePath = Join-Path (Join-Path $Root 'checkpoints') (Split-Path -Leaf $stagedCheckpoint.Path)
        $checkpoint = [pscustomobject]@{ Path=$newImagePath;ImageDigest=$stagedCheckpoint.ImageDigest;ContentDigest=$stagedCheckpoint.ContentDigest;Probe=$stagedCheckpoint.Probe;Ready=$stagedCheckpoint.Ready;Remediation=$stagedCheckpoint.Remediation }
      }
    }
    foreach ($entry in $targets.GetEnumerator()) { $present[$entry.Key] = Test-Path -LiteralPath $entry.Value -PathType Leaf; if ($present[$entry.Key]) { Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $backup $entry.Key) -Force } }
    $environmentKind = (Get-Item -LiteralPath $servicePath).GetValueKind('Environment'); $environmentValue = @((Get-ItemPropertyValue -Path $servicePath -Name Environment -ErrorAction Stop))
    $values = @($environmentValue | Where-Object { $_ -notmatch '^MARS_WORKER_(VERSION|CONTRACT_VERSION)=' })
    if ($checkpoint) { $values = @($values | Where-Object { $_ -notmatch '^MARS_WINDOWS_(TEMPLATE|CHECKPOINT)_(PATH|DIGEST)=' }); $values += "MARS_WINDOWS_CHECKPOINT_PATH=$newImagePath","MARS_WINDOWS_CHECKPOINT_DIGEST=$($checkpoint.ImageDigest)" }
    $values += "MARS_WORKER_VERSION=$WorkerVersion","MARS_WORKER_CONTRACT_VERSION=$WorkerContractVersion"
    if ($WindowsRuntime -eq 'container') { $values = @($values | Where-Object { $_ -notmatch '^MARS_CACHE_(PROXY_URL|ADVERTISE_URL)=' }); $origins = Resolve-ContainerCacheOrigins; $values += "MARS_CACHE_PROXY_URL=$($origins.Proxy)","MARS_CACHE_ADVERTISE_URL=$($origins.Advertise)" }
    $mutationStarted = $true
    if ($serviceWasRunning) { Stop-Service MarsWorker -Force -ErrorAction Stop; (Get-Service MarsWorker).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(30)) }
    Copy-Item -LiteralPath $stagedOrchestrator -Destination $orchestratorPath -Force; Copy-Item -LiteralPath $stagedServiceHost -Destination $serviceHostPath -Force; Copy-Item -LiteralPath $stagedTray -Destination $trayPath -Force
    Invoke-MarsUpgradeFault 'after-binaries'
    if ($checkpoint) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $newImagePath) | Out-Null
      if (Test-Path -LiteralPath $newImagePath) {
        $existingImage = Test-MarsCheckpointManifest -Root $newImagePath -PassThru
        if ($existingImage.imageDigest -ne $checkpoint.ImageDigest -or $existingImage.contentDigest -ne $checkpoint.ContentDigest) { throw 'A checkpoint recipe collision already exists and was not overwritten.' }
        Remove-Item -LiteralPath $stagedCheckpoint.Path -Recurse -Force
      } else {
        Move-Item -LiteralPath $stagedCheckpoint.Path -Destination $newImagePath
        $newImageInstalled = $true
      }
      Write-MarsImageState $checkpoint $upgradeSourceMode $upgradeSourcePath $upgradeCustomScript
    }
    Invoke-MarsUpgradeFault 'after-image-state'
    New-ItemProperty -Path $servicePath -Name Environment -PropertyType MultiString -Value $values -Force | Out-Null
    Invoke-MarsUpgradeFault 'after-environment'
    if ($serviceWasRunning) {
      Start-Service MarsWorker -ErrorAction Stop; (Get-Service MarsWorker).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30))
      $healthyUntil = (Get-Date).AddSeconds(5); do { Start-Sleep -Milliseconds 500; $current = Get-Service MarsWorker -ErrorAction Stop; if ($current.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) { throw 'MarsWorker stopped during the post-upgrade health window.' } } while ((Get-Date) -lt $healthyUntil)
    }
    Invoke-MarsUpgradeFault 'after-health'
    $committed = $true; Write-Output 'Windows worker upgrade complete.'
  } catch {
    $failure = $_
    if ($mutationStarted) {
      Stop-Service MarsWorker -Force -ErrorAction SilentlyContinue
      foreach ($entry in $targets.GetEnumerator()) {
        if ($present[$entry.Key]) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.Value) | Out-Null; Copy-Item -LiteralPath (Join-Path $backup $entry.Key) -Destination $entry.Value -Force }
        else { Remove-Item -LiteralPath $entry.Value -Force -ErrorAction SilentlyContinue }
      }
      Remove-ItemProperty -Path $servicePath -Name Environment -ErrorAction SilentlyContinue
      New-ItemProperty -Path $servicePath -Name Environment -PropertyType ([Microsoft.Win32.RegistryValueKind]$environmentKind) -Value $environmentValue -Force | Out-Null
      if ($newImageInstalled -and $newImagePath) { Remove-Item -LiteralPath $newImagePath -Recurse -Force -ErrorAction SilentlyContinue }
      if ($serviceWasRunning) { Start-Service MarsWorker -ErrorAction SilentlyContinue }
    }
    throw $failure
  } finally {
    if ($mutationStarted -and -not $committed -and $serviceWasRunning) { try { (Get-Service MarsWorker).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30)) } catch {} }
    Remove-Item -LiteralPath $upgradeStaging -Recurse -Force -ErrorAction SilentlyContinue
  }
}
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
function Expand-MarsProvisionerBundle {
  param([string]$Archive,[string]$Destination)
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
  $actual = @(Get-ChildItem -LiteralPath $Destination -File | Select-Object -ExpandProperty Name | Sort-Object)
  $expected = @('prepare-windows-job-image.ps1','provision-windows-hyperv-guest.ps1','provision-windows-hyperv-image.ps1','windows-hyperv-checkpoint.psm1')
  if (@(Compare-Object $expected $actual -CaseSensitive).Count -ne 0 -or @(Get-ChildItem -LiteralPath $Destination -Directory).Count -ne 0) { throw "Windows VM provisioner bundle members are invalid: $($actual -join ', ')" }
}
function Write-MarsImageState {
  param([Parameter(Mandatory)]$Checkpoint,[Parameter(Mandatory)][string]$SourceMode,[string]$DurableSource = '',[string]$DurableCustomScript = '')
  $statePath = 'C:\ProgramData\Mars\vm-provisioning\image-state.json'; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $statePath) | Out-Null
  $state = [ordered]@{
    version = 1; sourceMode = $SourceMode
    source = [ordered]@{ path = if ($DurableSource) { $DurableSource } else { $null }; sha256 = if ($WindowsSourceSha256) { "sha256:$WindowsSourceSha256" } else { $null }; imageName = if ($SourceMode -eq 'iso') { $WindowsImageName } else { $null }; acceptedLicenseTerms = $SourceMode -eq 'iso' -and [bool]$AcceptWindowsLicenseTerms; customScriptPath = if ($DurableCustomScript) { $DurableCustomScript } else { $null }; customScriptSha256 = if ($WindowsCustomProvisioningScriptSha256) { "sha256:$WindowsCustomProvisioningScriptSha256" } else { $null } }
    assets = [ordered]@{ provisionerSha256 = if ($WindowsVmProvisionerSha256) { "sha256:$WindowsVmProvisionerSha256" } else { $null }; jobAgentSha256 = if ($WindowsJobAgentSha256) { "sha256:$WindowsJobAgentSha256" } else { $null }; runnerSha256 = if ($WindowsRunnerSha256) { "sha256:$WindowsRunnerSha256" } else { $null }; gitSha256 = if ($WindowsGitSha256) { "sha256:$WindowsGitSha256" } else { $null }; vcRuntimeSha256 = if ($WindowsVcRuntimeSha256) { "sha256:$WindowsVcRuntimeSha256" } else { $null } }
    imageDigest = $Checkpoint.ImageDigest; contentDigest = $Checkpoint.ContentDigest; installedPath = $Checkpoint.Path
    verifiedAt = [DateTime]::UtcNow.ToString('o'); ready = [bool]$Checkpoint.Ready; remediation = $Checkpoint.Remediation
    probe = $Checkpoint.Probe
  }
  $partial = "$statePath.partial.$([guid]::NewGuid().ToString('N'))"
  try { $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $partial -Encoding utf8; Move-Item -LiteralPath $partial -Destination $statePath -Force }
  finally { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
  $acl = & icacls.exe $statePath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to secure VM image state: $($acl -join ' ')" }
}
Write-Host '[1/7] Checking administrator privileges'; Require-Administrator
Write-Host '[2/7] Checking Windows 11 Pro/Enterprise 24H2 x64 host'; Assert-HostPreflight; Assert-ArtifactConfiguration
$root = 'C:\ProgramData\Mars'; $bin = 'C:\Program Files\Mars'; $identityPath = Join-Path $root 'worker-identity.json'; $persistentInstallerPath = Join-Path $root 'install-worker.ps1'; $staging = Join-Path ([IO.Path]::GetTempPath()) ('mars-worker-' + [guid]::NewGuid().ToString('N'))
$transcriptStarted = $false; try { Start-Transcript -LiteralPath (Join-Path $root 'install.log') -Append | Out-Null; $transcriptStarted = $true } catch { Write-Warning "Unable to start persistent installer log: $($_.Exception.Message)" }
try {
  $durableSource = ''; $durableCustomScript = ''
  if (-not $Upgrade -and $WindowsRuntime -eq 'vm' -and $WindowsVmImageSource -ne 'checkpoint') {
    $WindowsSourcePath = Save-MarsProvisioningInput $WindowsSourcePath $WindowsSourceSha256 'Windows source'; $durableSource = $WindowsSourcePath
    if ($WindowsCustomProvisioningScriptPath) { $WindowsCustomProvisioningScriptPath = Save-MarsProvisioningInput $WindowsCustomProvisioningScriptPath $WindowsCustomProvisioningScriptSha256 'custom provisioning script'; $durableCustomScript = $WindowsCustomProvisioningScriptPath }
  }
  if (Ensure-WindowsFeatures) { New-Item -ItemType Directory -Force -Path $root | Out-Null; if ([IO.Path]::GetFullPath($PSCommandPath) -ne [IO.Path]::GetFullPath($persistentInstallerPath)) { Copy-Item -LiteralPath $PSCommandPath -Destination $persistentInstallerPath -Force }; Register-ResumeTask $persistentInstallerPath; Write-State 'reboot-required' 'pending'; Write-Host 'Windows features require a reboot; MarsWorkerInstallResume will continue automatically.'; Restart-Computer -Force; exit 0 }
  Write-Host '[3/7] Checking control-plane connectivity and validating worker artifacts'; Ensure-ControlPlane
  if ($Upgrade) { Invoke-WorkerUpgrade -Root $root -Bin $bin; exit 0 }
  if (($Resume -and [string]::IsNullOrWhiteSpace($JoinCode)) -and (Test-Path -LiteralPath $JoinCodeFile)) { $JoinCode = (Get-Content -LiteralPath $JoinCodeFile -Raw).Trim() }
  if ([string]::IsNullOrWhiteSpace($JoinCode) -or $JoinCode -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Join code is not configured.' }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $paths = [ordered]@{ orchestrator = Join-Path $staging 'mars-orchestrator.exe'; serviceHost = Join-Path $staging 'mars-service-host.exe'; tray = Join-Path $staging 'mars-worker-tray.ps1'; icon = Join-Path $staging 'MARS.ico'; checkpoint = Join-Path $staging 'windows-worker-checkpoint.zip'; provisioner = Join-Path $staging 'mars-windows-vm-provisioner.zip'; provisionerRoot = Join-Path $staging 'provisioner'; jobAgent = Join-Path $staging 'mars-job-agent.exe'; runner = Join-Path $staging 'runner.zip'; git = Join-Path $staging 'git.zip'; vc = Join-Path $staging 'vc_redist.x64.exe'; builder = Join-Path $staging 'build-image.ps1'; verifier = Join-Path $staging 'verify-runtime.ps1'; containerfile = Join-Path $staging 'Containerfile'; entrypoint = Join-Path $staging 'entrypoint.ps1'; manifest = Join-Path $staging 'windows-job-image.json' }
  Download-Verified $WindowsOrchestratorUrl $WindowsOrchestratorSha256 $paths.orchestrator 'Windows orchestrator'; Download-Verified $WindowsServiceHostUrl $WindowsServiceHostSha256 $paths.serviceHost 'Windows service host'; Download-Verified $WindowsTrayScriptUrl $WindowsTrayScriptSha256 $paths.tray 'Windows tray script'
  if ($WindowsRuntime -eq 'vm') {
    Download-Verified $WindowsVmProvisionerUrl $WindowsVmProvisionerSha256 $paths.provisioner 'Windows VM provisioner'; Expand-MarsProvisionerBundle $paths.provisioner $paths.provisionerRoot
    if ($WindowsVmImageSource -eq 'checkpoint') { Download-Verified $WindowsCheckpointUrl $WindowsCheckpointSha256 $paths.checkpoint 'Windows VM checkpoint' }
    else { Download-Verified $WindowsJobAgentUrl $WindowsJobAgentSha256 $paths.jobAgent 'Windows job agent'; Download-Verified $WindowsRunnerUrl $WindowsRunnerSha256 $paths.runner 'Actions Runner'; Download-Verified $WindowsGitUrl $WindowsGitSha256 $paths.git 'Git'; Download-Verified $WindowsVcRuntimeUrl $WindowsVcRuntimeSha256 $paths.vc 'VC runtime' }
  } else {
    Download-Verified $WindowsJobAgentUrl $WindowsJobAgentSha256 $paths.jobAgent 'Windows job agent'; Download-Verified $WindowsRunnerUrl $WindowsRunnerSha256 $paths.runner 'Actions Runner'; Download-Verified $WindowsGitUrl $WindowsGitSha256 $paths.git 'Git'; Download-Verified $WindowsVcRuntimeUrl $WindowsVcRuntimeSha256 $paths.vc 'VC runtime'; Download-Verified $WindowsContainerBuilderUrl $WindowsContainerBuilderSha256 $paths.builder 'Windows image builder'; Download-Verified $WindowsContainerVerifierUrl $WindowsContainerVerifierSha256 $paths.verifier 'Windows image verifier'; Download-Verified $WindowsContainerfileUrl $WindowsContainerfileSha256 $paths.containerfile 'Windows Containerfile'; Download-Verified $WindowsContainerEntrypointUrl $WindowsContainerEntrypointSha256 $paths.entrypoint 'Windows entrypoint'
  }
  Invoke-WebRequest -Uri "$ControlPlaneUrl/mars-icon.ico" -OutFile $paths.icon -UseBasicParsing -TimeoutSec 30
  Write-State 'artifact-download' 'complete'
  Write-Host "[4/7] Checking $WindowsRuntime runtime and installing prerequisites"
  if (-not (Test-Path -LiteralPath $JoinCodeFile)) { Set-WorkerJoinCredential $JoinCodeFile $JoinCode }
  if ($WindowsRuntime -eq 'vm') {
    Assert-HyperVHost; $validator = Join-Path $paths.provisionerRoot 'windows-hyperv-checkpoint.psm1'
    if ($WindowsVmImageSource -eq 'checkpoint') {
      $checkpoint = Install-WindowsCheckpoint $paths.checkpoint $root $WindowsCheckpointSha256 $validator
    } else {
      $switchName = [Environment]::GetEnvironmentVariable('MARS_HYPERV_SWITCH_NAME'); if ([string]::IsNullOrWhiteSpace($switchName)) { $switchName = 'Default Switch' }
      $arguments = @{ SourceType=$WindowsVmImageSource;SourcePath=$WindowsSourcePath;SourceSha256=$WindowsSourceSha256;JobAgentPath=$paths.jobAgent;JobAgentSha256=$WindowsJobAgentSha256;RunnerArchivePath=$paths.runner;RunnerArchiveSha256=$WindowsRunnerSha256;GitArchivePath=$paths.git;GitArchiveSha256=$WindowsGitSha256;VcRuntimePath=$paths.vc;VcRuntimeSha256=$WindowsVcRuntimeSha256;ProvisionerSha256=$WindowsVmProvisionerSha256;OutputRoot=(Join-Path $root 'checkpoints');SwitchName=$switchName;WindowsImageName=$WindowsImageName;CustomScriptPath=$WindowsCustomProvisioningScriptPath;CustomScriptSha256=$WindowsCustomProvisioningScriptSha256;AcceptWindowsLicenseTerms=[bool]$AcceptWindowsLicenseTerms }
      $checkpointPath = @(& (Join-Path $paths.provisionerRoot 'provision-windows-hyperv-image.ps1') @arguments)[-1]
      Import-Module $validator -Force; $manifest = Test-MarsCheckpointManifest -Root $checkpointPath -PassThru
      $checkpoint = [pscustomobject]@{ Path=$checkpointPath;ImageDigest=$manifest.imageDigest;ContentDigest=$manifest.contentDigest;Probe=$manifest.probe;Ready=$true;Remediation=$null }
    }
    $checkpointPath = $checkpoint.Path; Write-MarsImageState $checkpoint $WindowsVmImageSource $durableSource $durableCustomScript
  } else {
    Install-DockerDesktop; Switch-DockerWindowsEngine; Assert-WindowsContainerHost
    & $paths.builder -BaseImage $WindowsContainerBaseImage -RunnerArchivePath $paths.runner -RunnerSha256 $WindowsRunnerSha256 -GitArchivePath $paths.git -GitSha256 $WindowsGitSha256 -VcRuntimePath $paths.vc -VcRuntimeSha256 $WindowsVcRuntimeSha256 -JobAgent $paths.jobAgent -Image $WindowsContainerImage -ManifestPath $paths.manifest -VerifierPath $paths.verifier -ContainerfilePath $paths.containerfile -EntrypointPath $paths.entrypoint
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $paths.manifest -PathType Leaf)) { throw "Windows job image build failed with exit code $LASTEXITCODE." }
    Move-Item -LiteralPath $paths.manifest -Destination $windowsImageManifestPath -Force
  }
  Write-State 'prerequisites' 'complete'
  Write-Host '[5/7] Preparing worker replacement'
  $existingService = Get-Service MarsWorker -ErrorAction SilentlyContinue; $existingInstall = $existingService -or (Test-Path -LiteralPath $identityPath)
  if ($Upgrade -and -not (Test-Path -LiteralPath $identityPath)) { throw 'Upgrade requires an existing worker identity.' }
  if ($existingInstall -and $Upgrade) { Write-Host 'Existing Windows worker installation detected; preserving identity and resuming checkpoints.' }; if ($existingInstall -and -not $Upgrade) { Write-Host 'Existing Windows worker installation detected; replacing identity and runtime for a fresh enrollment.' }
  if ($Upgrade -and -not $existingService) { Write-Warning 'MarsWorker service is missing; recreating it during upgrade.' }
  if (-not $Upgrade) { Reset-WorkerIdentity $identityPath $false; Set-WorkerJoinCredential $JoinCodeFile $JoinCode }
  if ($existingService) { Stop-Service MarsWorker -Force -ErrorAction SilentlyContinue; $serviceDelete = & sc.exe delete MarsWorker 2>&1; if ($LASTEXITCODE -ne 0) { throw "Failed to remove existing MarsWorker service: $($serviceDelete -join ' ')" }; $deadline = (Get-Date).AddSeconds(15); while ((Get-Service MarsWorker -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }; if (Get-Service MarsWorker -ErrorAction SilentlyContinue) { throw 'Timed out removing existing MarsWorker service.' } }
  Write-Host '[6/7] Registering LocalSystem worker service'; New-Item -ItemType Directory -Force -Path $root,$bin | Out-Null
  $userState = Join-Path $root 'UserState'; New-Item -ItemType Directory -Force -Path $userState | Out-Null; & icacls.exe $userState /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-4:M' | Out-Null
  $exe = Join-Path $bin 'mars-orchestrator.exe'; $serviceHost = Join-Path $bin 'mars-service-host.exe'
  Move-Item -LiteralPath $paths.orchestrator -Destination $exe -Force; Move-Item -LiteralPath $paths.serviceHost -Destination $serviceHost -Force; Move-Item -LiteralPath $paths.tray -Destination (Join-Path $bin 'mars-worker-tray.ps1') -Force; Move-Item -LiteralPath $paths.icon -Destination (Join-Path $bin 'MARS.ico') -Force
  Set-WorkerCacheFirewall $exe
  $workerLogPath = Join-Path $root 'logs\worker.log'; $previousWorkerLogPath = Join-Path $root 'logs\worker.previous.log'; if (Test-Path -LiteralPath $workerLogPath) { New-Item -ItemType Directory -Force -Path (Split-Path $previousWorkerLogPath) | Out-Null; Move-Item -LiteralPath $workerLogPath -Destination $previousWorkerLogPath -Force }
  $service = New-Service -Name MarsWorker -BinaryPathName "`"$serviceHost`" `"$exe`" windows-worker" -StartupType Automatic -ErrorAction Stop
  if ($WindowsRuntime -eq 'container') { $serviceDependency = & sc.exe config MarsWorker depend= docker 2>&1; if ($LASTEXITCODE -ne 0) { throw "Failed to configure Docker dependency: $($serviceDependency -join ' ')" } }
$trayPath = Join-Path $bin 'mars-worker-tray.ps1'; $trayAction = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$trayPath`" -StateFile `"$userState\lease-pickup.json`" -IconPath `"$bin\MARS.ico`""; $trayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; $trayPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName 'MarsWorkerTray' -Action $trayAction -Trigger $trayTrigger -Principal $trayPrincipal -Force | Out-Null
  $serviceEnvironment = @("MARS_CONTROL_PLANE_URL=$ControlPlaneUrl","MARS_JOIN_CODE_FILE=$JoinCodeFile","MARS_LEASE_PICKUP_STATE_FILE=$userState\lease-pickup.json","MARS_WORKER_VERSION=$WorkerVersion","MARS_WORKER_CONTRACT_VERSION=$WorkerContractVersion","MARS_WINDOWS_RUNTIME=$WindowsRuntime")
  if ($WindowsRuntime -eq 'vm') {
    $serviceEnvironment += "MARS_WINDOWS_CHECKPOINT_PATH=$checkpointPath","MARS_WINDOWS_CHECKPOINT_DIGEST=$($checkpoint.ImageDigest)"
    $switchName = [Environment]::GetEnvironmentVariable('MARS_HYPERV_SWITCH_NAME'); if (-not [string]::IsNullOrWhiteSpace($switchName)) { $serviceEnvironment += "MARS_HYPERV_SWITCH_NAME=$($switchName.Trim())" }
  } else {
    $serviceEnvironment += "MARS_WINDOWS_CONTAINER_IMAGE=$WindowsContainerImage","MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST=$windowsImageManifestPath","MARS_WINDOWS_CONTAINER_PREFIX=$WindowsContainerPrefix","MARS_WINDOWS_CONTAINER_READY_TIMEOUT_MS=$WindowsContainerReadyTimeoutMs"
    $cacheOrigins = Resolve-ContainerCacheOrigins
    $serviceEnvironment += "MARS_CACHE_PROXY_URL=$($cacheOrigins.Proxy)","MARS_CACHE_ADVERTISE_URL=$($cacheOrigins.Advertise)"
    if ($AllowLocalContainerImage -or $WindowsContainerImage -eq 'mars/windows-job:local') { $serviceEnvironment += 'MARS_ALLOW_LOCAL_CONTAINER_IMAGE=true' }
  }
  foreach ($name in @('MARS_ACTION_CACHE_ROOT','MARS_CACHE_PROXY_PORT','MARS_CACHE_DATA_PORT','MARS_CACHE_TOKEN_ISSUER','MARS_CACHE_JWKS_URL','MARS_WINDOWS_CONTAINER_DNS_SERVERS')) { $value = [Environment]::GetEnvironmentVariable($name); if (-not [string]::IsNullOrWhiteSpace($value)) { $serviceEnvironment += "$name=$value" } }
  New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\MarsWorker' -Name Environment -PropertyType MultiString -Value $serviceEnvironment -Force | Out-Null
  Set-WorkerServiceRecovery
  Write-Host '[7/7] Starting worker service and waiting for enrollment'; try { Start-Service MarsWorker -ErrorAction Stop; $service = Get-Service MarsWorker -ErrorAction Stop; $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30)); Start-Sleep -Seconds 2; $service.Refresh(); if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) { throw "MarsWorker stopped immediately with status $($service.Status)." } } catch { $startupError = $_.Exception.Message; $recoveryDeadline = (Get-Date).AddSeconds(15); do { Start-Sleep -Milliseconds 500; $currentService = Get-Service MarsWorker -ErrorAction SilentlyContinue } while ($currentService -and $currentService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running -and (Get-Date) -lt $recoveryDeadline); if (-not $currentService -or $currentService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) { throw "MarsWorker failed to reach Running. Startup error: $startupError" }; Write-Warning "MarsWorker recovered after initial startup failure: $startupError" }
  Wait-WorkerEnrollment $identityPath; Remove-ResumeTask; Write-State 'complete' 'complete'; Write-Output "Windows $WindowsRuntime worker setup complete; join-code remains until authenticated."
} finally {
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
