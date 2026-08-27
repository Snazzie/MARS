$ErrorActionPreference = 'Stop'
$env:PATH = 'C:\Git\cmd;C:\Git\bin;' + $env:PATH
$bootstrap = 'C:\ProgramData\Mars\bootstrap\bootstrap.json'
$agent = 'C:\Mars\mars-job-agent.exe'
& $agent guest-service --platform windows-x64 --completion-mode exit --bootstrap-file $bootstrap --runner-root C:\actions-runner
exit $LASTEXITCODE
