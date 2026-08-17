[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BaseImage,
  [Parameter(Mandatory = $true)][string]$RunnerArchive,
  [Parameter(Mandatory = $true)][string]$RunnerSha256,
  [Parameter(Mandatory = $true)][string]$GitArchive,
  [Parameter(Mandatory = $true)][string]$GitSha256,
  [Parameter(Mandatory = $true)][string]$VcRuntimeInstaller,
  [Parameter(Mandatory = $true)][string]$VcRuntimeSha256,
  [Parameter(Mandatory = $true)][string]$JobAgent,
  [Parameter(Mandatory = $true)][string]$Image
)
$ErrorActionPreference = 'Stop'
if ($BaseImage -notmatch '^mcr\.microsoft\.com/windows/server:ltsc2025@sha256:[0-9a-f]{64}$') { throw 'BaseImage must be a digest-pinned mcr.microsoft.com/windows/server:ltsc2025 reference' }
if ($RunnerSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'RunnerSha256 must be a SHA-256 hex digest' }
if ($GitSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'GitSha256 must be a SHA-256 hex digest' }
if ($VcRuntimeSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'VcRuntimeSha256 must be a SHA-256 hex digest' }
foreach ($path in @($RunnerArchive, $GitArchive, $VcRuntimeInstaller, $JobAgent)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Input not found: $path" } }
$actualRunner = (Get-FileHash -LiteralPath $RunnerArchive -Algorithm SHA256).Hash
if ($actualRunner -ine $RunnerSha256) { throw "Runner archive hash mismatch: expected $RunnerSha256, got $actualRunner" }
$actualGit = (Get-FileHash -LiteralPath $GitArchive -Algorithm SHA256).Hash
if ($actualGit -ine $GitSha256) { throw "Git archive hash mismatch: expected $GitSha256, got $actualGit" }
$actualVcRuntime = (Get-FileHash -LiteralPath $VcRuntimeInstaller -Algorithm SHA256).Hash
if ($actualVcRuntime -ine $VcRuntimeSha256) { throw "VC runtime installer hash mismatch: expected $VcRuntimeSha256, got $actualVcRuntime" }
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("whitesmith-windows-image-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  Copy-Item -LiteralPath $RunnerArchive -Destination (Join-Path $temp 'runner.zip')
  Copy-Item -LiteralPath $GitArchive -Destination (Join-Path $temp 'git.zip')
  Copy-Item -LiteralPath $VcRuntimeInstaller -Destination (Join-Path $temp 'vc_redist.x64.exe')
  Copy-Item -LiteralPath $JobAgent -Destination (Join-Path $temp 'whitesmith-job-agent.exe')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\images\jobs\windows\Containerfile') -Destination (Join-Path $temp 'Containerfile')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\images\jobs\windows\entrypoint.ps1') -Destination (Join-Path $temp 'entrypoint.ps1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\images\jobs\windows\verify-runtime.ps1') -Destination (Join-Path $temp 'verify-runtime.ps1')
  & docker build --build-arg "BASE_IMAGE=$BaseImage" --tag $Image $temp
  if ($LASTEXITCODE -ne 0) { throw "docker build failed with exit code $LASTEXITCODE" }
  & docker push $Image
  if ($LASTEXITCODE -ne 0) { throw "docker push failed with exit code $LASTEXITCODE" }
  $inspect = & docker image inspect --format '{{json .RepoDigests}}' $Image
  if ($LASTEXITCODE -ne 0) { throw "docker image inspect failed with exit code $LASTEXITCODE" }
  $digests = @($inspect | ConvertFrom-Json | Where-Object { $_ -like "$Image@sha256:*" })
  if ($digests.Count -ne 1) { throw "expected exactly one pushed digest for $Image, found $($digests.Count)" }
  Write-Output $digests[0]
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
