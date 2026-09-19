[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('iso','vhdx')][string]$SourceType,
  [Parameter(Mandatory)][string]$SourcePath,[Parameter(Mandatory)][string]$SourceSha256,
  [Parameter(Mandatory)][string]$JobAgentPath,[Parameter(Mandatory)][string]$JobAgentSha256,
  [Parameter(Mandatory)][string]$RunnerArchivePath,[Parameter(Mandatory)][string]$RunnerArchiveSha256,
  [Parameter(Mandatory)][string]$GitArchivePath,[Parameter(Mandatory)][string]$GitArchiveSha256,
  [Parameter(Mandatory)][string]$VcRuntimePath,[Parameter(Mandatory)][string]$VcRuntimeSha256,
  [Parameter(Mandatory)][string]$ProvisionerSha256,
  [Parameter(Mandatory)][string]$OutputRoot,[Parameter(Mandatory)][string]$SwitchName,
  [string]$WindowsImageName = 'Windows 11 Pro',
  [string]$CustomScriptPath = '',[string]$CustomScriptSha256 = '',
  [switch]$AcceptWindowsLicenseTerms,
  [int]$SetupTimeoutMinutes = 90
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows-hyperv-checkpoint.psm1') -Force

$script:DiskSizeBytes = [int64]137438953472
$script:MemoryBytes = [int64]4294967296
$script:Vcpu = 2
$script:SecureBootTemplate = 'MicrosoftWindows'

function Assert-MarsFileHash {
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Sha256,[Parameter(Mandatory)][string]$Name)
  if ($Sha256 -notmatch '^[0-9a-f]{64}$') { throw "$Name SHA-256 must be lowercase hexadecimal." }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Name file does not exist: $Path" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { throw "$Name SHA-256 mismatch: expected $Sha256, got $actual" }
}

function New-MarsLocalRecipe {
  $customDigest = if ($CustomScriptPath) { "sha256:$CustomScriptSha256" } else { $null }
  return [pscustomobject][ordered]@{
    type = 'local'
    source = [pscustomobject][ordered]@{ kind = $SourceType; sha256 = "sha256:$SourceSha256"; imageName = if ($SourceType -eq 'iso') { $WindowsImageName } else { $null } }
    assets = [pscustomobject][ordered]@{ provisionerSha256 = "sha256:$ProvisionerSha256"; jobAgentSha256 = "sha256:$JobAgentSha256"; runnerSha256 = "sha256:$RunnerArchiveSha256"; gitSha256 = "sha256:$GitArchiveSha256"; vcRuntimeSha256 = "sha256:$VcRuntimeSha256"; customScriptSha256 = $customDigest }
    vm = [pscustomobject][ordered]@{ generation = 2; diskSizeBytes = $script:DiskSizeBytes; memoryBytes = $script:MemoryBytes; vcpu = $script:Vcpu; secureBootTemplate = $script:SecureBootTemplate; vtpm = $true }
  }
}

function Get-MarsWindowsPartitions {
  param([Parameter(Mandatory)][string]$VhdPath,[switch]$ReadOnly)
  $disk = Mount-VHD -Path $VhdPath -Passthru -ReadOnly:$ReadOnly | Get-Disk
  if ($disk.PartitionStyle -ne 'GPT') { throw 'Windows VHDX must use GPT.' }
  $partitions = @(Get-Partition -DiskNumber $disk.Number)
  $efi = @($partitions | Where-Object GptType -eq '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}')
  if ($efi.Count -ne 1) { throw 'Windows VHDX must contain one EFI System Partition.' }
  $windows = @($partitions | Where-Object { $_.Type -eq 'Basic' -and $_.Size -gt 1GB } | Sort-Object Size -Descending | Select-Object -First 1)
  if ($windows.Count -ne 1) { throw 'Windows VHDX must contain a Windows volume.' }
  return [pscustomobject]@{ Disk = $disk; Efi = $efi[0]; Windows = $windows[0] }
}

function Add-MarsTemporaryAccessPath {
  param([Parameter(Mandatory)]$Partition)
  $letter = (68..90 | ForEach-Object { [char]$_ } | Where-Object { -not (Test-Path "$($_):\") } | Select-Object -First 1)
  if (-not $letter) { throw 'No temporary drive letter is available.' }
  $path = "$letter`:\"
  Add-PartitionAccessPath -DiskNumber $Partition.DiskNumber -PartitionNumber $Partition.PartitionNumber -AccessPath $path
  return $path
}

function Remove-MarsTemporaryAccessPath {
  param($Partition,[string]$Path)
  if ($Partition -and $Path) { Remove-PartitionAccessPath -DiskNumber $Partition.DiskNumber -PartitionNumber $Partition.PartitionNumber -AccessPath $Path -ErrorAction SilentlyContinue }
}

function New-MarsWindowsDiskFromIso {
  param([Parameter(Mandatory)][string]$IsoPath,[Parameter(Mandatory)][string]$VhdPath,[Parameter(Mandatory)][string]$ImageName)
  if (-not $AcceptWindowsLicenseTerms) { throw 'ISO provisioning requires -AcceptWindowsLicenseTerms.' }
  $iso = Mount-DiskImage -ImagePath $IsoPath -Access ReadOnly -PassThru
  $windowsPath = $null; $efiPath = $null; $mountedVhd = $false; $layout = $null
  try {
    $isoVolume = $iso | Get-Volume
    $install = @('install.wim','install.esd') | ForEach-Object { Join-Path "$($isoVolume.DriveLetter):\sources" $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $install) { throw 'Windows ISO has no sources\install.wim or sources\install.esd.' }
    $images = @(Get-WindowsImage -ImagePath $install)
    $selected = @($images | Where-Object ImageName -ceq $ImageName)
    if ($selected.Count -ne 1) { throw "Windows image '$ImageName' was not found exactly once. Available images: $($images.ImageName -join ', ')" }
    New-VHD -Path $VhdPath -Dynamic -SizeBytes $script:DiskSizeBytes | Out-Null
    $disk = Mount-VHD -Path $VhdPath -Passthru | Get-Disk; $mountedVhd = $true
    Initialize-Disk -Number $disk.Number -PartitionStyle GPT
    $efi = New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'
    Format-Volume -Partition $efi -FileSystem FAT32 -NewFileSystemLabel 'SYSTEM' -Confirm:$false | Out-Null
    $null = New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}'
    $windows = New-Partition -DiskNumber $disk.Number -UseMaximumSize -GptType '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'
    Format-Volume -Partition $windows -FileSystem NTFS -NewFileSystemLabel 'Windows' -Confirm:$false | Out-Null
    $windowsPath = Add-MarsTemporaryAccessPath $windows; $efiPath = Add-MarsTemporaryAccessPath $efi
    & dism.exe /Apply-Image "/ImageFile:$install" "/Index:$($selected[0].ImageIndex)" "/ApplyDir:$windowsPath"
    if ($LASTEXITCODE -ne 0) { throw "DISM Apply-Image failed with exit code $LASTEXITCODE." }
    & bcdboot.exe (Join-Path $windowsPath 'Windows') /s $efiPath /f UEFI
    if ($LASTEXITCODE -ne 0) { throw "bcdboot failed with exit code $LASTEXITCODE." }
  } finally {
    if ($mountedVhd) {
      Remove-MarsTemporaryAccessPath $windows $windowsPath; Remove-MarsTemporaryAccessPath $efi $efiPath
      Dismount-VHD -Path $VhdPath -ErrorAction SilentlyContinue
    }
    Dismount-DiskImage -ImagePath $IsoPath -ErrorAction SilentlyContinue
  }
}

function Get-MarsPeMachine {
  param([Parameter(Mandatory)][string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  try {
    $reader = [IO.BinaryReader]::new($stream)
    $stream.Position = 0x3c; $pe = $reader.ReadInt32(); $stream.Position = $pe + 4
    return $reader.ReadUInt16()
  } finally { $stream.Dispose() }
}

function Assert-MarsGeneralizedVhdx {
  param([Parameter(Mandatory)][string]$VhdPath)
  $vhd = Get-VHD -Path $VhdPath
  if ($vhd.VhdType.ToString() -notin @('Dynamic','Fixed') -or $vhd.ParentPath) { throw 'VHDX must be fixed/dynamic and non-differencing.' }
  $layout = $null; $efiPath = $null; $windowsPath = $null
  try {
    $layout = Get-MarsWindowsPartitions -VhdPath $VhdPath -ReadOnly
    $efiPath = Add-MarsTemporaryAccessPath $layout.Efi; $windowsPath = Add-MarsTemporaryAccessPath $layout.Windows
    if (-not (Test-Path -LiteralPath (Join-Path $efiPath 'EFI\Microsoft\Boot\bootmgfw.efi'))) { throw 'EFI Windows Boot Manager is missing.' }
    $bcd = Join-Path $efiPath 'EFI\Microsoft\Boot\BCD'
    $bcdOutput = & bcdedit.exe /store $bcd /enum '{default}' 2>&1
    if ($LASTEXITCODE -ne 0 -or ($bcdOutput -join "`n") -notmatch '\\Windows\\system32\\winload\.efi') { throw 'EFI BCD does not target the selected Windows volume.' }
    $ntdll = Join-Path $windowsPath 'Windows\System32\ntdll.dll'
    if ((Get-MarsPeMachine $ntdll) -ne 0x8664) { throw 'Windows VHDX must contain x64 Windows.' }
    $hive = Join-Path $windowsPath 'Windows\System32\config\SOFTWARE'
    & reg.exe load HKLM\MarsOfflineSoftware $hive | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to load offline Windows SOFTWARE hive.' }
    try { $state = (Get-ItemProperty 'Registry::HKEY_LOCAL_MACHINE\MarsOfflineSoftware\Microsoft\Windows\CurrentVersion\Setup\State').ImageState }
    finally { [gc]::Collect(); [gc]::WaitForPendingFinalizers(); & reg.exe unload HKLM\MarsOfflineSoftware | Out-Null }
    if ($state -ne 'IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE') { throw "VHDX must be generalized; found ImageState=$state" }
  } finally {
    if ($layout) { Remove-MarsTemporaryAccessPath $layout.Windows $windowsPath; Remove-MarsTemporaryAccessPath $layout.Efi $efiPath }
    Dismount-VHD -Path $VhdPath -ErrorAction SilentlyContinue
  }
}

function Mount-MarsWindowsVolume {
  param([Parameter(Mandatory)][string]$VhdPath)
  $layout = Get-MarsWindowsPartitions -VhdPath $VhdPath
  $path = Add-MarsTemporaryAccessPath $layout.Windows
  return [pscustomobject]@{ Layout = $layout; Path = $path }
}

function Dismount-MarsWindowsVolume {
  param($Mounted,[string]$VhdPath)
  if ($Mounted) { Remove-MarsTemporaryAccessPath $Mounted.Layout.Windows $Mounted.Path }
  Dismount-VHD -Path $VhdPath -ErrorAction SilentlyContinue
}

function Add-MarsOfflineProvisioning {
  param([Parameter(Mandatory)][string]$VhdPath,[Parameter(Mandatory)][string]$RecipeDigest)
  $mounted = $null
  try {
    $mounted = Mount-MarsWindowsVolume $VhdPath
    $payload = Join-Path $mounted.Path 'ProgramData\Mars\image-provisioning'
    New-Item -ItemType Directory -Force -Path $payload | Out-Null
    Copy-Item -LiteralPath $JobAgentPath,$RunnerArchivePath,$GitArchivePath,$VcRuntimePath -Destination $payload
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'prepare-windows-job-image.ps1'),(Join-Path $PSScriptRoot 'provision-windows-hyperv-guest.ps1') -Destination $payload
    if ($CustomScriptPath) { Copy-Item -LiteralPath $CustomScriptPath -Destination (Join-Path $payload 'custom.ps1') }
    $password = [Convert]::ToBase64String((New-MarsRandomBytes 36))
    $unattend = @"
<?xml version="1.0" encoding="utf-8"?><unattend xmlns="urn:schemas-microsoft-com:unattend"><settings pass="oobeSystem"><component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><OOBE><HideEULAPage>true</HideEULAPage><HideOnlineAccountScreens>true</HideOnlineAccountScreens><ProtectYourPC>3</ProtectYourPC></OOBE><UserAccounts><LocalAccounts><LocalAccount wcm:action="add"><Name>MarsProvisioner</Name><Group>Administrators</Group><Password><Value>$password</Value><PlainText>true</PlainText></Password></LocalAccount></LocalAccounts></UserAccounts></component></settings></unattend>
"@
    $panther = Join-Path $mounted.Path 'Windows\Panther'; New-Item -ItemType Directory -Force -Path $panther | Out-Null
    [IO.File]::WriteAllText((Join-Path $panther 'unattend.xml'),$unattend,[Text.UTF8Encoding]::new($false))
    $setupScripts = Join-Path $mounted.Path 'Windows\Setup\Scripts'; New-Item -ItemType Directory -Force -Path $setupScripts | Out-Null
    $customArgs = if ($CustomScriptPath) { " -CustomScriptPath `"C:\ProgramData\Mars\image-provisioning\custom.ps1`" -CustomScriptSha256 '$CustomScriptSha256'" } else { '' }
    $command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"C:\ProgramData\Mars\image-provisioning\provision-windows-hyperv-guest.ps1`" -RecipeDigest '$RecipeDigest' -JobAgentPath `"C:\ProgramData\Mars\image-provisioning\$(Split-Path -Leaf $JobAgentPath)`" -JobAgentSha256 '$JobAgentSha256' -RunnerArchivePath `"C:\ProgramData\Mars\image-provisioning\$(Split-Path -Leaf $RunnerArchivePath)`" -RunnerArchiveSha256 '$RunnerArchiveSha256' -GitArchivePath `"C:\ProgramData\Mars\image-provisioning\$(Split-Path -Leaf $GitArchivePath)`" -GitArchiveSha256 '$GitArchiveSha256' -VcRuntimePath `"C:\ProgramData\Mars\image-provisioning\$(Split-Path -Leaf $VcRuntimePath)`" -VcRuntimeSha256 '$VcRuntimeSha256'$customArgs"
    $encoded = [Convert]::ToBase64String([Text.UnicodeEncoding]::Unicode.GetBytes("& { $command }"))
    $setup = "@echo off`r`nschtasks.exe /Create /TN MarsImageProvisioning /SC ONSTART /RU SYSTEM /RL HIGHEST /TR `"powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded`" /F`r`nschtasks.exe /Run /TN MarsImageProvisioning`r`nexit /b 0`r`n"
    [IO.File]::WriteAllText((Join-Path $setupScripts 'SetupComplete.cmd'),$setup,[Text.ASCIIEncoding]::new())
  } finally { Dismount-MarsWindowsVolume $mounted $VhdPath }
}

function Wait-MarsVmState {
  param([string]$VmName,[string]$State,[TimeSpan]$Timeout)
  $deadline = [DateTime]::UtcNow.Add($Timeout)
  do { $current = (Get-VM -Name $VmName -ErrorAction Stop).State.ToString(); if ($current -eq $State) { return }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
  throw "VM $VmName did not reach $State; current state is $current."
}

function Wait-MarsHeartbeat {
  param([string]$VmName,[TimeSpan]$Timeout)
  $deadline = [DateTime]::UtcNow.Add($Timeout)
  do { $heartbeat = (Get-VMIntegrationService -VMName $VmName -Name 'Heartbeat').PrimaryStatusDescription; if ($heartbeat -eq 'OK') { return }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
  throw "VM heartbeat did not become ready: $heartbeat"
}

function Assert-MarsOfflineProvisioningResult {
  param([string]$VhdPath,[string]$ExpectedDigest)
  $mounted = $null
  try {
    $mounted = Mount-MarsWindowsVolume $VhdPath
    $root = $mounted.Path
    $resultPath = Join-Path $root 'ProgramData\Mars\image-provisioning-result.json'
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ([int]$result.version -ne 1 -or $result.success -ne $true -or $result.recipeDigest -ne $ExpectedDigest) { throw 'Offline guest provisioning result is invalid.' }
    foreach ($path in @('Windows\Panther\unattend.xml','Windows\Panther\Unattend\unattend.xml','Windows\System32\Sysprep\unattend.xml','ProgramData\Mars\image-provisioning')) { if (Test-Path -LiteralPath (Join-Path $root $path)) { throw "Provisioning residue remains: $path" } }
    $hive = Join-Path $root 'Windows\System32\config\SOFTWARE'; & reg.exe load HKLM\MarsVerifySoftware $hive | Out-Null
    try { foreach ($name in @('AutoAdminLogon','DefaultUserName','DefaultPassword','DefaultDomainName')) { if (Get-ItemPropertyValue 'Registry::HKEY_LOCAL_MACHINE\MarsVerifySoftware\Microsoft\Windows NT\CurrentVersion\Winlogon' $name -ErrorAction SilentlyContinue) { throw "Winlogon credential value remains: $name" } } }
    finally { [gc]::Collect(); [gc]::WaitForPendingFinalizers(); & reg.exe unload HKLM\MarsVerifySoftware | Out-Null }
  } finally { Dismount-MarsWindowsVolume $mounted $VhdPath }
}

function Invoke-MarsProbe {
  param([string]$VmName,[string]$VhdPath,[string]$WorkingRoot)
  Start-VM -Name $VmName | Out-Null; Wait-MarsHeartbeat $VmName ([TimeSpan]::FromMinutes(5))
  $nonce = ([BitConverter]::ToString((New-MarsRandomBytes 32))).Replace('-','').ToLowerInvariant()
  $bootstrap = Join-Path $WorkingRoot 'probe-bootstrap.json'
  [ordered]@{ version = 1; mode = 'probe'; nonce = $nonce } | ConvertTo-Json -Compress | Set-Content -LiteralPath $bootstrap -Encoding utf8
  Copy-VMFile -Name $VmName -SourcePath $bootstrap -DestinationPath 'C:\ProgramData\Mars\bootstrap.json' -FileSource Host -CreateFullPath -Force
  Wait-MarsVmState $VmName 'Off' ([TimeSpan]::FromMinutes(10))
  $mounted = $null
  try {
    $mounted = Mount-MarsWindowsVolume $VhdPath
    $resultPath = Join-Path $mounted.Path 'ProgramData\Mars\provisioning-probe.json'
    $bytes = [IO.File]::ReadAllBytes($resultPath); $result = [Text.UTF8Encoding]::new($false).GetString($bytes) | ConvertFrom-Json
    if ([int]$result.version -ne 1 -or $result.success -ne $true -or $result.nonce -cne $nonce) { throw 'Guest provisioning probe result is invalid.' }
    Remove-Item -LiteralPath $resultPath,(Join-Path $mounted.Path 'ProgramData\Mars\bootstrap.json') -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ NonceSha256 = 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap).Hash.ToLowerInvariant(); ResultSha256 = Get-MarsSha256Digest $bytes; ObservedAt = [DateTime]::UtcNow.ToString('o') }
  } finally { Dismount-MarsWindowsVolume $mounted $VhdPath; Remove-Item -LiteralPath $bootstrap -Force -ErrorAction SilentlyContinue }
}

foreach ($asset in @(@($SourcePath,$SourceSha256,'source'),@($JobAgentPath,$JobAgentSha256,'job agent'),@($RunnerArchivePath,$RunnerArchiveSha256,'Actions Runner'),@($GitArchivePath,$GitArchiveSha256,'MinGit'),@($VcRuntimePath,$VcRuntimeSha256,'VC runtime'))) { Assert-MarsFileHash $asset[0] $asset[1] $asset[2] }
if ($ProvisionerSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Provisioner SHA-256 must be lowercase hexadecimal.' }
if ([string]::IsNullOrWhiteSpace($CustomScriptPath) -ne [string]::IsNullOrWhiteSpace($CustomScriptSha256)) { throw 'Custom script path and SHA-256 must be supplied together.' }
if ($CustomScriptPath) { Assert-MarsFileHash $CustomScriptPath $CustomScriptSha256 'custom script' }
if ($SourceType -eq 'iso' -and -not $AcceptWindowsLicenseTerms) { throw 'ISO provisioning requires -AcceptWindowsLicenseTerms.' }
if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) { throw "Hyper-V switch not found: $SwitchName" }

$recipe = New-MarsLocalRecipe; $imageDigest = Get-MarsVmRecipeDigest $recipe; $recipeHex = $imageDigest.Substring(7)
$target = Join-Path $OutputRoot $recipeHex
if (Test-Path -LiteralPath $target -PathType Container) { Test-MarsCheckpointManifest -Root $target | Out-Null; Write-Output $target; return }
$working = Join-Path ([IO.Path]::GetTempPath()) ("mars-provision-$recipeHex-" + [guid]::NewGuid().ToString('N'))
$stagingVhd = Join-Path $working 'windows.vhdx'; $export = Join-Path $working 'checkpoint-export'; $vmName = 'mars-provision-' + [guid]::NewGuid().ToString('N').Substring(0,12)
$vmCreated = $false
try {
  New-Item -ItemType Directory -Force -Path $working,$OutputRoot | Out-Null
  if ($SourceType -eq 'iso') { New-MarsWindowsDiskFromIso $SourcePath $stagingVhd $WindowsImageName }
  else { Copy-Item -LiteralPath $SourcePath -Destination $stagingVhd; Assert-MarsGeneralizedVhdx $stagingVhd }
  Add-MarsOfflineProvisioning $stagingVhd $imageDigest
  New-VM -Name $vmName -Generation 2 -MemoryStartupBytes $script:MemoryBytes -VHDPath $stagingVhd -SwitchName $SwitchName | Out-Null; $vmCreated = $true
  Set-VM -Name $vmName -ProcessorCount $script:Vcpu -AutomaticCheckpointsEnabled $false -CheckpointType Standard
  Set-VMMemory -VMName $vmName -DynamicMemoryEnabled $false -StartupBytes $script:MemoryBytes
  Set-VMFirmware -VMName $vmName -EnableSecureBoot On -SecureBootTemplate $script:SecureBootTemplate
  Set-VMKeyProtector -VMName $vmName -NewLocalKeyProtector; Enable-VMTPM -VMName $vmName
  Enable-VMIntegrationService -VMName $vmName -Name 'Guest Service Interface'
  Start-VM -Name $vmName | Out-Null; Wait-MarsVmState $vmName 'Off' ([TimeSpan]::FromMinutes($SetupTimeoutMinutes))
  Assert-MarsOfflineProvisioningResult $stagingVhd $imageDigest
  $probe = Invoke-MarsProbe $vmName $stagingVhd $working
  Start-VM -Name $vmName | Out-Null; Wait-MarsHeartbeat $vmName ([TimeSpan]::FromMinutes(5)); Start-Sleep -Seconds 15
  $checkpointName = 'mars-service-ready'; Checkpoint-VM -Name $vmName -SnapshotName $checkpointName
  Export-MarsCheckpoint -VmName $vmName -CheckpointName $checkpointName -OutputPath $export -Recipe $recipe -JobAgentSha256 "sha256:$JobAgentSha256" -NonceSha256 $probe.NonceSha256 -ProbeResultSha256 $probe.ResultSha256 -ProbeObservedAt $probe.ObservedAt -Vtpm | Out-Null
  $install = "$target.partial.$([guid]::NewGuid().ToString('N'))"; Move-Item -LiteralPath $export -Destination $install
  try { Move-Item -LiteralPath $install -Destination $target } catch { Remove-Item -LiteralPath $install -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path $target) { throw 'A checkpoint recipe collision already exists and was not overwritten.' }; throw }
  Test-MarsCheckpointManifest -Root $target | Out-Null
  Get-ChildItem -LiteralPath $target -Recurse -File | ForEach-Object { $_.IsReadOnly = $true }
  & icacls.exe $target /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)R' '*S-1-5-32-544:(OI)(CI)R' /t | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to secure installed checkpoint.' }
  Write-Output $target
} catch {
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
  throw
} finally {
  Dismount-DiskImage -ImagePath $SourcePath -ErrorAction SilentlyContinue
  Dismount-VHD -Path $stagingVhd -ErrorAction SilentlyContinue
  if ($vmCreated -and (Get-VM -Name $vmName -ErrorAction SilentlyContinue)) { Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -Name $vmName -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $working -Recurse -Force -ErrorAction SilentlyContinue
}
