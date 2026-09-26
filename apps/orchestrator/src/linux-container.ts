import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerContainerStatus, type PoolResources, type WorkerLimits } from "@mars/contracts";
import { z } from "zod";
import { type Lease, type RuntimeDriver, type RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";
import type { DockerResult, DockerRunner } from "./windows-container.ts";
import { validateExclusiveCpuIds } from "./cpu-inventory.ts";

export type LinuxContainerConfig = {
  image: string;
  prefix: string;
  network: string;
  limits: WorkerLimits;
  architecture?: "arm64" | "amd64";
  platform?: "linux/arm64" | "linux/amd64";
  hostPlacement: "linux-pin" | "serialized-no-pin";
};

type DockerInspection = {
  Id?: unknown;
  Name?: unknown;
  RepoDigests?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  State?: { Status?: unknown };
  Config?: { Image?: unknown; Entrypoint?: unknown; Labels?: Record<string, unknown> };
  HostConfig?: { NanoCpus?: unknown; Memory?: unknown; CpusetCpus?: unknown };
  SizeRw?: unknown;
};
type WorkerContainerStatusData = z.infer<typeof WorkerContainerStatus>;
type DockerStats = { ID?: unknown; Container?: unknown; CPUPerc?: unknown; MemUsage?: unknown };
const digestPattern = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const expectedEntrypoint = ["/usr/local/bin/entrypoint.sh"] as const;
const notFound = /no such container|no such object|container .* not found|does not exist/i;
const diagnosticLimit = 10 * 1024 * 1024;

export function isExpectedLinuxContainerEntrypoint(value: unknown): boolean {
  return Array.isArray(value) && value.length === expectedEntrypoint.length && value[0] === expectedEntrypoint[0];
}

function checked(result: DockerResult, operation: string): string {
  if (result.code !== 0) throw new Error(`${operation} failed: ${result.stderr.replaceAll(/\r?\n/g, " ").slice(0, 500)}`);
  return result.stdout.trim();
}

async function defaultDocker(args: string[]): Promise<DockerResult> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  const longRunning = args[0] === "wait" || (args[0] === "logs" && args.includes("--follow"));
  const timeout = longRunning ? undefined : setTimeout(() => process.kill(), 30_000);
  try {
    return { code: await process.exited, stdout: await stdout, stderr: await stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(value: string, operation: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function optionalCpu(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value.replace("%", ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

function parseSize(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function parseMemoryBytes(value: string | undefined): number {
  const match = value?.replaceAll(",", "").match(/([\d.]+)\s*([KMG]?i?B)/i);
  if (!match) return 0;
  const units: Record<string, number> = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 };
  return Math.round(Number(match[1]) * (units[match[2]!.toLowerCase()] ?? 1));
}

function parseInspect(stdout: string): DockerInspection[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("docker inspect returned invalid JSON");
  return parsed as DockerInspection[];
}

function redact(value: string): string {
  return value.replaceAll(/(authorization\s*:\s*bearer\s+)[^\s\r\n]+/gi, "$1[REDACTED]").replaceAll(/([?&](?:token|sig|signature|access_token|oauth_token)=)[^&\s]+/gi, "$1[REDACTED]");
}

async function readDockerInfo(docker: DockerRunner): Promise<{ os: string; architecture: string }> {
  const result = await docker(["info", "--format", "{{json .}}"]);
  if (result.code !== 0) throw new Error(`Docker engine unavailable: ${result.stderr.slice(0, 500)}`);
  const raw = result.stdout.trim();
  if (raw === "linux/arm64" || raw === "linux/aarch64") return { os: "linux", architecture: raw.slice("linux/".length) };
  const info = parseJson(raw, "docker info");
  return { os: String(info.OSType ?? info.Os ?? ""), architecture: String(info.Architecture ?? info.architecture ?? "") };
}

export class LinuxContainerDriver implements RuntimeDriver {
  readonly name = "linux-docker-container" as const;
  private readonly architecture: "arm64" | "amd64";
  private readonly dockerPlatform: "linux/arm64" | "linux/amd64";
  private readonly platformLabel: "linux-arm64" | "linux-x64";
  private readonly leases = new Map<string, { name: string; root: string; runtime: RuntimeLease }>();
  private readonly gracefulStops = new Set<string>();

  constructor(private readonly config: LinuxContainerConfig, private readonly docker: DockerRunner = defaultDocker) {
    this.architecture = config.architecture ?? "arm64";
    this.dockerPlatform = config.platform ?? (this.architecture === "amd64" ? "linux/amd64" : "linux/arm64");
    if (this.dockerPlatform !== (this.architecture === "amd64" ? "linux/amd64" : "linux/arm64")) throw new Error("Linux Docker platform does not match configured architecture");
    this.platformLabel = this.architecture === "amd64" ? "linux-x64" : "linux-arm64";
  }

  private containerName(leaseId: string): string { return `${this.config.prefix}-${leaseId}`; }
  private bootstrapPath(leaseId: string): string { return join(tmpdir(), `mars-${this.platformLabel}`, leaseId); }

  validatePool(resources: PoolResources): void {
    validateResources(resources, this.config.limits);
    if (!digestPattern.test(this.config.image)) throw new Error("Linux container image must be digest pinned");
  }

  private async inspectImage(): Promise<DockerInspection> {
    const parsed = JSON.parse(await this.docker(["image", "inspect", "--format", "{{json .}}", this.config.image]).then((result) => checked(result, "image inspect"))) as unknown;
    const image = (Array.isArray(parsed) ? parsed[0] : parsed) as DockerInspection | undefined;
    if (!image) throw new Error("configured Linux image is unavailable");
    const repoDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
    if (!repoDigests.includes(this.config.image)) throw new Error("requested image digest is not present");
    const aliases = this.architecture === "amd64" ? ["amd64", "x86_64"] : ["arm64", "aarch64"];
    if (image.Os !== "linux" || !aliases.includes(String(image.Architecture).toLowerCase())) throw new Error(`Linux ${this.platformLabel} image architecture is invalid`);
    if (!isExpectedLinuxContainerEntrypoint(image.Config?.Entrypoint)) throw new Error("Linux container image entrypoint is invalid");
    return image;
  }

  async reserveCapacity(resources: PoolResources): Promise<void> {
    this.validatePool(resources);
    const info = await readDockerInfo(this.docker);
    if (info.os.toLowerCase() !== "linux") throw new Error("Linux Docker engine is required");
    const aliases = this.architecture === "amd64" ? ["amd64", "x86_64"] : ["arm64", "aarch64"];
    if (!aliases.includes(info.architecture.toLowerCase())) throw new Error(`${this.platformLabel} Docker engine is required`);
    await this.inspectImage();
    checked(await this.docker(["network", "inspect", this.config.network]), "network inspect");
  }
  async validateHost(): Promise<{ runtimeReady: boolean; networkReady: boolean; imageReady: boolean; architecture: string; engineOs: string; entrypointReady: boolean; artifactDigest: string }> {
    try {
      const info = await readDockerInfo(this.docker);
      const image = await this.inspectImage();
      const network = await this.docker(["network", "inspect", this.config.network]);
      const architecture = info.architecture.toLowerCase();
      const engineOs = info.os.toLowerCase();
      const aliases = this.architecture === "amd64" ? ["amd64", "x86_64"] : ["arm64", "aarch64"];
      const networkReady = network.code === 0;
      const ready = engineOs === "linux" && aliases.includes(architecture) && networkReady;
      return { runtimeReady: ready, networkReady, imageReady: true, architecture, engineOs, entrypointReady: isExpectedLinuxContainerEntrypoint(image.Config?.Entrypoint), artifactDigest: this.config.image };
    } catch {
      return { runtimeReady: false, networkReady: false, imageReady: false, architecture: "", engineOs: "", entrypointReady: false, artifactDigest: this.config.image };
    }
  }

  async createLease(lease: Lease): Promise<RuntimeLease> {
    if (lease.imageDigest !== this.config.image) throw new Error(`lease image digest does not match ${this.platformLabel} container image`);
    await this.reserveCapacity(lease.resources);
    if (lease.cpuMode !== "exclusive" && lease.cpuIds?.length) throw new Error("shared lease cannot claim CPU IDs");
    const cpuSet = lease.cpuMode === "exclusive" && this.config.hostPlacement === "linux-pin" ? await validateExclusiveCpuIds(lease.cpuIds, lease.resources.vcpu) : undefined;
    if (lease.cpuMode === "exclusive" && this.config.hostPlacement === "serialized-no-pin" && lease.cpuIds !== undefined) throw new Error("serialized exclusive lease cannot claim CPU IDs");
    if (lease.cpuMode === "exclusive" && this.config.hostPlacement === "serialized-no-pin" && (this.config.limits.maxConcurrentPods !== 1 || (await this.ownedContainers()).length > 0)) throw new Error("exclusive Windows-hosted Docker worker already has a managed guest or concurrency exceeds one");
    const root = this.bootstrapPath(lease.id);
    const bootstrap = join(root, "bootstrap.json");
    const name = this.containerName(lease.id);
    await mkdir(root, { recursive: true });
    await writeFile(bootstrap, JSON.stringify({ version: 1, leaseId: lease.id, nonce: lease.nonce, encodedJitConfig: lease.encodedJitConfig, ...(lease.workerCache ? { workerCache: lease.workerCache } : {}) }), { mode: 0o600, flag: "wx" });
    try {
      if (cpuSet && await validateExclusiveCpuIds(lease.cpuIds, lease.resources.vcpu) !== cpuSet) throw new Error("exclusive CPU inventory changed before Docker create");
      checked(await this.docker(["create", "--name", name, "--platform", this.dockerPlatform, "--network", this.config.network, "--log-driver", "json-file", "--log-opt", "max-size=50m", "--log-opt", "max-file=3", "--label", "mars.managed=true", "--label", `mars.platform=${this.platformLabel}`, "--label", `mars.lease-id=${lease.id}`, "--cpus", String(lease.resources.vcpu), "--memory", String(lease.resources.memoryBytes), ...(cpuSet ? ["--cpuset-cpus", cpuSet] : []), this.config.image]), "docker create");
      checked(await this.docker(["cp", bootstrap, `${name}:/var/lib/mars/bootstrap/bootstrap.json`]), "docker cp");
      await rm(bootstrap, { force: true });
      checked(await this.docker(["start", name]), "docker start");
      const inspection = parseInspect(checked(await this.docker(["inspect", name]), "docker inspect"))[0];
      const labels = inspection?.Config?.Labels ?? {};
      if (labels["mars.managed"] !== "true" || labels["mars.platform"] !== this.platformLabel || labels["mars.lease-id"] !== lease.id) throw new Error("container labels do not attest lease ownership");
      if (inspection?.Config?.Image !== this.config.image && !(Array.isArray(inspection?.RepoDigests) && inspection.RepoDigests.includes(this.config.image))) throw new Error("started container image does not match requested digest");
      const observedVcpu = Number(inspection?.HostConfig?.NanoCpus ?? 0) / 1_000_000_000;
      const observedMemory = Number(inspection?.HostConfig?.Memory ?? 0);
      if (observedVcpu !== lease.resources.vcpu || observedMemory !== lease.resources.memoryBytes) throw new Error("container resource limits do not match requested values");
      if (cpuSet && inspection?.HostConfig?.CpusetCpus !== cpuSet) throw new Error("container CPU affinity does not match exclusive claim");
      const runtime: RuntimeLease = { runtimeInstanceId: name, observed: { vcpu: observedVcpu, memoryBytes: observedMemory, storageBytes: lease.resources.storageBytes }, state: "sandbox_attested", completion: this.wait(name), sample: this.sample(name, lease.resources.memoryBytes) };
      this.leases.set(lease.id, { name, root, runtime });
      return runtime;
    } catch (error) {
      try { await this.removeLease(lease.id); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Linux container provisioning and cleanup failed"); }
      throw error;
    } finally {
      await rm(bootstrap, { force: true });
    }
  }

  private async wait(name: string): Promise<number> {
    const result = await this.docker(["wait", name]);
    if (result.code !== 0) throw new Error("container completion failed");
    const code = Number(result.stdout.trim());
    if (!Number.isInteger(code)) throw new Error("container exit code invalid");
    return code;
  }

  private sample(name: string, configuredMemoryBytes: number): () => Promise<{ cpuUsagePercent: number; cpuTimeMs: number; memoryWorkingSetBytes: number; memoryLimitBytes: number }> {
    return async () => {
      const result = await this.docker(["stats", "--no-stream", "--format", "{{json .}}", name]);
      const parsed = JSON.parse(checked(result, "docker stats")) as { CPUPerc?: string; MemUsage?: string };
      const [working, limit] = (parsed.MemUsage ?? "").split("/");
      return { cpuUsagePercent: optionalCpu(parsed.CPUPerc) ?? 0, cpuTimeMs: 0, memoryWorkingSetBytes: parseMemoryBytes(working), memoryLimitBytes: parseMemoryBytes(limit) || configuredMemoryBytes };
    };
  }

  private async ownedContainers(): Promise<DockerInspection[]> {
    const ids = checked(await this.docker(["ps", "-a", "--filter", "label=mars.managed=true", "--filter", `label=mars.platform=${this.platformLabel}`, "--filter", "label=mars.lease-id", "--format", "{{.ID}}"]), "docker ps").split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return [];
    const result = await this.docker(["inspect", "--size", ...ids]);
    if (result.code !== 0) {
      if (notFound.test(`${result.stdout} ${result.stderr}`)) return [];
      checked(result, "docker inspect");
    }
    return parseInspect(checked(result, "docker inspect")).filter((inspection) => inspection.Config?.Labels?.["mars.managed"] === "true" && inspection.Config?.Labels?.["mars.platform"] === this.platformLabel && typeof inspection.Config?.Labels?.["mars.lease-id"] === "string");
  }

  async reconcileOrphans(): Promise<void> {
    const candidates = await this.ownedContainers();
    const errors: Error[] = [];
    await Promise.all(candidates.map(async (inspection) => {
      try {
        const result = await this.docker(["rm", "-f", "-v", String(inspection.Id)]);
        if (result.code !== 0 && !notFound.test(`${result.stdout} ${result.stderr}`)) checked(result, "docker rm");
      } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
    }));
    if (errors.length) throw new AggregateError(errors, "Linux container orphan reconciliation failed");
  }

  async listContainerStatuses(): Promise<WorkerContainerStatusData[]> {
    const inspections = await this.ownedContainers();
    const running = inspections.filter((inspection) => inspection.State?.Status === "running");
    const stats = new Map<string, DockerStats>();
    for (const inspection of running) {
      const result = await this.docker(["stats", "--no-stream", "--format", "{{json .}}", String(inspection.Id)]);
      if (result.code !== 0) continue;
      const row = JSON.parse(result.stdout) as DockerStats;
      for (const id of [row.ID, row.Container]) if (typeof id === "string") stats.set(id.toLowerCase(), row);
    }
    const sampledAt = new Date().toISOString();
    return inspections.map((inspection) => {
      const id = String(inspection.Id ?? "");
      const row = stats.get(id.toLowerCase()) ?? stats.get(id.slice(0, 12).toLowerCase());
      const [working, limit] = typeof row?.MemUsage === "string" ? row.MemUsage.split("/").map((part) => part.trim()) : [];
      return WorkerContainerStatus.parse({ containerId: id, name: String(inspection.Name ?? "").replace(/^\/+/, ""), leaseId: inspection.Config?.Labels?.["mars.lease-id"], state: inspection.State?.Status, cpuUsagePercent: row ? optionalCpu(row.CPUPerc) : null, memoryWorkingSetBytes: row ? parseMemoryBytes(working) : null, memoryLimitBytes: row && parseMemoryBytes(limit) > 0 ? parseMemoryBytes(limit) : null, diskUsageBytes: parseSize(inspection.SizeRw), sampledAt });
    }).sort((a, b) => a.name.localeCompare(b.name) || a.containerId.localeCompare(b.containerId));
  }

  async inspectLease(leaseId: string): Promise<RuntimeLease> {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error("sandbox not found");
    return lease.runtime;
  }

  async requestGracefulStop(leaseId: string, reason: "out_of_memory", message: string): Promise<boolean> {
    if (reason !== "out_of_memory" || this.gracefulStops.has(leaseId)) return this.gracefulStops.has(leaseId);
    this.gracefulStops.add(leaseId);
    const name = this.leases.get(leaseId)?.name ?? this.containerName(leaseId);
    console.warn("Requesting graceful Linux container stop", { leaseId, reason, message: message.slice(0, 256) });
    const result = await this.docker(["kill", "--signal", "TERM", name]);
    if (result.code !== 0 && !notFound.test(`${result.stdout} ${result.stderr}`)) { this.gracefulStops.delete(leaseId); return false; }
    return true;
  }

  async stopLease(leaseId: string): Promise<void> {
    const name = this.leases.get(leaseId)?.name ?? this.containerName(leaseId);
    const result = await this.docker(["stop", "--time", "10", name]);
    if (result.code !== 0 && !notFound.test(`${result.stdout} ${result.stderr}`)) checked(result, "docker stop");
  }

  async removeLease(leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    const name = lease?.name ?? this.containerName(leaseId);
    try {
      const result = await this.docker(["rm", "-f", "-v", name]);
      if (result.code !== 0 && !notFound.test(`${result.stdout} ${result.stderr}`)) checked(result, "docker rm");
    } finally {
      this.gracefulStops.delete(leaseId);
      this.leases.delete(leaseId);
      await rm(lease?.root ?? this.bootstrapPath(leaseId), { recursive: true, force: true });
    }
  }

  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> {
    const lease = await this.inspectLease(leaseId);
    return { driver: this.name, runtimeInstanceId: lease.runtimeInstanceId, observed: lease.observed, storageQuota: "admission_only", storageUsageTelemetry: true };
  }

  async collectRawDiagnostics(leaseId: string): Promise<string> {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error("sandbox not found");
    const run = async (args: string[]) => { try { return await this.docker(args); } catch (error) { return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; } };
    const [inspect, logs, diag] = await Promise.all([
      run(["inspect", lease.name]),
      run(["logs", "--timestamps", "--follow", lease.name]),
      run(["exec", lease.name, "sh", "-c", "for f in /opt/actions-runner/_diag/Runner_*.log /opt/actions-runner/_diag/Worker_*.log; do test -f \"$f\" && cat \"$f\"; done"]),
    ]);
    const bundle = `=== docker inspect ===\n${redact(inspect.stdout || inspect.stderr)}\n=== docker logs --timestamps --follow ===\n${redact(logs.stdout || logs.stderr)}\n=== runner _diag ===\n${redact(diag.stdout || diag.stderr)}`;
    return bundle.length > diagnosticLimit ? `${bundle.slice(0, diagnosticLimit)}\n=== diagnostic bundle truncated ===\n` : bundle;
  }
}
