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
$results = @()
for ($i = 0; $i -lt $Iterations; $i++) {
  $leaseId = [guid]::NewGuid().ToString()
  $name = "whitesmith-proof-$($leaseId.Replace('-', ''))"
  $started = Get-Date
  try {
    docker create --name $name --isolation=hyperv --label whitesmith.managed=true --label "whitesmith.lease-id=$leaseId" --cpus 1 --memory 2GB --mount "type=bind,source=$BootstrapFile,target=C:\ProgramData\Whitesmith\bootstrap,readonly" $Image | Out-Null
    docker start $name | Out-Null
    $inspection = docker inspect $name | ConvertFrom-Json
    if ($inspection[0].HostConfig.Isolation -ne 'hyperv') { throw 'Container isolation was not Hyper-V' }
    docker wait $name | Out-Null
    $results += [pscustomobject]@{ iteration = $i + 1; runnerReadyMs = ((Get-Date) - $started).TotalMilliseconds }
  } finally {
    docker rm -f $name 2>$null | Out-Null
  }
}
$remaining = @(docker ps -a --filter 'label=whitesmith.managed=true' --filter 'label=whitesmith.lease-id' --format '{{.ID}}')
$passed = $remaining.Count -eq 0 -and (($results | Where-Object { $_.runnerReadyMs -ge 15000 }).Count -eq 0)
[pscustomobject]@{ image = $Image; isolation = 'hyperv'; iterations = $Iterations; runnerReadyMs = @($results | ForEach-Object runnerReadyMs); cleanupVerified = ($remaining.Count -eq 0); passed = $passed } | ConvertTo-Json -Compress
if (-not $passed) { exit 1 }
