param(
    [Parameter(Mandatory=$true)]
    [string]$Code
)

$ErrorActionPreference = 'Stop'
if ($Code -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Code must be a 43-character base64url value' }
$VmName = 'whitesmith-worker'
$CodeFile = $null
$VmCreated = $false
try {
    if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V required' }
    if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V module required' }
    $Audience = 'windows-x64'
    $Vhdx = Join-Path $PSScriptRoot 'operator-built-windows-worker.vhdx'
    if (-not (Test-Path $Vhdx)) { throw 'Operator-built Windows Server worker VHDX is required' }
    New-VM -Name $VmName -Generation 2 -MemoryStartupBytes 4GB -VHDPath $Vhdx | Out-Null
    $VmCreated = $true
    Set-VMProcessor -VMName $VmName -Count 4 -ExposeVirtualizationExtensions $true
    Set-VMNetworkAdapter -VMName $VmName -MacAddressSpoofing On
    Start-VM -Name $VmName | Out-Null
    $CodeFile = Join-Path ([IO.Path]::GetTempPath()) ("whitesmith-join-{0}.tmp" -f ([guid]::NewGuid()))
    [IO.File]::WriteAllText($CodeFile, $Code)
    $process = Start-Process -FilePath 'whitesmith-orchestrator' -ArgumentList @('join', '--platform', $Audience, '--code-stdin') -RedirectStandardInput $CodeFile -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) { throw "worker join failed with exit code $($process.ExitCode)" }
    Write-Host "Started $Audience worker; adoption remains pending until fingerprint approval."
}
catch {
    if ($VmCreated) {
        Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue
        Remove-VM -Name $VmName -Force -ErrorAction SilentlyContinue
    }
    throw
}
finally {
    if ($CodeFile -and (Test-Path $CodeFile)) { Remove-Item -Force $CodeFile -ErrorAction SilentlyContinue }
    $Code = $null
}
