import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolResources } from "@whitesmith/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";

type Limits = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
type HyperVResult = { code: number; stdout: string; stderr: string };
export type HyperVRunner = (script: string, args: string[]) => Promise<HyperVResult>;
export function powerShellCommand(script: string): string { return `& { ${script} }`; }
const defaultRunner: HyperVRunner = async (script, args) => {
  const process = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", powerShellCommand(script), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { code, stdout, stderr };
};
function bytesToMegabytes(value: number): number { return Math.max(1, Math.floor(value / 1024 ** 2)); }
function bytesToGigabytes(value: number): number { return Math.max(1, Math.ceil(value / 1024 ** 3)); }
export interface HyperVRuntime {
  verifyHost(): Promise<void>;
  createDifferencingDisk(parent: string, child: string): Promise<void>;
  createVm(input: { name: string; diskPath: string; resources: PoolResources }): Promise<void>;
  copyBootstrap(vmName: string, sourcePath: string, guestPath: string): Promise<void>;
  start(vmName: string): Promise<void>;
  waitForGuestReady(vmName: string, timeoutMs: number): Promise<void>;
  waitForStop(vmName: string, timeoutMs: number): Promise<void>;
  stop(vmName: string): Promise<void>;
  remove(vmName: string): Promise<void>;
  removeDisk(path: string): Promise<void>;
  reconcileOrphans(prefix: string): Promise<void>;
}
export function createHyperVRuntime(run: HyperVRunner = defaultRunner): HyperVRuntime {
  async function invoke(script: string, args: string[] = []): Promise<string> {
    const result = await run(script, args);
    if (result.code !== 0) throw new Error(`Hyper-V command failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  }
  return {
    verifyHost: async () => { await invoke("if ((Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State -ne 'Enabled') { exit 1 }; if (-not (Get-VMHost)) { exit 1 }"); },
    createDifferencingDisk: async (parent, child) => { await invoke("New-VHD -Path $args[1] -ParentPath $args[0] -Differencing | Out-Null", [parent, child]); },
    createVm: async ({ name, diskPath, resources }) => { await invoke("$vm=New-VM -Name $args[0] -Generation 2 -MemoryStartupBytes ($args[2]*1MB) -VHDPath $args[1]; Set-VMProcessor -VM $vm -Count $args[3]; Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes ($args[2]*1MB); Set-VM -VM $vm -AutomaticStopAction ShutDown | Out-Null", [name, diskPath, String(bytesToMegabytes(resources.memoryBytes)), String(resources.vcpu)]); },
    copyBootstrap: async (vmName, sourcePath, guestPath) => { await invoke("Copy-VMFile -Name $args[0] -SourcePath $args[1] -DestinationPath $args[2] -FileSource Host -CreateFullPath", [vmName, sourcePath, guestPath]); },
    start: async vmName => { await invoke("Start-VM -Name $args[0] | Out-Null", [vmName]); },
    waitForGuestReady: async (vmName, timeoutMs) => { await invoke("$deadline=(Get-Date).AddMilliseconds($args[1]); do { $heartbeat=Get-VMIntegrationService -VMName $args[0] -Name 'Heartbeat' -ErrorAction SilentlyContinue; if ($heartbeat -and $heartbeat.PrimaryStatusDescription -eq 'OK') { exit 0 }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); exit 1", [vmName, String(timeoutMs)]); },
    waitForStop: async (vmName, timeoutMs) => { await invoke("$deadline=(Get-Date).AddMilliseconds($args[1]); do { $state=(Get-VM -Name $args[0] -ErrorAction SilentlyContinue).State; if ($state -eq 'Off') { exit 0 }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); exit 1", [vmName, String(timeoutMs)]); },
    stop: async vmName => { await invoke("Stop-VM -Name $args[0] -TurnOff -Force -ErrorAction SilentlyContinue", [vmName]); },
    remove: async vmName => { await invoke("Remove-VM -Name $args[0] -Force -ErrorAction SilentlyContinue", [vmName]); },
    removeDisk: async path => { await rm(path, { force: true }); },
    reconcileOrphans: async prefix => { await invoke("Get-VM -Name ($args[0]+'-*') -ErrorAction SilentlyContinue | ForEach-Object { Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -VM $_ -Force -ErrorAction SilentlyContinue }", [prefix]); },
  };
}
export class HyperVDriver implements RuntimeDriver {
  readonly name = "windows-hyperv" as const;
  private readonly leases = new Map<string, { vmName: string; diskPath: string; runtime: RuntimeLease }>();
  constructor(private readonly hyperv: HyperVRuntime, private readonly templatePath: string, private readonly templateDigest: string, private readonly prefix: string, private readonly limits: Limits, private readonly bootstrapRoot = join(Bun.env.ProgramData ?? "C:\\ProgramData", "Whitesmith", "leases")) {}
  validatePool(resources: PoolResources): void { validateResources(resources, this.limits); }
  async reserveCapacity(resources: PoolResources): Promise<void> { this.validatePool(resources); await this.hyperv.verifyHost(); }
  async reconcileOrphans(): Promise<void> { await this.hyperv.reconcileOrphans(this.prefix); }
  async createLease(lease: Lease): Promise<RuntimeLease> {
    if (lease.imageDigest !== this.templateDigest) throw new Error("lease image digest does not match Hyper-V template");
    this.validatePool(lease.resources);
    await mkdir(this.bootstrapRoot, { recursive: true });
    const vmName = `${this.prefix}-${lease.id.slice(0, 8)}`;
    const diskPath = join(this.bootstrapRoot, `${vmName}.avhdx`);
    const bootstrapPath = join(this.bootstrapRoot, `${vmName}.json`);
    await writeFile(bootstrapPath, JSON.stringify({ version: 1, leaseId: lease.id, nonce: lease.nonce, encodedJitConfig: lease.encodedJitConfig }), { flag: "wx", mode: 0o600 });
    try {
      await this.hyperv.createDifferencingDisk(this.templatePath, diskPath);
      await this.hyperv.createVm({ name: vmName, diskPath, resources: lease.resources });
      await this.hyperv.start(vmName);
      await this.hyperv.copyBootstrap(vmName, bootstrapPath, "C:\\ProgramData\\Whitesmith\\bootstrap.json");
      await this.hyperv.waitForGuestReady(vmName, Number(Bun.env.WHITESMITH_HYPERV_READY_TIMEOUT_MS ?? 120_000));
      const completion = this.hyperv.waitForStop(vmName, Number(Bun.env.WHITESMITH_HYPERV_JOB_TIMEOUT_MS ?? 3_600_000)).then(() => 0);
      const runtime: RuntimeLease = { runtimeInstanceId: vmName, observed: { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: bytesToGigabytes(lease.resources.storageBytes) * 1024 ** 3 }, state: "sandbox_attested", completion };
      this.leases.set(lease.id, { vmName, diskPath, runtime });
      return runtime;
    } catch (error) {
      await this.hyperv.stop(vmName).catch(() => undefined); await this.hyperv.remove(vmName).catch(() => undefined); await this.hyperv.removeDisk(diskPath).catch(() => undefined); throw error;
    } finally { await rm(bootstrapPath, { force: true }); }
  }
  async inspectLease(leaseId: string): Promise<RuntimeLease> { const lease = this.leases.get(leaseId); if (!lease) throw new Error("sandbox not found"); return lease.runtime; }
  async stopLease(leaseId: string): Promise<void> { const lease = this.leases.get(leaseId); if (lease) await this.hyperv.stop(lease.vmName); }
  async removeLease(leaseId: string): Promise<void> { const lease = this.leases.get(leaseId); if (!lease) return; await this.hyperv.remove(lease.vmName).catch(() => undefined); await this.hyperv.removeDisk(lease.diskPath).catch(() => undefined); this.leases.delete(leaseId); }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const runtime = await this.inspectLease(leaseId); return { driver: this.name, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed }; }
}
