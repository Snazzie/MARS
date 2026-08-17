[CmdletBinding()]
param(
  [switch]$RequireNetwork
)
$ErrorActionPreference = 'Stop'
$dependencies = @('mf.dll', 'mfplat.dll', 'msmpeg2vdec.dll', 'evr.dll', 'avrt.dll')
foreach ($name in $dependencies) {
  if (-not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$name") -PathType Leaf)) {
    throw "Missing Playwright Windows dependency: $name"
  }
}
$dns = $null
$tcp443 = $null
$client = $null
try {
  if ($RequireNetwork) {
    try {
      $addresses = @(Resolve-DnsName -Name 'api.github.com' -Type A -ErrorAction Stop)
      if ($addresses.Count -eq 0) { throw 'No DNS addresses returned' }
      $dns = $true
    } catch {
      throw 'Container DNS probe failed for api.github.com'
    }
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $connect = $client.ConnectAsync('api.github.com', 443)
      if (-not $connect.Wait([TimeSpan]::FromSeconds(10)) -or -not $client.Connected) { throw 'TCP connection timed out' }
      $tcp443 = $true
    } catch {
      throw 'Container TCP probe failed for api.github.com:443'
    }
  }
} finally {
  if ($null -ne $client) { $client.Dispose() }
}
[pscustomobject]@{ mediaFoundation = $true; dns = $dns; tcp443 = $tcp443 } | ConvertTo-Json -Compress
