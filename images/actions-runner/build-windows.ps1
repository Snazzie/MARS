[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$WorkRoot = (Join-Path ([Environment]::CurrentDirectory) 'dist\actions-runner-build')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_CLI_USE_MSBUILD_SERVER = '0'
$env:MSBUILDDISABLENODEREUSE = '1'
$env:UseSharedCompilation = 'false'
$runnerRepository = 'https://github.com/actions/runner.git'
$runnerVersion = '2.336.0'
$runnerCommit = '98aabcd429c4e8402406c56ce2d26387fed3b9ce'
$source = Join-Path $WorkRoot 'source'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$patch = Join-Path $repositoryRoot 'images\actions-runner\patches\0001-mars-worker-cache-registration.patch'

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $WorkRoot
New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
git clone --filter=blob:none --no-checkout $runnerRepository $source
if ($LASTEXITCODE -ne 0) { throw 'Could not clone the pinned Actions Runner source.' }
git -C $source checkout --detach $runnerCommit
if ($LASTEXITCODE -ne 0) { throw 'Could not check out the pinned Actions Runner commit.' }
$resolvedCommit = (git -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $runnerCommit) { throw "Unexpected Actions Runner commit: $resolvedCommit" }
git -C $source apply --check $patch
if ($LASTEXITCODE -ne 0) { throw 'Mars Actions Runner patch does not apply cleanly.' }
git -C $source apply $patch
if ($LASTEXITCODE -ne 0) { throw 'Could not apply the Mars Actions Runner patch.' }
# Ephemeral job runners are launched by Mars and never install the upstream Windows service.
# Removing that target also avoids an unnecessary .NET Framework 4.7 targeting-pack dependency.
$dirProject = Join-Path $source 'src\dir.proj'
$dirProjectText = Get-Content -Raw -LiteralPath $dirProject
$withoutServiceBuild = [regex]::Replace($dirProjectText, '(?m)^\s*<Exec Command="[^"]*DesktopMSBuild[^"]*Runner\.Service/Windows/RunnerService\.csproj.*\r?\n', '', 1)
if ($withoutServiceBuild -eq $dirProjectText) { throw 'Could not remove the unused Windows service build target.' }
[System.IO.File]::WriteAllText($dirProject, $withoutServiceBuild, [System.Text.UTF8Encoding]::new($false))

Push-Location (Join-Path $source 'src')
try {
  & '.\dev.cmd' layout Release
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) { throw 'Patched Actions Runner build failed.' }
$layout = Join-Path $source '_layout'
$listener = Join-Path $layout 'bin\Runner.Listener.exe'
$worker = Join-Path $layout 'bin\Runner.Worker.exe'
if (-not (Test-Path -LiteralPath $listener) -or -not (Test-Path -LiteralPath $worker)) { throw 'Patched Actions Runner layout is incomplete.' }
$reportedVersion = (& $listener --version | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne $runnerVersion) { throw "Unexpected built Actions Runner version: $reportedVersion" }
$capabilities = [ordered]@{
  schemaVersion = 1
  upstreamVersion = $runnerVersion
  upstreamCommit = $runnerCommit
  capabilities = @('mars-worker-cache-registration-v1')
}
$capabilityJson = $capabilities | ConvertTo-Json -Depth 4 -Compress
[System.IO.File]::WriteAllText((Join-Path $layout '.mars-capabilities.json'), $capabilityJson, [System.Text.UTF8Encoding]::new($false))
$destination = [System.IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $destination
Compress-Archive -Path (Join-Path $layout '*') -DestinationPath $destination -CompressionLevel Optimal
if (-not (Test-Path -LiteralPath $destination)) { throw 'Patched Actions Runner archive was not created.' }
Write-Host "Built patched Actions Runner $runnerVersion from $runnerCommit at $destination"
