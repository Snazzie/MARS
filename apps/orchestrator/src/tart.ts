import type { PoolResources } from "@whitesmith/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";

export interface TartVmRuntime {
  clone(baseImage: string, vmName: string): Promise<void>;
  setResources(vmName: string, resources: PoolResources): Promise<void>;
  start(vmName: string): Promise<void>;
  stop(vmName: string): Promise<void>;
  remove(vmName: string): Promise<void>;
}

export function createTartVmRuntime(): TartVmRuntime {
  const processes = new Map<string, Bun.Subprocess>();
  async function run(args: string[]): Promise<void> {
    const process = Bun.spawn(["tart", ...args], { stdout: "ignore", stderr: "pipe" });
    if (await process.exited !== 0) throw new Error(`tart ${args[0]} failed`);
  }
  return {
    clone: (baseImage, vmName) => run(["clone", baseImage, vmName]),
    setResources: (vmName, resources) => run(["set", vmName, "--cpu", String(resources.vcpu), "--memory", String(resources.memoryBytes / 1024 ** 2), "--disk-size", String(resources.storageBytes / 1024 ** 3)]),
    async start(vmName) {
      if (processes.has(vmName)) throw new Error(`Tart VM already running: ${vmName}`);
      const process = Bun.spawn(["tart", "run", "--no-graphics", "--net-softnet", vmName], { stdout: "ignore", stderr: "ignore" });
      processes.set(vmName, process);
      void process.exited.then(() => processes.delete(vmName));
    },
    async stop(vmName) {
      await run(["stop", vmName]);
      processes.delete(vmName);
    },
    async remove(vmName) {
      await run(["delete", vmName]);
      processes.delete(vmName);
    },
  };
}

export class TartVmDriver implements RuntimeDriver {
  readonly name = "tart-vm" as const;
  private readonly leases = new Map<string, { vmName: string; runtime: RuntimeLease }>();

  constructor(
    private readonly tart: TartVmRuntime,
    private readonly baseImage: string,
    private readonly namePrefix: string,
    private readonly limits = { maxVcpuPerPod: 16, maxMemoryBytesPerPod: 64 * 1024 ** 3, maxStorageBytesPerPod: 256 * 1024 ** 3, maxConcurrentPods: 4 },
  ) {}

  validatePool(resources: PoolResources): void { validateResources(resources, this.limits); }
  async reserveCapacity(resources: PoolResources): Promise<void> { this.validatePool(resources); }

  async createLease(lease: Lease): Promise<RuntimeLease> {
    this.validatePool(lease.resources);
    const vmName = `${this.namePrefix}-${lease.id.slice(0, 8)}`;
    await this.tart.clone(this.baseImage, vmName);
    await this.tart.setResources(vmName, lease.resources);
    try {
      await this.tart.start(vmName);
    } catch (error) {
      await this.tart.remove(vmName).catch(() => undefined);
      throw error;
    }
    const runtime: RuntimeLease = { runtimeInstanceId: vmName, observed: { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: lease.resources.storageBytes }, state: "sandbox_attested" };
    this.leases.set(lease.id, { vmName, runtime });
    return runtime;
  }

  async inspectLease(leaseId: string): Promise<RuntimeLease> { const lease = this.leases.get(leaseId); if (!lease) throw new Error("sandbox not found"); return lease.runtime; }
  async stopLease(leaseId: string): Promise<void> { const lease = this.leases.get(leaseId); if (!lease) throw new Error("sandbox not found"); await this.tart.stop(lease.vmName); }
  async removeLease(leaseId: string): Promise<void> { const lease = this.leases.get(leaseId); if (!lease) return; await this.tart.remove(lease.vmName); this.leases.delete(leaseId); }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const runtime = await this.inspectLease(leaseId); return { driver: this.name, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed }; }
}
