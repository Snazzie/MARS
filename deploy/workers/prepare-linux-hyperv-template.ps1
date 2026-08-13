[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceVhdx,
  [Parameter(Mandatory)][string]$SourceSha256,
  [Parameter(Mandatory)][string]$JobAgentPath,
  [Parameter(Mandatory)][string]$OutputVhdx,
  [Parameter(Mandatory)][string]$OutputManifest,
  [Parameter(Mandatory)][string]$GuestAddress,
  [Parameter(Mandatory)][string]$GuestUser,
  [Parameter(Mandatory)][string]$SshKeyPath,
  [string]$SourceUrl = 'https://cloud-images.ubuntu.com/'
)
$ErrorActionPreference = 'Stop'
function Digest([string]$path) { 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
function Run([string]$file, [string[]]$args) { & $file @args; if ($LASTEXITCODE -ne 0) { throw "$file failed with exit code $LASTEXITCODE" } }
if (-not (Test-Path -LiteralPath $SourceVhdx -PathType Leaf)) { throw "Source VHDX not found: $SourceVhdx" }
if (-not (Test-Path -LiteralPath $JobAgentPath -PathType Leaf)) { throw "Job agent not found: $JobAgentPath" }
if (-not (Test-Path -LiteralPath $SshKeyPath -PathType Leaf)) { throw "SSH key not found: $SshKeyPath" }
$actual = Digest $SourceVhdx; $expected = 'sha256:' + $SourceSha256.Trim().ToLowerInvariant().Replace('sha256:','')
if ($actual -ne $expected) { throw "source VHDX checksum mismatch: expected $expected, got $actual" }
if ((Get-VHD -Path $SourceVhdx).VhdType -eq 'Differencing') { throw 'Source VHDX must be a sealed non-differencing parent.' }
$name = "whitesmith-linux-template-$([guid]::NewGuid().ToString('N'))"; $temp = Join-Path ([IO.Path]::GetTempPath()) $name; $working = Join-Path $temp 'template.vhdx'; New-Item -ItemType Directory -Force -Path $temp | Out-Null; Copy-Item $SourceVhdx $working
try {
  New-VM -Name $name -Generation 2 -MemoryStartupBytes 2GB -VHDPath $working | Out-Null; Enable-VMIntegrationService -VMName $name -Name 'Guest Service Interface'; Start-VM -Name $name | Out-Null
  $deadline = (Get-Date).AddMinutes(10); do { Start-Sleep -Seconds 2 } while ((Get-VM -Name $name).State -ne 'Running' -and (Get-Date) -lt $deadline)
  if ((Get-VM -Name $name).State -ne 'Running') { throw 'Linux template VM did not start.' }
  Run 'scp.exe' @('-i',$SshKeyPath,'-o','StrictHostKeyChecking=no',$JobAgentPath,"${GuestUser}@${GuestAddress}:/tmp/whitesmith-job-agent")
  $remote = "sudo install -D -m 0755 /tmp/whitesmith-job-agent /usr/local/bin/whitesmith-job-agent; sudo install -d -m 0700 /var/lib/whitesmith; sudo touch /var/lib/whitesmith/guest-service.ready; sudo tee /etc/systemd/system/whitesmith-guest.service >/dev/null <<'UNIT'`n[Unit]`nAfter=network-online.target`n[Service]`nType=simple`nExecStart=/usr/local/bin/whitesmith-job-agent guest-service --platform linux-x64 --bootstrap-file /var/lib/whitesmith/bootstrap.json`nRestart=on-failure`n[Install]`nWantedBy=multi-user.target`nUNIT`nsudo systemctl enable whitesmith-guest.service; sudo rm -f /tmp/whitesmith-job-agent /etc/ssh/ssh_host_*; sudo cloud-init clean --logs 2>/dev/null || true; sudo shutdown -h now"
  Run 'ssh.exe' @('-i',$SshKeyPath,'-o','StrictHostKeyChecking=no',"${GuestUser}@${GuestAddress}",$remote)
  $deadline = (Get-Date).AddMinutes(10); do { Start-Sleep -Seconds 2 } while ((Get-VM -Name $name).State -ne 'Off' -and (Get-Date) -lt $deadline)
  if ((Get-VM -Name $name).State -ne 'Off') { Stop-VM -Name $name -TurnOff -Force | Out-Null }
  Optimize-VHD -Path $working -Mode Full; New-Item -ItemType Directory -Force -Path (Split-Path $OutputVhdx) | Out-Null; Move-Item $working $OutputVhdx -Force
  [ordered]@{ format=1; guestPlatform='linux-x64'; source=[ordered]@{url=$SourceUrl;sha256=$actual}; template=[ordered]@{sha256=(Digest $OutputVhdx);path=[IO.Path]::GetFileName($OutputVhdx)}; hyperv=[ordered]@{generation=2;secureBoot=$true;guestServiceInterface=$true}; guestAgentVersion=(Get-Item $JobAgentPath).VersionInfo.FileVersion; preparedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 5 | Set-Content $OutputManifest -Encoding utf8
} finally { Remove-VM -Name $name -Force -ErrorAction SilentlyContinue; Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
