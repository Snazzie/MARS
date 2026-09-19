[CmdletBinding()]
param(
  [string]$ControlPlaneUrl = '',
  [string]$WindowsArtifactMode = 'production',
  [ValidateSet('container','vm')][string]$WindowsRuntime = 'container',
  [string]$WindowsOrchestratorUrl = '',
  [string]$WindowsOrchestratorSha256 = '',
  [string]$WindowsServiceHostUrl = '',
  [string]$WindowsServiceHostSha256 = '',
  [string]$WindowsJobAgentUrl = '',
  [string]$WindowsJobAgentSha256 = '',
  [string]$WindowsCheckpointUrl = '',
  [string]$WindowsCheckpointSha256 = '',
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
  [string]$WindowsContainerEntrypointSha256 = ''
)

# Frozen schema-5 fixture. It intentionally models the published installer's
# accepted parameter contract and is never used as a writable compatibility path.
$PSBoundParameters
