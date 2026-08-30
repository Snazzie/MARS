[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $root 'deploy/workers/install-worker.ps1'
$builderPath = Join-Path $root 'deploy/workers/build-windows-container-image-local.ps1'

function Get-FunctionDefinition([string]$Path, [string]$Name) {
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) { throw "Unable to parse ${Path}: $($parseErrors[0].Message)" }
  $definition = $ast.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
  }, $true)
  if (-not $definition) { throw "Function $Name was not found in $Path" }
  return [scriptblock]::Create($definition.Extent.Text)
}

function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Scenario) {
  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notmatch $Pattern) {
      throw "$Scenario threw the wrong error: $($_.Exception.Message)"
    }
    return
  }
  throw "$Scenario unexpectedly passed"
}

. (Get-FunctionDefinition $installerPath 'Assert-HttpsUrl')
. (Get-FunctionDefinition $installerPath 'Assert-ArtifactConfiguration')

$hash = 'a' * 64
$WindowsRuntime = 'vm'
$WindowsOrchestratorUrl = 'http://192.168.1.25:3000/api/workers/orchestrator?audience=windows-x64'
$WindowsServiceHostUrl = 'http://192.168.1.25:3000/api/workers/service-host?audience=windows-x64'
$WindowsTemplateUrl = 'http://192.168.1.25:3000/api/workers/templates/windows-x64/artifact'
$WindowsOrchestratorSha256 = $hash
$WindowsServiceHostSha256 = $hash
$WindowsTemplateDigest = "sha256:$hash"
$AllowInsecureHttp = $false
Assert-Throws { Assert-ArtifactConfiguration } 'must use HTTPS' 'LAN HTTP installer artifacts without AllowInsecureHttp'
$AllowInsecureHttp = $true
Assert-ArtifactConfiguration

$WindowsOrchestratorUrl = 'ftp://192.168.1.25/orchestrator.exe'
Assert-Throws { Assert-ArtifactConfiguration } 'HTTP|HTTPS|URL' 'non-HTTP installer artifact URL'

. (Get-FunctionDefinition $builderPath 'Assert-LocalImageArtifactUrl')
foreach ($url in @(
  'http://localhost:3000/runner.zip',
  'http://127.0.0.1:3000/git.zip',
  'https://downloads.example.test/vc_redist.x64.exe'
)) {
  Assert-LocalImageArtifactUrl $url 'test URL'
}
foreach ($url in @(
  'ftp://localhost/runner.zip',
  'http://user:password@localhost/runner.zip',
  '/runner.zip',
  'http://[invalid/runner.zip'
)) {
  Assert-Throws { Assert-LocalImageArtifactUrl $url 'test URL' } 'absolute HTTP or HTTPS URL|credentials' "invalid builder URL $url"
}

Write-Output 'WINDOWS_PROXY_URL_POLICY_OK'
