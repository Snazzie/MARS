[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceImage,
  [Parameter(Mandatory=$true)][string]$TargetImage,
  [Parameter(Mandatory=$true)][string]$RunnerArchiveUrl,
  [Parameter(Mandatory=$true)][string]$JobAgent,
  [string]$OutputManifest = '.\windows-container-image-manifest.json'
)
$ErrorActionPreference = 'Stop'
function Assert-Image([string]$Image, [string]$Name) {
  if ($Image -notmatch '^[^@\s]+@sha256:[0-9a-fA-F]{64}$') { throw "$Name must be pinned with @sha256 digest: $Image" }
}
Assert-Image $SourceImage 'SourceImage'
if ($TargetImage -notmatch '^[^@:\s]+(?:/[^@:\s]+)*/[^@:\s]+:[^@\s]+$' -and $TargetImage -notmatch '^[^@:\s]+:[^@\s]+$') { throw "TargetImage must be a repository tag used for the build: $TargetImage" }
if (-not (Test-Path -LiteralPath $JobAgent -PathType Leaf)) { throw "Job agent was not found: $JobAgent" }
$root = Join-Path ([IO.Path]::GetTempPath()) ('whitesmith-windows-image-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $root | Out-Null
try {
  Copy-Item -LiteralPath $JobAgent -Destination (Join-Path $root 'whitesmith-job-agent.exe')
  $dockerfile = @"
FROM $SourceImage
SHELL ["powershell", "-NoLogo", "-NoProfile", "-Command"]
RUN New-Item -ItemType Directory -Force C:\actions-runner | Out-Null; Invoke-WebRequest -Uri '$RunnerArchiveUrl' -OutFile C:\actions-runner\runner.zip; Expand-Archive C:\actions-runner\runner.zip -DestinationPath C:\actions-runner; Remove-Item C:\actions-runner\runner.zip
COPY whitesmith-job-agent.exe C:/whitesmith-job-agent.exe
RUN New-Item -ItemType Directory -Force C:\Whitesmith | Out-Null; New-Item -ItemType File C:\Whitesmith\guest-service.ready | Out-Null
ENTRYPOINT ["C:\\whitesmith-job-agent.exe"]
"@
  Set-Content -LiteralPath (Join-Path $root 'Dockerfile') -Value $dockerfile -NoNewline
  & docker build --pull=false --file (Join-Path $root 'Dockerfile') --tag $TargetImage $root | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Windows container image build failed.' }
  & docker push $TargetImage | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Windows container image push failed; the immutable registry digest cannot be established.' }
  $actual = (& docker image inspect --format '{{index .RepoDigests 0}}' $TargetImage 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $actual -notmatch '@sha256:[0-9a-fA-F]{64}$') { throw "Pushed image did not produce an immutable digest: $actual" }
  $manifest = [ordered]@{ sourceImage = $SourceImage; image = $actual; runnerArchiveUrl = $RunnerArchiveUrl; jobAgentSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $JobAgent).Hash.ToLowerInvariant(); createdAt = [DateTime]::UtcNow.ToString('o') }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath $OutputManifest
  Write-Output "Windows container image prepared: $actual"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
