import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DevOptions = { kill: boolean };
export type DevLock = { path: string; pid: number; release: () => void };

type DevEnvironment = Record<string, string | undefined>;

type LockRecord = { pid: number };

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

export function devLockPath(repository = process.cwd()): string {
  const canonical = realpathSync.native(repository);
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return join(tmpdir(), `mars-dev-${key}.lock`);
}

function readLock(path: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireDevLock(repository = process.cwd(), pid = process.pid): DevLock {
  const path = devLockPath(repository);
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner.json"), JSON.stringify({ pid }), { encoding: "utf8", flag: "wx" });
      return {
        path,
        pid,
        release: () => {
          const owner = readLock(path);
          if (owner?.pid === pid) rmSync(path, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readLock(path);
      if (owner && processIsAlive(owner.pid)) throw new Error(`Development supervisor already running (PID ${owner.pid})`);
      rmSync(path, { recursive: true, force: true });
    }
  }
}

export async function killRecordedDevSupervisor(repository = process.cwd()): Promise<void> {
  const path = devLockPath(repository);
  const owner = existsSync(path) ? readLock(path) : null;
  if (!owner || owner.pid === process.pid) return;
  if (process.platform !== "win32") throw new Error("bun dev --kill is currently supported only on Windows");
  const child = Bun.spawn(["taskkill.exe", "/PID", String(owner.pid), "/T", "/F"], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0 && processIsAlive(owner.pid)) throw new Error(`Could not stop development supervisor PID ${owner.pid} (exit ${exitCode})`);
  rmSync(path, { recursive: true, force: true });
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
