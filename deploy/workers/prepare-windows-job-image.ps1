[CmdletBinding()]
param(
  [string]$JobAgent = '',
  [string]$RunnerRoot = 'C:\actions-runner'
)
$ErrorActionPreference = 'Stop'

function Assert-MarsGuestSha256 {
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Expected,[Parameter(Mandatory)][string]$Name)
  if ($Expected -notmatch '^[0-9a-f]{64}$') { throw "$Name SHA-256 must be lowercase hexadecimal." }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Name is missing: $Path" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "$Name SHA-256 mismatch: expected $Expected, got $actual" }
}

function Assert-MarsNoPendingReboot {
  $pending = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  ) | Where-Object { Test-Path $_ }
  $rename = Get-ItemPropertyValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' PendingFileRenameOperations -ErrorAction SilentlyContinue
  if ($pending.Count -gt 0 -or $rename) { throw 'Guest provisioning requires a reboot, which is not allowed.' }
}

function Set-MarsMachinePath {
  param([Parameter(Mandatory)][string]$Entry)
  $current = [Environment]::GetEnvironmentVariable('Path','Machine')
  $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($parts -notcontains $Entry) { [Environment]::SetEnvironmentVariable('Path',(($parts + $Entry) -join ';'),'Machine') }
}

function Assert-MarsGuestInvariants {
  param(
    [string]$MarsRunnerRoot = 'C:\actions-runner',
    [string]$MarsGitRoot = 'C:\Git',
    [string]$MarsAgentRoot = 'C:\Program Files\Mars',
    [string]$MarsDataRoot = 'C:\ProgramData\Mars'
  )
  foreach ($path in @((Join-Path $MarsRunnerRoot 'run.cmd'),(Join-Path $MarsGitRoot 'cmd\git.exe'),(Join-Path $MarsAgentRoot 'mars-job-agent.exe'),(Join-Path $MarsRunnerRoot '.mars-capabilities.json'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required Mars guest file is missing: $path" }
  }
  $capability = Get-Content -LiteralPath (Join-Path $MarsRunnerRoot '.mars-capabilities.json') -Raw | ConvertFrom-Json
  if ([int]$capability.schemaVersion -ne 1 -or $capability.capabilities -notcontains 'mars-worker-cache-registration-v1') { throw 'Mars runner capability manifest is invalid.' }
  $task = Get-ScheduledTask -TaskName 'MarsGuestService' -ErrorAction Stop
  if ($task.Principal.UserId -notin @('SYSTEM','NT AUTHORITY\SYSTEM') -or $task.Principal.RunLevel.ToString() -ne 'Highest') { throw 'MarsGuestService must run as SYSTEM at Highest.' }
  if ($task.Actions.Execute -ne (Join-Path $MarsAgentRoot 'mars-job-agent.exe')) { throw 'MarsGuestService executable is invalid.' }
  Assert-MarsNoPendingReboot
}

function Install-MarsWindowsGuest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$JobAgentPath,[Parameter(Mandatory)][string]$JobAgentSha256,
    [Parameter(Mandatory)][string]$RunnerArchivePath,[Parameter(Mandatory)][string]$RunnerArchiveSha256,
    [Parameter(Mandatory)][string]$GitArchivePath,[Parameter(Mandatory)][string]$GitArchiveSha256,
    [Parameter(Mandatory)][string]$VcRuntimePath,[Parameter(Mandatory)][string]$VcRuntimeSha256,
    [string]$CustomScriptPath = '',[string]$CustomScriptSha256 = '',
    [string]$MarsRunnerRoot = 'C:\actions-runner',[string]$MarsGitRoot = 'C:\Git',[string]$MarsAgentRoot = 'C:\Program Files\Mars',[string]$MarsDataRoot = 'C:\ProgramData\Mars'
  )
  foreach ($asset in @(
    @($JobAgentPath,$JobAgentSha256,'job agent'),@($RunnerArchivePath,$RunnerArchiveSha256,'Actions Runner'),
    @($GitArchivePath,$GitArchiveSha256,'MinGit'),@($VcRuntimePath,$VcRuntimeSha256,'VC runtime')
  )) { Assert-MarsGuestSha256 $asset[0] $asset[1] $asset[2] }
  if ([string]::IsNullOrWhiteSpace($CustomScriptPath) -ne [string]::IsNullOrWhiteSpace($CustomScriptSha256)) { throw 'Custom script path and SHA-256 must be supplied together.' }
  if ($CustomScriptPath) { Assert-MarsGuestSha256 $CustomScriptPath $CustomScriptSha256 'custom script' }

  New-Item -ItemType Directory -Force -Path $MarsRunnerRoot,$MarsGitRoot,$MarsAgentRoot,$MarsDataRoot | Out-Null
  Get-ChildItem -LiteralPath $MarsRunnerRoot -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  Get-ChildItem -LiteralPath $MarsGitRoot -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  Expand-Archive -LiteralPath $RunnerArchivePath -DestinationPath $MarsRunnerRoot -Force
  Expand-Archive -LiteralPath $GitArchivePath -DestinationPath $MarsGitRoot -Force
  Copy-Item -LiteralPath $JobAgentPath -Destination (Join-Path $MarsAgentRoot 'mars-job-agent.exe') -Force
  $vc = Start-Process -FilePath $VcRuntimePath -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru
  if ($vc.ExitCode -notin @(0,1638)) { throw "VC runtime installation failed with exit code $($vc.ExitCode)." }

  [ordered]@{ schemaVersion = 1; capabilities = @('mars-worker-cache-registration-v1') } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $MarsRunnerRoot '.mars-capabilities.json') -Encoding utf8
  Set-MarsMachinePath (Join-Path $MarsGitRoot 'cmd')
  Remove-Item -LiteralPath (Join-Path $MarsDataRoot 'bootstrap.json') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $MarsRunnerRoot '.runner'),(Join-Path $MarsRunnerRoot '.credentials'),(Join-Path $MarsRunnerRoot '.credentials_rsaparams') -Force -ErrorAction SilentlyContinue
  & icacls.exe $MarsDataRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /t | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to secure Mars guest data.' }

  $agent = Join-Path $MarsAgentRoot 'mars-job-agent.exe'
  $arguments = "guest-service --platform windows-x64 --bootstrap-file `"$MarsDataRoot\bootstrap.json`" --runner-root `"$MarsRunnerRoot`""
  $action = New-ScheduledTaskAction -Execute $agent -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'MarsGuestService' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

  if ($CustomScriptPath) {
    $custom = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$CustomScriptPath,'-MarsRunnerRoot',$MarsRunnerRoot,'-MarsGitRoot',$MarsGitRoot,'-MarsAgentRoot',$MarsAgentRoot,'-MarsDataRoot',$MarsDataRoot) -Wait -PassThru -RedirectStandardOutput (Join-Path $MarsDataRoot 'custom.stdout.log') -RedirectStandardError (Join-Path $MarsDataRoot 'custom.stderr.log')
    if ($custom.ExitCode -ne 0) { throw "Custom provisioning script failed with exit code $($custom.ExitCode)." }
  }
  Assert-MarsGuestInvariants -MarsRunnerRoot $MarsRunnerRoot -MarsGitRoot $MarsGitRoot -MarsAgentRoot $MarsAgentRoot -MarsDataRoot $MarsDataRoot
}

if ($MyInvocation.InvocationName -ne '.') {
  if ([string]::IsNullOrWhiteSpace($JobAgent)) { throw '-JobAgent is required.' }
  if (-not (Test-Path -LiteralPath (Join-Path $RunnerRoot 'run.cmd'))) { throw 'Actions Runner run.cmd was not found.' }
  $program = 'C:\Program Files\Mars'; $data = 'C:\ProgramData\Mars'
  New-Item -ItemType Directory -Force -Path $program,$data | Out-Null
  Copy-Item -LiteralPath $JobAgent -Destination (Join-Path $program 'mars-job-agent.exe') -Force
  & icacls.exe $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  $action = New-ScheduledTaskAction -Execute (Join-Path $program 'mars-job-agent.exe') -Argument "guest-service --platform windows-x64 --bootstrap-file `"C:\ProgramData\Mars\bootstrap.json`" --runner-root `"$RunnerRoot`""
  Register-ScheduledTask -TaskName 'MarsGuestService' -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable) -Force | Out-Null
  Get-FileHash (Join-Path $program 'mars-job-agent.exe') -Algorithm SHA256
}
