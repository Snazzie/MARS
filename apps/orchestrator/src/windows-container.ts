import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolResources } from "@whitesmith/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";

type DockerResult = { code: number; stdout: string; stderr: string };
export type DockerRunner = (args: string[]) => Promise<DockerResult>;
export type WindowsContainerConfig = {
  image: string;
  limits: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
  bootstrapRoot?: string;
  maxJobRuntimeMs?: number;
  docker?: DockerRunner;
};

const digestPattern = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const defaultRoot = () => join(Bun.env.ProgramData ?? "C:\\ProgramData", "Whitesmith", "container-leases");
const defaultDocker: DockerRunner = async (args) => {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { code, stdout, stderr };
};
const resultError = (args: string[], result: DockerResult): Error => new Error(`docker ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);

export class WindowsContainerDriver implements RuntimeDriver {
  readonly name = "windows-containers" as const;
  private readonly run: DockerRunner;
  private readonly config: Required<Pick<WindowsContainerConfig, "bootstrapRoot" | "maxJobRuntimeMs">> & WindowsContainerConfig;
  private readonly active = new Map<string, RuntimeLease & { containerName: string; bootstrapPath: string }>();

  constructor(config: WindowsContainerConfig) {
    if (!digestPattern.test(config.image)) throw new Error("Windows container image must be pinned with @sha256 digest");
    this.config = { ...config, bootstrapRoot: config.bootstrapRoot ?? defaultRoot(), maxJobRuntimeMs: config.maxJobRuntimeMs ?? Number(Bun.env.WHITESMITH_MAX_JOB_RUNTIME_MS ?? 86_400_000) };
    this.run = config.docker ?? defaultDocker;
  }

  validatePool(resources: PoolResources): void { validateResources(resources, this.config.limits); }

  async reserveCapacity(resources: PoolResources): Promise<void> {
    this.validatePool(resources);
    const infoArgs = ["info", "--format", "{{.OSType}}"];
    const info = await this.run(infoArgs);
    if (info.code !== 0) throw resultError(infoArgs, info);
    if (info.stdout.trim().toLowerCase() !== "windows") throw new Error("Docker must be operating in Windows-container mode");
    const probeArgs = ["run", "--rm", "--isolation=hyperv", this.config.image, "cmd", "/c", "exit", "0"];
    const probe = await this.run(probeArgs);
    if (probe.code !== 0) throw resultError(probeArgs, probe);
  }

  private async wait(containerName: string): Promise<number> {
    const args = ["wait", containerName];
    const result = await this.run(args);
    if (result.code !== 0) throw resultError(args, result);
    return Number(result.stdout.trim());
  }

  async createLease(lease: Lease): Promise<RuntimeLease> {
    const existing = this.active.get(lease.id);
    if (existing) return existing;
    this.validatePool(lease.resources);
    if (!lease.imageDigest || lease.imageDigest !== this.config.image.split("@", 2)[1]) throw new Error("lease image digest does not match configured Windows container image");
    await mkdir(this.config.bootstrapRoot, { recursive: true });
    const containerName = `whitesmith-${lease.id}`;
    const bootstrapPath = join(this.config.bootstrapRoot, `${lease.id}-${randomUUID()}.json`);
    await writeFile(bootstrapPath, JSON.stringify({ version: 1, leaseId: lease.id, nonce: lease.nonce, encodedJitConfig: lease.encodedJitConfig }) + "\n", { mode: 0o600 });
    const runtime: RuntimeLease & { containerName: string; bootstrapPath: string } = { runtimeInstanceId: containerName, observed: { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: lease.resources.storageBytes }, state: "sandbox_attested", containerName, bootstrapPath };
    const createArgs = ["create", "--name", containerName, "--isolation=hyperv", "--label", `com.whitesmith.lease=${lease.id}`, "--label", "com.whitesmith.managed=true", "--cpus", String(lease.resources.vcpu), "--memory", String(lease.resources.memoryBytes), "--mount", `type=bind,source=${bootstrapPath},target=C:\\Whitesmith\\bootstrap.json,readonly`, this.config.image, "C:\\whitesmith-job-agent.exe", "guest-service", "--platform", "windows-x64", "--bootstrap-file", "C:\\Whitesmith\\bootstrap.json", "--runner-root", "C:\\actions-runner"];
    try {
      const created = await this.run(createArgs);
      if (created.code !== 0) throw resultError(createArgs, created);
      const startArgs = ["start", containerName];
      const started = await this.run(startArgs);
      if (started.code !== 0) throw resultError(startArgs, started);
      runtime.completion = this.wait(containerName);
      this.active.set(lease.id, runtime);
      return runtime;
    } catch (error) {
      await this.run(["rm", "-f", containerName]);
      await rm(bootstrapPath, { force: true });
      throw error;
    }
  }

  async inspectLease(leaseId: string): Promise<RuntimeLease> {
    const runtime = this.active.get(leaseId);
    if (!runtime) throw new Error("Windows container lease not found");
    return runtime;
  }

  async stopLease(leaseId: string): Promise<void> {
    const runtime = this.active.get(leaseId);
    if (!runtime) throw new Error("Windows container lease not found");
    const result = await this.run(["stop", "--time", "30", runtime.containerName]);
    if (result.code !== 0 && !/no such container|is not running/i.test(result.stderr)) throw resultError(["stop", runtime.containerName], result);
  }

  async removeLease(leaseId: string): Promise<void> {
    const runtime = this.active.get(leaseId);
    if (!runtime) return;
    const args = ["rm", "-f", runtime.containerName];
    const result = await this.run(args);
    await rm(runtime.bootstrapPath, { force: true });
    this.active.delete(leaseId);
    if (result.code !== 0 && !/no such container/i.test(result.stderr)) throw resultError(args, result);
  }

  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> {
    const runtime = await this.inspectLease(leaseId);
    return { leaseId, driver: this.name, runtimeInstanceId: runtime.runtimeInstanceId, image: this.config.image };
  }

  async reconcileOrphans(): Promise<string[]> {
    const result = await this.run(["ps", "-a", "--filter", "label=com.whitesmith.managed=true", "--format", "{{.ID}} {{.Label \"com.whitesmith.lease\"}}"]);
    if (result.code !== 0) throw resultError(["ps", "-a"], result);
    const removed: string[] = [];
    for (const line of result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const [container] = line.split(/\s+/, 1);
      if (container) { await this.run(["rm", "-f", container]); removed.push(container); }
    }
    return removed;
  }
}

export { digestPattern as windowsContainerImagePattern };
