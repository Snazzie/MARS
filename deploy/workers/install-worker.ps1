param(
    [Parameter(Mandatory=$false)]
    [string]$Code
)
$ErrorActionPreference = 'Stop'
if (-not $Code) {
    $secure = Read-Host 'Whitesmith enrollment code' -AsSecureString
    $Code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ($Code -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Code must be a 43-character base64url value' }
$VmName = 'whitesmith-worker'
$VmCreated = $false
$process = $null
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
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'whitesmith-orchestrator'
    foreach ($argument in @('join', '--platform', $Audience, '--code-stdin')) { [void]$startInfo.ArgumentList.Add($argument) }
    $startInfo.RedirectStandardInput = $true
    $startInfo.UseShellExecute = $false
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $process.StandardInput.WriteLine($Code)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'worker join timed out' }
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
    if ($process) { $process.Dispose() }
    $Code = $null
}
