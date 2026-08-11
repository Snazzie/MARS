param(
    [Parameter(Mandatory=$true)]
    [string]$Code
)

$ErrorActionPreference = 'Stop'
if ($Code -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Code must be a 43-character base64url value' }
try {
    if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V required' }
    if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V module required' }
    $Audience = 'windows-x64'
    $Vhdx = Join-Path $PSScriptRoot 'operator-built-windows-worker.vhdx'
    if (-not (Test-Path $Vhdx)) { throw 'Operator-built Windows Server worker VHDX is required' }
    $VmName = 'whitesmith-worker'
    New-VM -Name $VmName -Generation 2 -MemoryStartupBytes 4GB -VHDPath $Vhdx | Out-Null
    Set-VMProcessor -VMName $VmName -Count 4 -ExposeVirtualizationExtensions $true
    Set-VMNetworkAdapter -VMName $VmName -MacAddressSpoofing On
    Start-VM -Name $VmName | Out-Null
    $Code | & whitesmith-orchestrator join --platform $Audience --code-stdin
    Write-Host "Started $Audience worker; adoption remains pending until fingerprint approval."
}
finally {
    $Code = $null
}
