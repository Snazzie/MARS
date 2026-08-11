$ErrorActionPreference = 'Stop'
if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V required' }
if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V module required' }
$JoinCode = Read-Host -AsSecureString 'Whitesmith one-use enrollment code'
$Audience = 'windows-x64'
$Vhdx = Join-Path $PSScriptRoot 'operator-built-windows-worker.vhdx'
if (-not (Test-Path $Vhdx)) { throw 'Operator-built Windows Server worker VHDX is required' }
$VmName = 'whitesmith-worker'
New-VM -Name $VmName -Generation 2 -MemoryStartupBytes 4GB -VHDPath $Vhdx | Out-Null
Set-VMProcessor -VMName $VmName -Count 4 -ExposeVirtualizationExtensions $true
Set-VMNetworkAdapter -VMName $VmName -MacAddressSpoofing On
Start-VM -Name $VmName | Out-Null
Write-Host "Started $Audience worker; adoption remains pending until fingerprint approval."
