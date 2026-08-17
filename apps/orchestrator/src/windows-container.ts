import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolResources, WorkerLimits } from "@whitesmith/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";

export type DockerResult = { code: number; stdout: string; stderr: string };
export type DockerRunner = (args: string[]) => Promise<DockerResult>;
export type WindowsContainerConfig = { image: string; prefix: string; bootstrapRoot: string; limits: WorkerLimits; readyTimeoutMs: number; jobTimeoutMs: number; allowLocalImage?: boolean };
const digest = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const localImage = "whitesmith/windows-job:local";

async function defaultDocker(args: string[]): Promise<DockerResult> { const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" }); return { code: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() }; }
function checked(result: DockerResult, operation: string): string { if (result.code !== 0) throw new Error(`${operation} failed: ${result.stderr.replaceAll(/\r?\n/g, " ").slice(0, 500)}`); return result.stdout.trim(); }
function parseMemoryBytes(value: string): number { const match = value.replaceAll(",", "").match(/([\d.]+)\s*([KMG]?i?B)/i); if (!match) return 0; const units: Record<string, number> = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 }; return Math.round(Number(match[1]) * (units[match[2]!.toLowerCase()] ?? 1)); }
function dockerSample(name: string, docker: DockerRunner) {
  return async () => {
    const raw = checked(await docker(["stats", "--no-stream", "--format", "{{json .}}", name]), "docker stats");
    const value = JSON.parse(raw) as { CPUPerc?: string; MemUsage?: string };
    const cpuUsagePercent = Math.max(0, Math.min(100, Number.parseFloat(value.CPUPerc?.replace("%", "") ?? "0")));
    const [working, limit] = (value.MemUsage ?? "").split("/");
    return { cpuUsagePercent, cpuTimeMs: 0, memoryWorkingSetBytes: parseMemoryBytes(working ?? ""), memoryLimitBytes: Math.max(1, parseMemoryBytes(limit ?? "")) };
  };
}

export class WindowsContainerDriver implements RuntimeDriver {
  readonly name = "windows-hyperv-container" as const;
  private readonly leases = new Map<string, { name: string; root: string; runtime: RuntimeLease }>();
  constructor(private readonly config: WindowsContainerConfig, private readonly docker: DockerRunner = defaultDocker) {}
  private containerName(leaseId: string): string { return `${this.config.prefix}-${leaseId}`; }
  private bootstrapPath(leaseId: string): string { return join(this.config.bootstrapRoot, leaseId); }
  validatePool(resources: PoolResources): void { validateResources(resources, this.config.limits); if (!digest.test(this.config.image) && !(this.config.allowLocalImage && this.config.image === localImage)) throw new Error("Windows container image must be digest pinned"); }
  async reserveCapacity(resources: PoolResources): Promise<void> {
    this.validatePool(resources);
    if (checked(await this.docker(["info", "--format", "{{.OSType}}"]), "docker info") !== "windows") throw new Error("Windows Docker engine is required");
    if (this.config.allowLocalImage && this.config.image === localImage) {
      checked(await this.docker(["image", "inspect", this.config.image]), "image inspect");
    } else {
      const digests = JSON.parse(checked(await this.docker(["image", "inspect", "--format", "{{json .RepoDigests}}", this.config.image]), "image inspect")) as string[];
      if (!digests.includes(this.config.image)) throw new Error("requested image digest is not present");
    }
  }
  async createLease(lease: Lease): Promise<RuntimeLease> {
    this.validatePool(lease.resources);
    const root = this.bootstrapPath(lease.id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "bootstrap.json"), JSON.stringify({ version: 1, leaseId: lease.id, nonce: lease.nonce, encodedJitConfig: lease.encodedJitConfig }), { mode: 0o600, flag: "wx" });
    const name = this.containerName(lease.id);
    try {
      checked(await this.docker(["create", "--name", name, "--isolation=hyperv", "--label", "whitesmith.managed=true", "--label", `whitesmith.lease-id=${lease.id}`, "--cpus", String(lease.resources.vcpu), "--memory", String(lease.resources.memoryBytes), "--storage-opt", `size=${lease.resources.storageBytes}`, "--mount", `type=bind,source=${root},target=C:\\ProgramData\\Whitesmith\\bootstrap,readonly`, this.config.image]), "docker create");
      checked(await this.docker(["start", name]), "docker start");
      const inspect = JSON.parse(checked(await this.docker(["inspect", name]), "docker inspect")) as Array<{ HostConfig?: { Isolation?: string } }>;
      const runtime: RuntimeLease = { runtimeInstanceId: name, observed: { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: lease.resources.storageBytes }, state: "sandbox_attested", completion: this.wait(name), sample: dockerSample(name, this.docker) };
      if (inspect[0]?.HostConfig?.Isolation?.toLowerCase() !== "hyperv") throw new Error("container isolation is not Hyper-V");
      this.leases.set(lease.id, { name, root, runtime });
      return runtime;
    } catch (error) { await this.removeLease(lease.id).catch(() => undefined); throw error; }
  }
  private async wait(name: string): Promise<number> {
    const completion = this.docker(["wait", name]).then((result) => {
      if (result.code !== 0) throw new Error("container completion failed");
      const code = Number(result.stdout.trim());
      if (!Number.isInteger(code)) throw new Error("container exit code invalid");
      return code;
    });
    const timeout = Bun.sleep(this.config.jobTimeoutMs).then(() => {
      throw new Error(`container job timed out after ${this.config.jobTimeoutMs}ms`);
    });
    return Promise.race([completion, timeout]);
  }
  async inspectLease(leaseId: string): Promise<RuntimeLease> { const lease = this.leases.get(leaseId); if (!lease) throw new Error("sandbox not found"); return lease.runtime; }
  async stopLease(leaseId: string): Promise<void> {
    const name = this.leases.get(leaseId)?.name ?? this.containerName(leaseId);
    const result = await this.docker(["stop", "--time", "10", name]);
    if (result.code !== 0 && !/no such container/i.test(result.stderr)) checked(result, "docker stop");
  }
  async removeLease(leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    const name = lease?.name ?? this.containerName(leaseId);
    const root = lease?.root ?? this.bootstrapPath(leaseId);
    try {
      const result = await this.docker(["rm", "-f", name]);
      if (result.code !== 0 && !/no such container/i.test(result.stderr)) checked(result, "docker rm");
    } finally {
      this.leases.delete(leaseId);
      await rm(root, { recursive: true, force: true });
    }
  }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const lease = await this.inspectLease(leaseId); return { isolation: "hyperv", runtimeInstanceId: lease.runtimeInstanceId, observed: lease.observed }; }
}
