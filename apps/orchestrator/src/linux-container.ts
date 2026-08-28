import type { PoolResources } from "@mars/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";

export type LinuxDockerResult = { code: number; stdout: string; stderr: string };
export type LinuxDockerRunner = (args: string[]) => Promise<LinuxDockerResult>;
export type LinuxContainerConfig = {
  image?: string;
  prefix: string;
  bootstrapRoot: string;
  limits: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
  readyTimeoutMs?: number;
  jobTimeoutMs?: number;
};
async function defaultDocker(args: string[]): Promise<LinuxDockerResult> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
}
function checked(result: LinuxDockerResult, operation: string): string {
  if (result.code !== 0) throw new Error(`${operation} failed: ${result.stderr.replaceAll(/\r?\n/g, " ").slice(0, 500)}`);
  return result.stdout.trim();
}
function memory(value: number): string { return `${Math.max(1, Math.floor(value))}b`; }

export class LinuxContainerDriver implements RuntimeDriver {
  readonly name = "linux-container" as const;
  private readonly leases = new Map<string, { name: string; runtime: RuntimeLease }>();
  private reserved = 0;
  constructor(private readonly config: LinuxContainerConfig, private readonly docker: LinuxDockerRunner = defaultDocker) {}
  private nameFor(id: string): string { return `${this.config.prefix}-${id}`; }
  validatePool(resources: PoolResources): void {
    validateResources(resources, this.config.limits);
  }
  async reserveCapacity(resources: PoolResources): Promise<void> {
    this.validatePool(resources);
    const info = await this.docker(["info"]);
    checked(info, "Docker info");
    if (this.reserved + resources.concurrency > this.config.limits.maxConcurrentPods) throw new Error("capacity exhausted");
    this.reserved += resources.concurrency;
  }
  async createLease(lease: Lease): Promise<RuntimeLease> {
    this.validatePool(lease.resources);
    const name = this.nameFor(lease.id);
    const image = this.config.image ?? lease.imageDigest;
    if (!/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("Linux container image must be digest pinned");
    const args = ["run", "-d", "--name", name, "--cpus", String(lease.resources.vcpu), "--memory", memory(lease.resources.memoryBytes), "--label", `mars.lease=${lease.id}`, "--label", `mars.job=${lease.jobId}`];
    if (lease.workerCache) args.push("-e", `MARS_CACHE_PROXY_URL=${lease.workerCache.proxyUrl}`, "-e", `MARS_CACHE_BASE_URL=${lease.workerCache.cacheBaseUrl}`);
    args.push(image);
    const started = checked(await this.docker(args), "docker run");
    const runtime: RuntimeLease = {
      runtimeInstanceId: started.split("\n")[0] ?? name,
      observed: { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: lease.resources.storageBytes },
      state: "sandbox_attested",
      completion: this.wait(name),
      sample: async () => {
        const raw = checked(await this.docker(["stats", "--no-stream", "--format", "{{json .}}", name]), "docker stats");
        const row = JSON.parse(raw) as { CPUPerc?: string; MemUsage?: string };
        const working = Number.parseFloat((row.MemUsage ?? "0").split("/")[0]?.replace(/[^0-9.]/g, "") ?? "0");
        return { cpuUsagePercent: Number.parseFloat((row.CPUPerc ?? "0").replace("%", "")) || 0, cpuTimeMs: 0, memoryWorkingSetBytes: working || 0, memoryLimitBytes: lease.resources.memoryBytes };
      },
    };
    this.leases.set(lease.id, { name, runtime });
    return runtime;
  }
  private async wait(name: string): Promise<number> {
    const result = await this.docker(["wait", name]);
    if (result.code !== 0) throw new Error(`docker wait failed: ${result.stderr}`);
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }
  async inspectLease(leaseId: string): Promise<RuntimeLease> { const owned = this.leases.get(leaseId); if (!owned) throw new Error("lease not found"); return owned.runtime; }
  async stopLease(leaseId: string): Promise<void> { const owned = this.leases.get(leaseId); if (!owned) return; await this.docker(["stop", "--time", "10", owned.name]); }
  async removeLease(leaseId: string): Promise<void> { const owned = this.leases.get(leaseId); if (!owned) return; await this.docker(["rm", "-f", owned.name]); this.leases.delete(leaseId); }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const owned = this.leases.get(leaseId); return owned ? { container: owned.name } : {}; }
  async collectRawDiagnostics(leaseId: string): Promise<string> { const owned = this.leases.get(leaseId); if (!owned) return ""; return (await this.docker(["logs", "--timestamps", owned.name])).stdout; }
}
