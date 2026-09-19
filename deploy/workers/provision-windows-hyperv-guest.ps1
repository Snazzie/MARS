[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RecipeDigest,
  [Parameter(Mandatory)][string]$JobAgentPath,[Parameter(Mandatory)][string]$JobAgentSha256,
  [Parameter(Mandatory)][string]$RunnerArchivePath,[Parameter(Mandatory)][string]$RunnerArchiveSha256,
  [Parameter(Mandatory)][string]$GitArchivePath,[Parameter(Mandatory)][string]$GitArchiveSha256,
  [Parameter(Mandatory)][string]$VcRuntimePath,[Parameter(Mandatory)][string]$VcRuntimeSha256,
  [string]$CustomScriptPath = '',[string]$CustomScriptSha256 = '',
  [int]$ImageStateTimeoutSeconds = 900,
  [string]$ResultPath = 'C:\ProgramData\Mars\image-provisioning-result.json'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'prepare-windows-job-image.ps1')

function Get-MarsSanitizedText {
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value)) { return '' }
  $sanitized = ($Value -replace '(?i)(password|token|secret|authorization)\s*[:=]\s*\S+','$1=[redacted]') -replace '[\r\n\t]+',' '
  return $sanitized.Substring(0,[Math]::Min(1024,$sanitized.Length))
}

function Disable-MarsProvisionerAccount {
  Disable-LocalUser -Name 'MarsProvisioner' -ErrorAction SilentlyContinue
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  foreach ($name in @('AutoAdminLogon','DefaultUserName','DefaultPassword','DefaultDomainName','AltDefaultUserName','AltDefaultDomainName')) { Remove-ItemProperty -Path $winlogon -Name $name -ErrorAction SilentlyContinue }
}

$success = $false
$errorText = ''
try {
  $deadline = [DateTime]::UtcNow.AddSeconds($ImageStateTimeoutSeconds)
  do {
    $state = Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State' ImageState -ErrorAction SilentlyContinue
    if ($state -eq 'IMAGE_STATE_COMPLETE') { break }
    Start-Sleep -Seconds 5
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($state -ne 'IMAGE_STATE_COMPLETE') { throw "Windows setup did not reach IMAGE_STATE_COMPLETE within $ImageStateTimeoutSeconds seconds." }

  Install-MarsWindowsGuest -JobAgentPath $JobAgentPath -JobAgentSha256 $JobAgentSha256 -RunnerArchivePath $RunnerArchivePath -RunnerArchiveSha256 $RunnerArchiveSha256 -GitArchivePath $GitArchivePath -GitArchiveSha256 $GitArchiveSha256 -VcRuntimePath $VcRuntimePath -VcRuntimeSha256 $VcRuntimeSha256 -CustomScriptPath $CustomScriptPath -CustomScriptSha256 $CustomScriptSha256
  Assert-MarsGuestInvariants
  $success = $true
} catch {
  $errorText = Get-MarsSanitizedText $_.Exception.Message
} finally {
  Disable-MarsProvisionerAccount
  Unregister-ScheduledTask -TaskName 'MarsImageProvisioning' -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath 'C:\Windows\Panther\unattend.xml','C:\Windows\Panther\Unattend\unattend.xml','C:\Windows\System32\Sysprep\unattend.xml','C:\ProgramData\Mars\image-provisioning' -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResultPath) | Out-Null
  $result = [ordered]@{ version = 1; success = $success; recipeDigest = $RecipeDigest }
  if (-not $success) { $result.error = $errorText }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding utf8
  & shutdown.exe /s /t 0 /f
}
if (-not $success) { throw "Guest provisioning failed: $errorText" }
