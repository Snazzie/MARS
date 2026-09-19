[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $root 'deploy\workers\windows-hyperv-checkpoint.psm1') -Force

function Assert-Throws([scriptblock]$Action,[string]$Pattern) {
  try { & $Action } catch { if ($_.Exception.Message -notmatch $Pattern) { throw "Wrong error: $($_.Exception.Message)" }; return }
  throw 'Expected action to throw.'
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('mars-checkpoint-contract-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  $checkpoint = Join-Path $temp 'checkpoint'
  function global:Get-VMSnapshot { [pscustomobject]@{ SnapshotType = 'Standard' } }
  function global:Get-VM { [pscustomobject]@{ State = 'Running' } }
  function global:Export-VMSnapshot { param($VMName,$Name,$Path); New-Item -ItemType Directory -Force -Path $Path | Out-Null; [IO.File]::WriteAllText((Join-Path $Path 'image.vmcx'),'config'); [IO.File]::WriteAllText((Join-Path $Path 'disk.vhdx'),'disk') }
  $digest = 'sha256:' + ('a' * 64)
  $manifest = Export-MarsCheckpoint -VmName test -CheckpointName sealed -OutputPath $checkpoint -Recipe ([pscustomobject]@{ type='external' }) -JobAgentSha256 $digest -NonceSha256 $digest -ProbeResultSha256 $digest -ProbeObservedAt '2026-09-01T00:00:00.0000000Z'
  if (-not (Test-MarsCheckpointManifest -Root $checkpoint)) { throw 'Valid checkpoint was rejected.' }
  if ($manifest.imageDigest -ne $manifest.contentDigest) { throw 'External checkpoint digest identity is not content-addressed.' }

  [IO.File]::AppendAllText((Join-Path $checkpoint 'disk.vhdx'),'tamper')
  Assert-Throws { Test-MarsCheckpointManifest -Root $checkpoint } 'verification failed|contentDigest'
  [IO.File]::WriteAllText((Join-Path $checkpoint 'disk.vhdx'),'disk')
  [IO.File]::WriteAllText((Join-Path $checkpoint 'unlisted.bin'),'unlisted')
  Assert-Throws { Test-MarsCheckpointManifest -Root $checkpoint } 'listed/unlisted'
  Remove-Item -LiteralPath (Join-Path $checkpoint 'unlisted.bin')

  $manifestPath = Join-Path $checkpoint 'manifest.json'; $value = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json; $value | Add-Member -NotePropertyName unexpected -NotePropertyValue $true; $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  Assert-Throws { Test-MarsCheckpointManifest -Root $checkpoint } 'missing or unknown keys'

  $installer = Get-Content -LiteralPath (Join-Path $root 'deploy\workers\install-worker.ps1') -Raw
  foreach ($boundary in @('after-binaries','after-image-state','after-environment','after-health')) { if ($installer -notmatch [regex]::Escape("Invoke-MarsUpgradeFault '$boundary'")) { throw "Upgrade fault boundary is missing: $boundary" } }
  foreach ($snapshot in @('orchestrator=$orchestratorPath','serviceHost=$serviceHostPath','tray=$trayPath','imageState=$imageStatePath','GetValueKind(''Environment'')')) { if ($installer -notmatch [regex]::Escape($snapshot)) { throw "Upgrade rollback snapshot is missing: $snapshot" } }
  Write-Output 'WINDOWS_HYPERV_PROVISIONING_CONTRACT_OK'
} finally {
  Remove-Item Function:\Get-VMSnapshot,Function:\Get-VM,Function:\Export-VMSnapshot -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
