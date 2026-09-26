import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkerContractCompatible, type GuestPlatform, type PoolResources, type WorkerCacheProxy } from "@mars/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { assertUnpinnedLease, validateResources } from "./runtime.ts";

type TartImage = { baseImage: string; imageDigest: string };
type TartImages = Record<"macos-arm64" | "linux-arm64", TartImage>;
export function resolveTartExecutable(configured: string | undefined): string {
  return configured?.trim() || "tart";
}

export const TART_JIT_CONFIG_PATH = "/tmp/mars/jit-config";
export function buildTartRunArguments(vmName: string, bootstrapDirectory: string): string[] {
  return ["run", "--no-graphics", "--no-audio", vmName];
}
export function buildTartBootstrapArguments(vmName: string): string[] {
  return ["exec", "-i", vmName, "sh", "-c", `set -eu; umask 077; install -d -m 700 /tmp/mars; rm -f ${TART_JIT_CONFIG_PATH}; cat > ${TART_JIT_CONFIG_PATH}; chmod 600 ${TART_JIT_CONFIG_PATH}`];
}
export function buildTartRunnerArguments(vmName: string): string[] {
  return [
    "exec",
    vmName,
    "/usr/local/bin/mars-job-agent",
    "bootstrap",
    "--config-file",
    TART_JIT_CONFIG_PATH,
    "--runner-root",
    "/opt/actions-runner",
  ];
}


export function buildTartSetArguments(vmName: string, resources: PoolResources, currentDiskGb: number): string[] {
  const args = ["set", vmName, "--cpu", String(resources.vcpu), "--memory", String(resources.memoryBytes / 1024 ** 2)];
  const requestedDiskGb = Math.ceil(resources.storageBytes / 1024 ** 3);
  if (requestedDiskGb > currentDiskGb) args.push("--disk-size", String(requestedDiskGb));
  return args;
}

export type TartRunnerExecution = { completion: Promise<number>; logs: AsyncIterable<string> };

class AsyncTextQueue implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private readonly readers: Array<(result: IteratorResult<string>) => void> = [];
  private closed = false;

  push(value: string): void {
    if (!value || this.closed) return;
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<string>>(resolve => this.readers.push(resolve));
      },
    };
  }
}

async function pumpText(stream: ReadableStream<Uint8Array>, queue: AsyncTextQueue): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) queue.push(decoder.decode(chunk, { stream: true }));
  queue.push(decoder.decode());
}

export interface TartVmRuntime {
  clone(baseImage: string, vmName: string): Promise<void>;
  setResources(vmName: string, resources: PoolResources): Promise<void>;
  startWithBootstrap(vmName: string, encodedJitConfig: string, workerCache?: WorkerCacheProxy): Promise<void>;
  startRunner(vmName: string): TartRunnerExecution;
  stop(vmName: string): Promise<void>;
  remove(vmName: string): Promise<void>;
  listManaged?(): Promise<string[]>;
  sample?(vmName: string, guestPlatform?: GuestPlatform): Promise<{ cpuUsagePercent: number; cpuTimeMs: number; memoryWorkingSetBytes: number; memoryLimitBytes: number; diskUsageBytes: number }>;
}

export function createTartVmRuntime(tartExecutable = resolveTartExecutable(Bun.env.MARS_TART_EXECUTABLE)): TartVmRuntime {
  const processes = new Map<string, Bun.Subprocess>();
  async function run(args: string[]): Promise<void> {
    let lastExit = 1;
    let lastError = "";
    for (let attempt = 0; attempt < (args[0] === "exec" ? 30 : 1); attempt += 1) {
      const process = Bun.spawn([tartExecutable, ...args], { stdout: "ignore", stderr: "pipe" });
      [lastExit, lastError] = await Promise.all([process.exited, new Response(process.stderr).text()]);
      if (lastExit === 0) return;
      if (args[0] === "exec") await Bun.sleep(1_000);
    }
    throw new Error(`tart ${args[0]} failed${lastError.trim() ? `: ${lastError.trim()}` : ""}`);
  }
  async function diskSizeGb(vmName: string): Promise<number> {
    const process = Bun.spawn([tartExecutable, "list", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) throw new Error(`tart list failed: ${stderr.trim()}`);
    const entries = JSON.parse(stdout) as Array<{ Name?: unknown; Disk?: unknown }>;
    const disk = entries.find(entry => entry.Name === vmName)?.Disk;
    if (typeof disk !== "number" || !Number.isFinite(disk) || disk <= 0) throw new Error(`Tart VM disk size unavailable: ${vmName}`);
    return disk;
  }
  return {
    clone: (baseImage, vmName) => run(["clone", baseImage, vmName]),
    setResources: async (vmName, resources) => run(buildTartSetArguments(vmName, resources, await diskSizeGb(vmName))),
    startRunner: vmName => {
      const process = Bun.spawn([tartExecutable, ...buildTartRunnerArguments(vmName)], { stdout: "pipe", stderr: "pipe" });
      const queue = new AsyncTextQueue();
      void Promise.all([pumpText(process.stdout, queue), pumpText(process.stderr, queue)]).finally(() => queue.close());
      return { completion: process.exited, logs: queue };
    },
    async startWithBootstrap(vmName, encodedJitConfig, workerCache) {
      if (processes.has(vmName)) throw new Error(`Tart VM already running: ${vmName}`);
      const config = workerCache ? JSON.stringify({ encodedJitConfig, workerCache }) : encodedJitConfig;
      const configBytes = Buffer.from(config, "utf8");
      try {
        const process = Bun.spawn([tartExecutable, ...buildTartRunArguments(vmName, "")], { stdout: "ignore", stderr: "ignore" });
        processes.set(vmName, process);
        void process.exited.then(() => processes.delete(vmName));
        let lastError = "";
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const bootstrap = Bun.spawn([tartExecutable, ...buildTartBootstrapArguments(vmName)], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
          bootstrap.stdin.write(configBytes);
          bootstrap.stdin.end();
          const [exitCode, stderr] = await Promise.all([bootstrap.exited, new Response(bootstrap.stderr).text()]);
          if (exitCode === 0) return;
          lastError = stderr.trim();
          await Bun.sleep(1_000);
        }
        throw new Error(`tart bootstrap failed${lastError ? `: ${lastError}` : ""}`);
      } finally {
        configBytes.fill(0);
      }
    },
    sample: async (vmName, guestPlatform = "linux-arm64") => {
      const command = guestPlatform === "macos-arm64"
        ? "set -eu; cpu=$(ps -Ao %cpu= | awk '{s+=$1} END {print s+0}'); rss=$(ps -Ao rss= | awk '{s+=$1} END {print s+0}'); mem=$(sysctl -n hw.memsize); disk=$(df -kP / | awk 'NR==2 {print $3+0}'); printf '%s %s %s %s' \"$cpu\" \"$rss\" \"$mem\" \"$disk\""
        : "set -eu; cpu=$(ps -eo pcpu= | awk '{s+=$1} END {print s+0}'); rss=$(ps -eo rss= | awk '{s+=$1} END {print s+0}'); mem=$(awk '/MemTotal/{print $2}' /proc/meminfo); disk=$(df -kP / | awk 'NR==2 {print $3+0}'); printf '%s %s %s %s' \"$cpu\" \"$rss\" \"$mem\" \"$disk\"";
      const process = Bun.spawn([tartExecutable, "exec", vmName, "sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      if (code !== 0) throw new Error(`tart resource sample failed: ${stderr.trim()}`);
      const [cpu, rss, mem, disk] = stdout.trim().split(/\s+/).map(Number);
      return { cpuUsagePercent: Math.max(0, Math.min(100, cpu || 0)), cpuTimeMs: 0, memoryWorkingSetBytes: Math.max(0, (rss || 0) * 1024), memoryLimitBytes: Math.max(1, mem || 1), diskUsageBytes: Math.max(0, (disk || 0) * 1024) };
    },
    listManaged: async () => {
      const process = Bun.spawn([tartExecutable, "list", "--format", "json"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      if (code !== 0) throw new Error(`tart inventory failed: ${stderr.trim()}`);
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== "object" || typeof (item.name ?? item.Name) !== "string")) throw new Error("tart inventory returned invalid JSON");
      return parsed.map(item => String(item.name ?? item.Name));
    },
    stop: async vmName => { await run(["stop", vmName]); processes.delete(vmName); },
    remove: async vmName => { await run(["delete", vmName]); processes.delete(vmName); },
  };
}

export class TartVmDriver implements RuntimeDriver {
  readonly name = "tart-vm" as const;
  private readonly leases = new Map<string, { vmName: string; runtime: RuntimeLease }>();
  private provisioning = Promise.resolve();

  private readonly images: TartImages;
  private readonly legacyImages: boolean;
  constructor(
    private readonly tart: TartVmRuntime,
    images: TartImages | string,
    private readonly namePrefix: string,
    private readonly limits = { maxVcpuPerPod: 16, maxMemoryBytesPerPod: 64 * 1024 ** 3, maxStorageBytesPerPod: 256 * 1024 ** 3, maxConcurrentPods: 4 },
    private readonly workerContractVersion = "",
  ) {
    this.legacyImages = typeof images === "string";
    this.images = typeof images === "string"
      ? { "macos-arm64": { baseImage: images, imageDigest: images }, "linux-arm64": { baseImage: images, imageDigest: images } }
      : images;
  }

  validatePool(resources: PoolResources): void { validateResources(resources, this.limits); }
  async reconcileOrphans(): Promise<void> {
    if (!this.tart.listManaged) throw new Error("tart inventory unavailable; cannot advertise exclusive readiness");
    const names = await this.tart.listManaged();
    for (const name of names) {
      if (!name.startsWith(`${this.namePrefix}-`)) continue;
      await this.tart.stop(name).catch(error => { if (!/not running/i.test(String(error))) throw error; });
      await this.tart.remove(name);
    }
  }
  async reserveCapacity(resources: PoolResources): Promise<void> { this.validatePool(resources); }

  async createLease(lease: Lease): Promise<RuntimeLease> {
    assertUnpinnedLease(lease);
    if (!isWorkerContractCompatible(lease.contractVersion, this.workerContractVersion)) throw new Error(`worker contract ${this.workerContractVersion || "unknown"} is not supported by control plane contract ${lease.contractVersion}`);
    const guestPlatform = lease.guestPlatform ?? "macos-arm64";
    const image = guestPlatform === "macos-arm64" || guestPlatform === "linux-arm64" ? this.images[guestPlatform] : undefined;
    if (!image) throw new Error(`unsupported Tart guest platform: ${lease.guestPlatform}`);
    if (!this.legacyImages && lease.imageDigest !== image.imageDigest) throw new Error(`lease image digest does not match prepared ${guestPlatform} Tart image`);
    this.validatePool(lease.resources);
    const previousProvisioning = this.provisioning;
    let releaseProvisioning!: () => void;
    this.provisioning = new Promise<void>(resolve => { releaseProvisioning = resolve; });
    await previousProvisioning;
    try {
      const vmName = `${this.namePrefix}-${lease.id.slice(0, 8)}`;
      await this.tart.clone(image.baseImage, vmName);
      try {
        await this.tart.setResources(vmName, lease.resources);
        await this.tart.startWithBootstrap(vmName, lease.encodedJitConfig, lease.workerCache);
        const execution = this.tart.startRunner(vmName);
        const runtime: RuntimeLease = { runtimeInstanceId: vmName, observed: { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: lease.resources.storageBytes }, state: "sandbox_attested", completion: execution.completion, logs: execution.logs, sample: this.tart.sample ? () => this.tart.sample!(vmName, guestPlatform) : undefined };
        this.leases.set(lease.id, { vmName, runtime });
        return runtime;
      } catch (error) {
        await this.tart.stop(vmName).catch(() => undefined);
        try { await this.tart.remove(vmName); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Tart provisioning and cleanup failed"); }
        throw error;
      }
    } finally {
      releaseProvisioning();
    }
  }
  async inspectLease(leaseId: string): Promise<RuntimeLease> { const lease = this.leases.get(leaseId); if (!lease) throw new Error("sandbox not found"); return lease.runtime; }
  private vmName(leaseId: string): string { return this.leases.get(leaseId)?.vmName ?? `${this.namePrefix}-${leaseId.slice(0, 8)}`; }
  async stopLease(leaseId: string): Promise<void> { await this.tart.stop(this.vmName(leaseId)); }
  async removeLease(leaseId: string): Promise<void> { try { await this.tart.remove(this.vmName(leaseId)); } catch (error) { if (!(error instanceof Error && /specified VM .* does not exist/.test(error.message))) throw error; } finally { this.leases.delete(leaseId); } }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const runtime = await this.inspectLease(leaseId); return { driver: this.name, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed }; }
}
