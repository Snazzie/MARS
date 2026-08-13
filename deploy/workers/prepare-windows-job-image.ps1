[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$JobAgent,[string]$RunnerRoot='C:\actions-runner')
$ErrorActionPreference='Stop'
if (-not (Test-Path (Join-Path $RunnerRoot 'run.cmd'))) { throw 'Actions Runner run.cmd was not found.' }
$program = 'C:\Program Files\Whitesmith'; $data = 'C:\ProgramData\Whitesmith'; New-Item -ItemType Directory -Force -Path $program,$data | Out-Null
Copy-Item $JobAgent (Join-Path $program 'whitesmith-job-agent.exe') -Force
icacls $data /inheritance:r /grant:r 'SYSTEM:(OI)(CI)(F)' 'Administrators:(OI)(CI)(F)' | Out-Null
Enable-VMIntegrationService -VMName $env:COMPUTERNAME -Name 'Guest Service Interface' -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute (Join-Path $program 'whitesmith-job-agent.exe') -Argument "guest-service --platform windows-x64 --bootstrap-file C:\ProgramData\Whitesmith\bootstrap.json --runner-root $RunnerRoot"
Register-ScheduledTask -TaskName WhitesmithGuestService -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -User SYSTEM -RunLevel Highest -Force | Out-Null
Get-FileHash (Join-Path $program 'whitesmith-job-agent.exe') -Algorithm SHA256
