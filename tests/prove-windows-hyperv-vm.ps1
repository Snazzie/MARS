[CmdletBinding()]
param(
  [string]$CheckpointExportPath = 'C:\ProgramData\Mars\golden-checkpoint',
  [string]$CredentialUser = 'MarsAdmin',
  [string]$CredentialPassword = $env:MARS_HYPERV_GUEST_PASSWORD
)

$ErrorActionPreference = 'Stop'

function Is-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Is-Administrator)) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($CheckpointExportPath) { $arguments += @('-CheckpointExportPath', $CheckpointExportPath) }
  if ($CredentialUser) { $arguments += @('-CredentialUser', $CredentialUser) }
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  exit $process.ExitCode
}

$vmcx = Get-ChildItem -LiteralPath $CheckpointExportPath -Recurse -Filter '*.vmcx' -ErrorAction Stop | Select-Object -First 1
if (-not $vmcx) {
  throw "No exported VM configuration found under $CheckpointExportPath. Run setup:windows-hyperv-checkpoint once."
}

$cloneName = "mars-local-smoke-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$root = Join-Path ([IO.Path]::GetTempPath()) $cloneName
$vmFiles = Join-Path $root 'vm'
$importedName = $null
$imported = $false

New-Item -ItemType Directory -Force -Path $vmFiles | Out-Null

try {
  Write-Host "Importing disposable VM from $CheckpointExportPath..."
  $importedVm = Import-VM -Path $vmcx.FullName -Copy -GenerateNewId -VirtualMachinePath $vmFiles -VhdDestinationPath $vmFiles
  $importedName = $importedVm.Name
  Rename-VM -VM $importedVm -NewName $cloneName
  $imported = $true

  Set-VM -Name $cloneName -AutomaticCheckpointsEnabled $false
  Enable-VMIntegrationService -VMName $cloneName -Name 'Guest Service Interface'
  Start-VM -Name $cloneName | Out-Null

  $deadline = (Get-Date).AddMinutes(5)
  do {
    Start-Sleep -Seconds 2
    $heartbeat = (Get-VMIntegrationService -VMName $cloneName -Name 'Heartbeat').PrimaryStatusDescription
  } while ($heartbeat -ne 'OK' -and (Get-Date) -lt $deadline)
  if ($heartbeat -ne 'OK') { throw "Guest heartbeat did not become ready: $heartbeat" }

  if ([string]::IsNullOrWhiteSpace($CredentialPassword)) {
    throw 'Set MARS_HYPERV_GUEST_PASSWORD once; the smoke test is non-interactive.'
  }
  $securePassword = ConvertTo-SecureString $CredentialPassword -AsPlainText -Force
  $credential = [PSCredential]::new($CredentialUser, $securePassword)
  $result = Invoke-Command -VMName $cloneName -Credential $credential -ScriptBlock {
    $resultPath = 'C:\ProgramData\Mars\local-hyperv-smoke-result.json'
    New-Item -ItemType Directory -Force -Path 'C:\ProgramData\Mars' | Out-Null
    $payload = [ordered]@{ success = $true; computer = $env:COMPUTERNAME; executedAt = (Get-Date).ToUniversalTime().ToString('o'); work = 'synthetic-local-hyperv-work' }
    $payload | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8
    [pscustomobject]$payload
  }
  if (-not $result.success) { throw 'Synthetic guest work failed.' }
  $result | Format-List

  Stop-VM -Name $cloneName -Force
  $deadline = (Get-Date).AddMinutes(2)
  do { Start-Sleep -Seconds 2; $state = (Get-VM -Name $cloneName).State } while ($state -ne 'Off' -and (Get-Date) -lt $deadline)
  if ($state -ne 'Off') { throw "VM did not stop: $state" }

  Remove-VM -Name $cloneName -Force
  $imported = $false
  if (Get-VM -Name $cloneName -ErrorAction SilentlyContinue) { throw 'VM still exists after removal.' }
  Write-Host 'LOCAL HYPER-V VM SMOKE PASSED' -ForegroundColor Green
}
finally {
  foreach ($name in @($cloneName, $importedName) | Where-Object { $_ }) {
    if (Get-VM -Name $name -ErrorAction SilentlyContinue) {
      Stop-VM -Name $name -Force -ErrorAction SilentlyContinue
      Remove-VM -Name $name -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
