[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$BootstrapFile,
  [int]$Iterations = 5
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator elevation is required' }
if ($Image -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$') { throw 'Image must be digest pinned' }
if ((docker info --format '{{.OSType}}') -ne 'windows') { throw 'Windows Docker engine is required' }
$repoDigests = @(docker image inspect --format '{{json .RepoDigests}}' $Image | ConvertFrom-Json)
if (-not ($repoDigests -contains $Image)) { throw 'Requested image digest is not present locally' }
function Get-ProbeLogs([string]$Name) {
  $logs = ((docker logs $Name 2>&1) -join ' ') -replace '\s+', ' '
  if ($logs.Length -gt 2000) { return $logs.Substring(0, 2000) }
  return $logs
}
$runtimeProbe = $null
$prerequisiteName = "whitesmith-runtime-probe-$([guid]::NewGuid().ToString('N'))"
try {
  docker create --name $prerequisiteName --entrypoint powershell.exe --isolation=hyperv --label whitesmith.managed=true --label "whitesmith.lease-id=$([guid]::NewGuid())" $Image -NoLogo -NoProfile -NonInteractive -File C:\Whitesmith\verify-runtime.ps1 -RequireNetwork | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Hyper-V runtime prerequisite probe.' }
  docker start $prerequisiteName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to start the Hyper-V runtime prerequisite probe.' }
  $inspection = @(docker inspect $prerequisiteName | ConvertFrom-Json)
  if ($inspection[0].HostConfig.Isolation -ne 'hyperv') { throw 'Runtime prerequisite probe was not Hyper-V isolated.' }
  $exitCode = [int](docker wait $prerequisiteName)
  if ($LASTEXITCODE -ne 0) { throw 'Failed waiting for the runtime prerequisite probe.' }
  if ($exitCode -ne 0) { throw "Runtime prerequisite probe failed with exit code ${exitCode}: $(Get-ProbeLogs $prerequisiteName)" }
  $runtimeProbe = ((docker logs $prerequisiteName 2>&1) -join '').Trim() | ConvertFrom-Json
  if (-not $runtimeProbe.mediaFoundation -or -not $runtimeProbe.dns -or -not $runtimeProbe.tcp443) { throw 'Runtime prerequisite probe did not verify Media Foundation, DNS, and TCP egress.' }
} finally {
  docker rm -f $prerequisiteName 2>$null | Out-Null
}
$results = @()
for ($i = 0; $i -lt $Iterations; $i++) {
  $leaseId = [guid]::NewGuid().ToString()
  $name = "whitesmith-proof-$($leaseId.Replace('-', ''))"
  $started = Get-Date
  try {
    docker create --name $name --isolation=hyperv --label whitesmith.managed=true --label "whitesmith.lease-id=$leaseId" --cpus 1 --memory 2GB --mount "type=bind,source=$BootstrapFile,target=C:\ProgramData\Whitesmith\bootstrap,readonly" $Image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create proof lease container.' }
    docker start $name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start proof lease container.' }
    $inspection = @(docker inspect $name | ConvertFrom-Json)
    if ($inspection[0].HostConfig.Isolation -ne 'hyperv') { throw 'Container isolation was not Hyper-V' }
    $exitCode = [int](docker wait $name)
    if ($LASTEXITCODE -ne 0) { throw 'Failed waiting for proof lease container.' }
    if ($exitCode -ne 0) { throw "Proof lease container failed with exit code ${exitCode}: $(Get-ProbeLogs $name)" }
    $results += [pscustomobject]@{ iteration = $i + 1; runnerReadyMs = ((Get-Date) - $started).TotalMilliseconds }
  } finally {
    docker rm -f $name 2>$null | Out-Null
  }
}
$remaining = @(docker ps -a --filter 'label=whitesmith.managed=true' --filter 'label=whitesmith.lease-id' --format '{{.ID}}')
$cleanupVerified = $remaining.Count -eq 0
$timingPassed = (($results | Where-Object { $_.runnerReadyMs -ge 15000 }).Count -eq 0)
$passed = $cleanupVerified -and $timingPassed
$output = [pscustomobject]@{ image = $Image; isolation = 'hyperv'; runtimePrerequisitesVerified = $true; runtimeProbe = $runtimeProbe; iterations = $Iterations; runnerReadyMs = @($results | ForEach-Object runnerReadyMs); cleanupVerified = $cleanupVerified; passed = $passed }
$output | ConvertTo-Json -Compress
if (-not $passed) { exit 1 }
