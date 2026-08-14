export type DevOptions = { kill: boolean };

type DevEnvironment = Record<string, string | undefined>;

export function parseDevOptions(args: readonly string[]): DevOptions {
  let kill = false;
  for (const argument of args) {
    if (argument === "--kill") kill = true;
    else throw new Error(`Unknown dev option: ${argument}`);
  }
  return { kill };
}

function port(name: "PORT" | "WEB_PORT", value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

export function devPorts(environment: DevEnvironment): number[] {
  return [...new Set([
    port("PORT", environment.PORT, 3000),
    port("WEB_PORT", environment.WEB_PORT, 5173),
  ])];
}

export function windowsPortCleanupScript(ports: readonly number[], parentPid: number): string {
  const values = ports.join(",");
  return `$ErrorActionPreference = 'Stop'
$ports = @(${values})
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }
$processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
foreach ($processId in $processIds) {
  if ($processId -ne ${parentPid}) {
    Write-Output "Stopping listener PID $processId"
    Stop-Process -Id $processId -Force
  }
}
Start-Sleep -Milliseconds 250
$remaining = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty LocalPort -Unique)
if ($remaining.Count -gt 0) {
  Write-Error "Ports still occupied: $($remaining -join ', ')"
  exit 1
}`;
}

export async function killDevPortListeners(ports: readonly number[]): Promise<void> {
  if (process.platform !== "win32") throw new Error("bun dev --kill is currently supported only on Windows");
  const child = Bun.spawn([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsPortCleanupScript(ports, process.pid),
  ], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Could not clear development ports (exit ${exitCode})`);
}
