[CmdletBinding()]
param(
  [string]$VmName = 'Windows 11 dev environment',
  [string]$AgentPath = '',
  [string]$TemplateDirectory = 'C:\ProgramData\Whitesmith\templates'
)
$ErrorActionPreference = 'Stop'

function Require-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]$identity
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell window.'
  }
}

Require-Administrator
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AgentPath = if ($AgentPath) { $AgentPath } else { Join-Path $repoRoot 'apps\job-agent\dist\whitesmith-job-agent.exe' }
if (-not (Test-Path -LiteralPath $AgentPath -PathType Leaf)) { throw "Job agent not found: $AgentPath" }
$prepare = Join-Path $PSScriptRoot 'prepare-windows-hyperv-template.ps1'
if (-not (Test-Path -LiteralPath $prepare -PathType Leaf)) { throw "Template preparation script not found: $prepare" }

$vm = Get-VM -Name $VmName -ErrorAction Stop
$diskPath = Get-VMHardDiskDrive -VMName $VmName | Select-Object -First 1 -ExpandProperty Path
if (-not $diskPath) { throw "No virtual disk attached to VM: $VmName" }
if ($vm.State -ne 'Off') {
  Stop-VM -Name $VmName -Force
  do { Start-Sleep -Seconds 2 } while ((Get-VM -Name $VmName).State -ne 'Off')
}

New-Item -ItemType Directory -Force -Path $TemplateDirectory | Out-Null
$source = Join-Path $TemplateDirectory 'windows-developer-source.vhdx'
$disk = Get-VHD -Path $diskPath
if ($disk.VhdType -eq 'Differencing' -or $disk.Path -like '*.avhdx') {
  if (Test-Path -LiteralPath $source) { Remove-Item -LiteralPath $source -Force }
  Convert-VHD -Path $diskPath -DestinationPath $source -VHDType Dynamic
} else {
  Copy-Item -LiteralPath $diskPath -Destination $source -Force
}
$sourceDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
$outputVhdx = Join-Path $TemplateDirectory 'windows.vhdx'
$outputManifest = Join-Path $TemplateDirectory 'windows-manifest.json'
$credential = Get-Credential -UserName 'WhitesmithAdmin' -Message 'Enter the local administrator credentials for the developer VM'
& $prepare -SourceVhdx $source -SourceSha256 $sourceDigest -JobAgentPath $AgentPath -OutputVhdx $outputVhdx -OutputManifest $outputManifest -GuestCredential $credential -SourceUrl 'https://developer.microsoft.com/en-us/windows/downloads/virtual-machines/'
if (-not $? -or -not (Test-Path -LiteralPath $outputVhdx -PathType Leaf) -or -not (Test-Path -LiteralPath $outputManifest -PathType Leaf)) { throw 'Template preparation did not produce the sealed VHDX and manifest.' }
$sealedDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputVhdx).Hash.ToLowerInvariant()
Write-Output "Template: $outputVhdx"
Write-Output "Manifest: $outputManifest"
Write-Output "WHITESMITH_WINDOWS_TEMPLATE_PATH=$outputVhdx"
Write-Output "WHITESMITH_WINDOWS_TEMPLATE_DIGEST=sha256:$sealedDigest"
