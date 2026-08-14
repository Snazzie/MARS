$ErrorActionPreference = 'Stop'
$bootstrap = 'C:\ProgramData\Whitesmith\bootstrap\bootstrap.json'
$agent = 'C:\Whitesmith\whitesmith-job-agent.exe'
& $agent guest-service --platform windows-x64 --completion-mode exit --bootstrap-file $bootstrap --runner-root C:\actions-runner
exit $LASTEXITCODE
