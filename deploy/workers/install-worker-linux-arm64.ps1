[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Code,
  [string]$ControlPlaneUrl,
  [string]$InstallRoot = 'C:\ProgramData\Mars\linux-arm64'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw $Message }
function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { Fail $Message } }
function Digest([string]$Value, [string]$Name) { Require ($Value -match '^.+@sha256:[0-9a-f]{64}$') "$Name must be a digest-pinned OCI reference" }
function Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function DockerJson([string[]]$Arguments) {
  $output = & docker @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "docker $($Arguments -join ' ') failed" }
  return ($output -join "`n") | ConvertFrom-Json
}
function InvokeDocker([string[]]$Arguments) {
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "docker $($Arguments -join ' ') failed" }
}
function RefreshDockerPath {
  $entries = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), (Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\bin'))
  $env:Path = ($entries | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_ -split ';' } | Select-Object -Unique) -join ';'
}
function InstallDockerDesktop {
  RefreshDockerPath
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { Fail 'Docker Desktop is not installed and winget is unavailable' }
    winget install --id Docker.DockerDesktop --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop installation failed with exit code $LASTEXITCODE" }
  }
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Get-Command docker.exe -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { RefreshDockerPath; Start-Sleep -Seconds 2 }
  Require (Get-Command docker.exe -ErrorAction SilentlyContinue) 'Docker Desktop did not install'
}
function SwitchDockerLinuxEngine {
  RefreshDockerPath
  $dockerCli = Join-Path ${env:ProgramFiles} 'Docker\Docker\DockerCli.exe'
  if (Test-Path -LiteralPath $dockerCli) {
    $engine = try { (& docker info --format '{{.OSType}}' 2>$null).Trim() } catch { '' }
    if ($engine -ne 'linux') {
      & $dockerCli -SwitchLinuxEngine
      if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop Linux engine switch failed with exit code $LASTEXITCODE" }
    }
  }
  $deadline = (Get-Date).AddMinutes(3)
  do { $engine = try { (& docker info --format '{{.OSType}}' 2>$null).Trim() } catch { '' }; if ($engine -eq 'linux') { return }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $deadline)
  Fail 'Docker Desktop did not become ready on the Linux engine'
}

Require ([Environment]::OSVersion.Version.Build -ge 22631) 'Windows ARM64 build 22631 or newer is required'
Require ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) 'Windows ARM64 is required'
Require (Get-Command winget -ErrorAction SilentlyContinue -or (Get-Command docker -ErrorAction SilentlyContinue)) 'winget or Docker CLI is required'
Require ($Code -match '^[A-Za-z0-9_-]{43}$') 'A valid one-use enrollment code is required'
Require ($ControlPlaneUrl -match '^(https://|http://(localhost|127\.0\.0\.1)(:\d+)?/?$)') 'ControlPlaneUrl must be HTTPS or loopback HTTP'
Require ($ArtifactMode -in @('local','production')) 'ArtifactMode must be local or production'
Digest $BrokerImage 'BrokerImage'
Digest $JobImage 'JobImage'
Require ($ComposeUrl -match '^https://|^http://(localhost|127\.0\.0\.1)') 'ComposeUrl must use HTTPS or loopback HTTP'
Require ($ComposeSha256 -match '^[0-9a-f]{64}$') 'ComposeSha256 must be lowercase SHA-256'
InstallDockerDesktop
SwitchDockerLinuxEngine
Require (Get-Command docker-compose -ErrorAction SilentlyContinue -or (& docker compose version 2>$null)) 'docker compose is required'

$server = DockerJson @('info','--format','{{json .}}')
Require ($server.OSType -eq 'linux') 'Docker must be in Linux container mode'
Require ($server.Architecture -in @('arm64','aarch64')) 'Docker must use a native ARM64 Linux engine; AMD64 emulation is not supported'
$composeVersion = & docker compose version
Require ($LASTEXITCODE -eq 0) 'docker compose is unavailable'

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$composePath = Join-Path $InstallRoot 'linux-arm64-broker-compose.yaml'
$envPath = Join-Path $InstallRoot '.env'
$tmpCompose = "$composePath.download.$PID"
try {
  Invoke-WebRequest -UseBasicParsing -Uri $ComposeUrl -OutFile $tmpCompose
  Require ((Sha256 $tmpCompose) -eq $ComposeSha256) 'Compose SHA-256 mismatch'
  $compose = Get-Content -Raw -LiteralPath $tmpCompose
  $env = @(
    "MARS_CONTROL_PLANE_URL=$ControlPlaneUrl"
    "MARS_BROKER_IMAGE=$BrokerImage"
    "MARS_JOB_IMAGE=$JobImage"
  ) -join "`n"
  $candidateCompose = "$composePath.candidate.$PID"
  $candidateEnv = "$envPath.candidate.$PID"
  Set-Content -NoNewline -Encoding utf8 -LiteralPath $candidateCompose -Value $compose
  Set-Content -NoNewline -Encoding utf8 -LiteralPath $candidateEnv -Value $env
  & docker compose --project-name mars-linux-arm64 --env-file $candidateEnv -f $candidateCompose config --quiet
  Require ($LASTEXITCODE -eq 0) 'docker compose config validation failed'
  InvokeDocker @('pull',$BrokerImage)
  InvokeDocker @('pull',$JobImage)
  $broker = DockerJson @('image','inspect','--format','{{json .}}',$BrokerImage)
  $job = DockerJson @('image','inspect','--format','{{json .}}',$JobImage)
  Require ($broker.Os -eq 'linux' -and $broker.Architecture -in @('arm64','aarch64')) 'Broker image is not Linux ARM64'
  Require ($job.Os -eq 'linux' -and $job.Architecture -in @('arm64','aarch64')) 'Job image is not Linux ARM64'
  $stateVolume = 'mars-linux-arm64-state'
  InvokeDocker @('volume','create',$stateVolume)
  $Code | & docker run --rm -i --entrypoint /bin/sh -v "$stateVolume`:/var/lib/mars" $BrokerImage -c 'umask 077; mkdir -p /var/lib/mars/config; cat > /var/lib/mars/config/join-code; chmod 0600 /var/lib/mars/config/join-code'
  Require ($LASTEXITCODE -eq 0) 'Could not persist enrollment code in the broker state volume'
  Move-Item -Force -LiteralPath $candidateCompose -Destination $composePath
  Move-Item -Force -LiteralPath $candidateEnv -Destination $envPath
  InvokeDocker @('compose','--project-name','mars-linux-arm64','--env-file',$envPath,'-f',$composePath,'up','-d')
  $deadline = (Get-Date).AddMinutes(3)
  do {
    Start-Sleep -Seconds 3
    $container = docker compose --project-name mars-linux-arm64 --env-file $envPath -f $composePath ps -q broker
    $status = if ($container) { docker inspect --format '{{.State.Status}}' $container } else { '' }
    $identity = if ($container) { docker exec $container sh -c 'test -s /var/lib/mars/config/worker-identity.json && grep -q workerId /var/lib/mars/config/worker-identity.json; echo $LASTEXITCODE' } else { '1' }
    if ($status -eq 'running' -and $identity -match '0') { break }
  } while ((Get-Date) -lt $deadline)
  Require ($status -eq 'running') 'ARM broker did not remain running'
  Require ($identity -match '0') 'ARM broker did not persist a worker identity'
  Write-Output "Mars Linux ARM64 Docker worker is running with project mars-linux-arm64."
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmpCompose, "$composePath.candidate.$PID", "$envPath.candidate.$PID"
}
