[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BaseImage,
  [Parameter(Mandatory = $true)][string]$RunnerUrl,
  [Parameter(Mandatory = $true)][string]$RunnerSha256,
  [Parameter(Mandatory = $true)][string]$GitUrl,
  [Parameter(Mandatory = $true)][string]$GitSha256,
  [Parameter(Mandatory = $true)][string]$VcRuntimeUrl,
  [Parameter(Mandatory = $true)][string]$VcRuntimeSha256,
  [Parameter(Mandatory = $true)][string]$JobAgent,
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$VerifierPath,
  [Parameter(Mandatory = $true)][string]$ContainerfilePath,
  [Parameter(Mandatory = $true)][string]$EntrypointPath
)
$ErrorActionPreference = 'Stop'
if ($BaseImage -notmatch '^mcr\.microsoft\.com/windows/server:ltsc2025@sha256:[0-9a-f]{64}$') { throw 'BaseImage must be a digest-pinned mcr.microsoft.com/windows/server:ltsc2025 reference' }
foreach ($url in @(@{ Value = $RunnerUrl; Name = 'RunnerUrl' }, @{ Value = $GitUrl; Name = 'GitUrl' }, @{ Value = $VcRuntimeUrl; Name = 'VcRuntimeUrl' })) {
  if ($url.Value -notmatch '^https://') { throw "$($url.Name) must use HTTPS." }
}
foreach ($hash in @(@{ Value = $RunnerSha256; Name = 'RunnerSha256' }, @{ Value = $GitSha256; Name = 'GitSha256' }, @{ Value = $VcRuntimeSha256; Name = 'VcRuntimeSha256' })) {
  if ($hash.Value -notmatch '^[0-9a-fA-F]{64}$') { throw "$($hash.Name) must be a SHA-256 hex digest" }
}
foreach ($path in @($JobAgent, $VerifierPath)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Input not found: $path" } }
$root = Split-Path -Parent $ManifestPath
New-Item -ItemType Directory -Force -Path $root | Out-Null
$temp = Join-Path $root ("image-build-" + [guid]::NewGuid().ToString('N'))
$context = Join-Path $temp 'context'
$probe = "whitesmith-image-probe-$([guid]::NewGuid().ToString('N'))"
function Download-Verified([string]$Url, [string]$Hash, [string]$Destination, [string]$Name) {
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 300
  $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
  if ($actual -ine $Hash) { throw "$Name hash mismatch: expected $Hash, got $actual" }
}
function Docker-Checked([string[]]$Arguments, [string]$Operation) {
  $output = & docker @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "$Operation failed: $($output -join ' ' | ForEach-Object { $_.ToString() } | Out-String).Trim()" }
  return @($output)
}
try {
  New-Item -ItemType Directory -Force -Path $context | Out-Null
  Download-Verified $RunnerUrl $RunnerSha256 (Join-Path $context 'runner.zip') 'Runner archive'
  Download-Verified $GitUrl $GitSha256 (Join-Path $context 'git.zip') 'Git archive'
  Download-Verified $VcRuntimeUrl $VcRuntimeSha256 (Join-Path $context 'vc_redist.x64.exe') 'VC runtime installer'
  Copy-Item -LiteralPath $JobAgent -Destination (Join-Path $context 'whitesmith-job-agent.exe')
  Copy-Item -LiteralPath $VerifierPath -Destination (Join-Path $context 'verify-runtime.ps1')
  Copy-Item -LiteralPath $ContainerfilePath -Destination (Join-Path $context 'Containerfile')
  Copy-Item -LiteralPath $EntrypointPath -Destination (Join-Path $context 'entrypoint.ps1')
  Docker-Checked @('pull', $BaseImage) 'docker pull' | Out-Null
  Docker-Checked @('build', '--file', (Join-Path $context 'Containerfile'), '--build-arg', "BASE_IMAGE=$BaseImage", '--tag', $Image, $context) 'docker build' | Out-Null
  $expectedEntrypoint = @('powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:/Whitesmith/entrypoint.ps1')
  $imageInspection = (Docker-Checked @('image', 'inspect', '--format', '{{json .}}', $Image) 'docker image inspect' | Select-Object -Last 1 | ConvertFrom-Json)
  $entrypointJson = ($imageInspection.Config.Entrypoint | ConvertTo-Json -Compress).Trim()
  if ($entrypointJson -ne ($expectedEntrypoint | ConvertTo-Json -Compress)) { throw 'Windows image entrypoint is invalid' }
  Docker-Checked @('create', '--name', $probe, '--entrypoint', 'powershell.exe', '--isolation=hyperv', '--label', 'whitesmith.managed=true', '--label', "whitesmith.lease-id=$([guid]::NewGuid())", $Image, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'C:\Whitesmith\verify-runtime.ps1', '-RequireNetwork') | Out-Null
  Docker-Checked @('start', $probe) 'docker start' | Out-Null
  $inspection = @(Docker-Checked @('inspect', $probe) 'docker inspect' | ConvertFrom-Json)
  if ($inspection[0].HostConfig.Isolation -ne 'hyperv') { throw 'Runtime probe was not Hyper-V isolated.' }
  $exitCode = [int](Docker-Checked @('wait', $probe) 'docker wait' | Select-Object -Last 1)
  if ($exitCode -ne 0) {
    $logs = ((& docker logs $probe 2>&1) -join ' ') -replace '\s+', ' '
    if ($logs.Length -gt 2000) { $logs = $logs.Substring(0, 2000) }
    throw "Runtime probe failed with exit code ${exitCode}: $logs"
  }
  $runtimeProbe = ((& docker logs $probe 2>&1) -join '').Trim() | ConvertFrom-Json
  if (-not $runtimeProbe.mediaFoundation -or -not $runtimeProbe.dns -or -not $runtimeProbe.tcp443) { throw 'Runtime probe did not verify Media Foundation, DNS, and TCP egress.' }
  $imageId = (Docker-Checked @('image', 'inspect', '--format', '{{.Id}}', $Image) 'docker image inspect' | Select-Object -Last 1).Trim()
  $manifest = [ordered]@{ schemaVersion = 1; baseImage = $BaseImage; runnerSha256 = $RunnerSha256.ToLowerInvariant(); gitSha256 = $GitSha256.ToLowerInvariant(); vcRuntimeSha256 = $VcRuntimeSha256.ToLowerInvariant(); jobAgentSha256 = (Get-FileHash -LiteralPath $JobAgent -Algorithm SHA256).Hash.ToLowerInvariant(); image = $Image; imageId = $imageId; runtimeProbe = $runtimeProbe; builtAt = (Get-Date).ToUniversalTime().ToString('o') }
  $temporaryManifest = "$ManifestPath.tmp"
  $manifest | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $temporaryManifest -Encoding utf8 -NoNewline
  if (Test-Path -LiteralPath $ManifestPath) { Remove-Item -LiteralPath $ManifestPath -Force }
  Move-Item -LiteralPath $temporaryManifest -Destination $ManifestPath -Force
  $manifest | ConvertTo-Json -Depth 5 -Compress
} finally {
  & docker rm -f $probe 2>$null | Out-Null
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
