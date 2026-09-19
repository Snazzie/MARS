Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:MarsDigestPattern = '^sha256:[0-9a-f]{64}$'
$script:MarsMaximumSafeInteger = [int64]9007199254740991

function Get-MarsSha256Digest {
  param([Parameter(Mandatory)][byte[]]$Bytes)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return 'sha256:' + ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function New-MarsRandomBytes {
  [CmdletBinding()]
  param([Parameter(Mandatory)][int]$Count)
  $bytes = New-Object byte[] $Count
  $algorithm = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $algorithm.GetBytes($bytes); return $bytes }
  finally { $algorithm.Dispose() }
}

function Get-MarsRelativePath {
  param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][string]$Path)
  $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Checkpoint file escapes root: $Path" }
  return $full.Substring($prefix.Length).Replace('\','/')
}

function Assert-MarsDigest {
  param([Parameter(Mandatory)][string]$Value,[Parameter(Mandatory)][string]$Name)
  if ($Value -notmatch $script:MarsDigestPattern) { throw "$Name must be sha256:<64 lowercase hex>." }
}

function Assert-MarsExactKeys {
  param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string[]]$Keys,[Parameter(Mandatory)][string]$Name)
  if ($null -eq $Value -or $Value -isnot [psobject]) { throw "$Name must be an object." }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
  $expected = @($Keys | Sort-Object -CaseSensitive)
  if (@(Compare-Object $expected $actual -CaseSensitive).Count -ne 0) { throw "$Name contains missing or unknown keys. Expected: $($Keys -join ', ')." }
}

function Get-MarsVmRecipeDigest {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Recipe)
  Assert-MarsExactKeys $Recipe @('type','source','assets','vm') 'recipe'
  if ($Recipe.type -ne 'local') { throw 'A local VM recipe is required.' }
  Assert-MarsExactKeys $Recipe.source @('kind','sha256','imageName') 'recipe.source'
  Assert-MarsExactKeys $Recipe.assets @('provisionerSha256','jobAgentSha256','runnerSha256','gitSha256','vcRuntimeSha256','customScriptSha256') 'recipe.assets'
  Assert-MarsExactKeys $Recipe.vm @('generation','diskSizeBytes','memoryBytes','vcpu','secureBootTemplate','vtpm') 'recipe.vm'
  if ($Recipe.source.kind -notin @('iso','vhdx')) { throw 'recipe.source.kind must be iso or vhdx.' }
  foreach ($digest in @($Recipe.source.sha256,$Recipe.assets.provisionerSha256,$Recipe.assets.jobAgentSha256,$Recipe.assets.runnerSha256,$Recipe.assets.gitSha256,$Recipe.assets.vcRuntimeSha256)) { Assert-MarsDigest $digest 'recipe digest' }
  if ($null -ne $Recipe.assets.customScriptSha256) { Assert-MarsDigest $Recipe.assets.customScriptSha256 'recipe.assets.customScriptSha256' }
  if ($Recipe.source.kind -eq 'iso' -and [string]::IsNullOrWhiteSpace([string]$Recipe.source.imageName)) { throw 'ISO recipes require imageName.' }
  if ($Recipe.source.kind -eq 'vhdx' -and $null -ne $Recipe.source.imageName) { throw 'VHDX recipes require a null imageName.' }
  if ([int]$Recipe.vm.generation -ne 2 -or [int64]$Recipe.vm.diskSizeBytes -ne 137438953472 -or [int64]$Recipe.vm.memoryBytes -ne 4294967296 -or [int]$Recipe.vm.vcpu -ne 2 -or $Recipe.vm.secureBootTemplate -ne 'MicrosoftWindows' -or $Recipe.vm.vtpm -ne $true) { throw 'recipe.vm does not match the Mars Hyper-V recipe.' }
  $json = $Recipe | ConvertTo-Json -Depth 12 -Compress
  return Get-MarsSha256Digest ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Get-MarsCheckpointFiles {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Root)
  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object Name -ne 'manifest.json' | ForEach-Object {
    $relative = Get-MarsRelativePath $Root $_.FullName
    if ($relative -split '/' | Where-Object { [string]::IsNullOrEmpty($_) -or $_ -in @('.','..') }) { throw "Invalid checkpoint path: $relative" }
    [pscustomobject][ordered]@{ path = $relative; length = [int64]$_.Length; sha256 = 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant() }
  })
  return @($files | Sort-Object -Property path -CaseSensitive)
}

function Get-MarsCheckpointContentDigest {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Root)
  $builder = [Text.StringBuilder]::new()
  foreach ($file in @(Get-MarsCheckpointFiles $Root)) {
    [void]$builder.Append($file.path).Append([char]0).Append([string]$file.length).Append([char]0).Append($file.sha256).Append("`n")
  }
  return Get-MarsSha256Digest ([Text.UTF8Encoding]::new($false).GetBytes($builder.ToString()))
}

function Test-MarsCheckpointManifest {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Root,[switch]$PassThru)
  $manifestPath = Join-Path $Root 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Checkpoint manifest.json is missing.' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-MarsExactKeys $manifest @('format','kind','imageDigest','contentDigest','recipe','hyperv','guest','probe','files') 'manifest'
  if ([int]$manifest.format -ne 2 -or $manifest.kind -ne 'hyperv-checkpoint-export') { throw 'Checkpoint manifest format or kind is invalid.' }
  Assert-MarsDigest $manifest.imageDigest 'manifest.imageDigest'; Assert-MarsDigest $manifest.contentDigest 'manifest.contentDigest'
  Assert-MarsExactKeys $manifest.hyperv @('generation','checkpointType','secureBootTemplate','guestServiceInterface','vtpm') 'manifest.hyperv'
  if ([int]$manifest.hyperv.generation -ne 2 -or $manifest.hyperv.checkpointType -ne 'Standard' -or $manifest.hyperv.secureBootTemplate -ne 'MicrosoftWindows' -or $manifest.hyperv.guestServiceInterface -ne $true -or $manifest.hyperv.vtpm -isnot [bool]) { throw 'manifest.hyperv is invalid.' }
  Assert-MarsExactKeys $manifest.guest @('platform','jobAgentSha256','runnerReady','gitReady','cacheCapability','serviceTaskName','serviceTaskExecutable') 'manifest.guest'
  Assert-MarsDigest $manifest.guest.jobAgentSha256 'manifest.guest.jobAgentSha256'
  if ($manifest.guest.platform -ne 'windows-x64' -or $manifest.guest.runnerReady -ne $true -or $manifest.guest.gitReady -ne $true -or $manifest.guest.cacheCapability -ne 'mars-worker-cache-registration-v1' -or $manifest.guest.serviceTaskName -ne 'MarsGuestService' -or $manifest.guest.serviceTaskExecutable -ne 'C:\Program Files\Mars\mars-job-agent.exe') { throw 'manifest.guest is invalid.' }
  Assert-MarsExactKeys $manifest.probe @('version','passed','observedAt','nonceSha256','resultSha256','imageDigest','contentDigest','jobAgentSha256') 'manifest.probe'
  foreach ($name in @('nonceSha256','resultSha256','imageDigest','contentDigest','jobAgentSha256')) { Assert-MarsDigest $manifest.probe.$name "manifest.probe.$name" }
  $timestamp = [DateTimeOffset]::MinValue
  if ([int]$manifest.probe.version -ne 1 -or $manifest.probe.passed -ne $true -or -not [DateTimeOffset]::TryParseExact([string]$manifest.probe.observedAt,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$timestamp) -or $timestamp.Offset -ne [TimeSpan]::Zero) { throw 'manifest.probe is invalid.' }
  if ($manifest.probe.imageDigest -ne $manifest.imageDigest -or $manifest.probe.contentDigest -ne $manifest.contentDigest -or $manifest.probe.jobAgentSha256 -ne $manifest.guest.jobAgentSha256) { throw 'Probe evidence is not bound to manifest identities.' }
  if ($manifest.recipe.type -eq 'external') {
    Assert-MarsExactKeys $manifest.recipe @('type') 'manifest.recipe'
    if ($manifest.imageDigest -ne $manifest.contentDigest) { throw 'External imageDigest must equal contentDigest.' }
  } elseif ($manifest.recipe.type -eq 'local') {
    if ((Get-MarsVmRecipeDigest $manifest.recipe) -ne $manifest.imageDigest) { throw 'Local imageDigest does not match recipe.' }
  } else { throw 'manifest.recipe.type is invalid.' }
  $listed = @($manifest.files)
  $actual = @(Get-MarsCheckpointFiles $Root)
  if ($listed.Count -ne $actual.Count) { throw 'Checkpoint contains listed/unlisted payload files.' }
  for ($index = 0; $index -lt $actual.Count; $index++) {
    Assert-MarsExactKeys $listed[$index] @('path','length','sha256') "manifest.files[$index]"
    if ([int64]$listed[$index].length -lt 0 -or [int64]$listed[$index].length -gt $script:MarsMaximumSafeInteger) { throw 'Checkpoint file length is invalid.' }
    Assert-MarsDigest $listed[$index].sha256 "manifest.files[$index].sha256"
    if ($listed[$index].path -ne $actual[$index].path -or [int64]$listed[$index].length -ne $actual[$index].length -or $listed[$index].sha256 -ne $actual[$index].sha256) { throw "Checkpoint file verification failed: $($actual[$index].path)" }
  }
  if ((Get-MarsCheckpointContentDigest $Root) -ne $manifest.contentDigest) { throw 'Checkpoint contentDigest mismatch.' }
  $vmcx = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.vmcx')
  if ($vmcx.Count -ne 1) { throw "Checkpoint must contain exactly one .vmcx file; found $($vmcx.Count)." }
  if ($PassThru) { return $manifest }
  return $true
}

function Export-MarsCheckpoint {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VmName,
    [Parameter(Mandatory)][string]$CheckpointName,
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)]$Recipe,
    [Parameter(Mandatory)][string]$JobAgentSha256,
    [Parameter(Mandatory)][string]$NonceSha256,
    [Parameter(Mandatory)][string]$ProbeResultSha256,
    [Parameter(Mandatory)][string]$ProbeObservedAt,
    [switch]$Vtpm
  )
  foreach ($digest in @($JobAgentSha256,$NonceSha256,$ProbeResultSha256)) { Assert-MarsDigest $digest 'probe digest' }
  $checkpoint = Get-VMSnapshot -VMName $VmName -Name $CheckpointName -ErrorAction Stop
  if ($checkpoint.SnapshotType.ToString() -ne 'Standard') { throw 'Export requires a Standard checkpoint.' }
  if ((Get-VM -Name $VmName -ErrorAction Stop).State.ToString() -ne 'Running') { throw 'Export requires a running VM.' }
  if (Test-Path -LiteralPath $OutputPath) { throw "Checkpoint output already exists: $OutputPath" }
  New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
  try {
    Export-VMSnapshot -VMName $VmName -Name $CheckpointName -Path $OutputPath
    if (@(Get-ChildItem -LiteralPath $OutputPath -Recurse -File -Filter '*.vmcx').Count -ne 1) { throw 'Export must contain exactly one .vmcx file.' }
    $files = @(Get-MarsCheckpointFiles $OutputPath)
    $contentDigest = Get-MarsCheckpointContentDigest $OutputPath
    $imageDigest = if ($Recipe.type -eq 'external') { $contentDigest } else { Get-MarsVmRecipeDigest $Recipe }
    $manifest = [ordered]@{
      format = 2; kind = 'hyperv-checkpoint-export'; imageDigest = $imageDigest; contentDigest = $contentDigest; recipe = $Recipe
      hyperv = [ordered]@{ generation = 2; checkpointType = 'Standard'; secureBootTemplate = 'MicrosoftWindows'; guestServiceInterface = $true; vtpm = [bool]$Vtpm }
      guest = [ordered]@{ platform = 'windows-x64'; jobAgentSha256 = $JobAgentSha256; runnerReady = $true; gitReady = $true; cacheCapability = 'mars-worker-cache-registration-v1'; serviceTaskName = 'MarsGuestService'; serviceTaskExecutable = 'C:\Program Files\Mars\mars-job-agent.exe' }
      probe = [ordered]@{ version = 1; passed = $true; observedAt = $ProbeObservedAt; nonceSha256 = $NonceSha256; resultSha256 = $ProbeResultSha256; imageDigest = $imageDigest; contentDigest = $contentDigest; jobAgentSha256 = $JobAgentSha256 }
      files = $files
    }
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutputPath 'manifest.json') -Encoding utf8
    Test-MarsCheckpointManifest -Root $OutputPath | Out-Null
    return $manifest
  } catch {
    Remove-Item -LiteralPath $OutputPath -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
}

Export-ModuleMember -Function Get-MarsSha256Digest,New-MarsRandomBytes,Get-MarsVmRecipeDigest,Get-MarsCheckpointFiles,Get-MarsCheckpointContentDigest,Test-MarsCheckpointManifest,Export-MarsCheckpoint
