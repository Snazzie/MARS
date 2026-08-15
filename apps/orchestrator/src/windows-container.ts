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

export class WindowsContainerDriver implements RuntimeDriver {
  readonly name = "windows-hyperv-container" as const;
  private readonly leases = new Map<string, { name: string; root: string; runtime: RuntimeLease }>();
  constructor(private readonly config: WindowsContainerConfig, private readonly docker: DockerRunner = defaultDocker) {}
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
    const root = join(this.config.bootstrapRoot, lease.id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "bootstrap.json"), JSON.stringify({ version: 1, leaseId: lease.id, nonce: lease.nonce, encodedJitConfig: lease.encodedJitConfig }), { mode: 0o600, flag: "wx" });
    const name = `${this.config.prefix}-${lease.id}`;
    try {
      checked(await this.docker(["create", "--name", name, "--isolation=hyperv", "--label", "whitesmith.managed=true", "--label", `whitesmith.lease-id=${lease.id}`, "--cpus", String(lease.resources.vcpu), "--memory", String(lease.resources.memoryBytes), "--mount", `type=bind,source=${root},target=C:\\ProgramData\\Whitesmith\\bootstrap,readonly`, this.config.image]), "docker create");
      checked(await this.docker(["start", name]), "docker start");
      const inspect = JSON.parse(checked(await this.docker(["inspect", name]), "docker inspect")) as Array<{ HostConfig?: { Isolation?: string } }>;
      if (inspect[0]?.HostConfig?.Isolation?.toLowerCase() !== "hyperv") throw new Error("container isolation is not Hyper-V");
      const runtime: RuntimeLease = { runtimeInstanceId: name, observed: { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: lease.resources.storageBytes }, state: "sandbox_attested", completion: this.wait(name) };
      this.leases.set(lease.id, { name, root, runtime });
      return runtime;
    } catch (error) { await this.removeLease(lease.id).catch(() => undefined); throw error; }
  }
  private async wait(name: string): Promise<number> { const result = await this.docker(["wait", name]); if (result.code !== 0) throw new Error("container completion failed"); const code = Number(result.stdout.trim()); if (!Number.isInteger(code)) throw new Error("container exit code invalid"); return code; }
  async inspectLease(leaseId: string): Promise<RuntimeLease> { const lease = this.leases.get(leaseId); if (!lease) throw new Error("sandbox not found"); return lease.runtime; }
  async stopLease(leaseId: string): Promise<void> { const lease = this.leases.get(leaseId); if (lease) checked(await this.docker(["stop", "--time", "10", lease.name]), "docker stop"); }
  async removeLease(leaseId: string): Promise<void> { const lease = this.leases.get(leaseId); if (!lease) return; try { await this.docker(["rm", "-f", lease.name]); } finally { this.leases.delete(leaseId); await rm(lease.root, { recursive: true, force: true }); } }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const lease = await this.inspectLease(leaseId); return { isolation: "hyperv", runtimeInstanceId: lease.runtimeInstanceId, observed: lease.observed }; }
}
