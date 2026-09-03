import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { WorkerContainerStatus, type PoolResources, type WorkerContainerStatus as WorkerContainerStatusData, type WorkerLimits } from "@mars/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";

export type DockerResult = { code: number; stdout: string; stderr: string };
export type DockerRunner = (args: string[]) => Promise<DockerResult>;
export type WindowsContainerConfig = { image: string; prefix: string; bootstrapRoot: string; limits: WorkerLimits; readyTimeoutMs: number; jobTimeoutMs: number; allowLocalImage?: boolean; imageManifestPath?: string; requireLocalImageManifest?: boolean; dnsServers?: string[] };
export function parseWindowsContainerDnsServers(value: string | undefined): string[] {
  return (value ?? "").split(",").map((server) => server.trim()).filter((server) => isIP(server) !== 0);
}
const digest = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const localImage = "mars/windows-job:local";
const expectedWindowsEntrypoint = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-File", "C:/Mars/entrypoint.ps1"] as const;
export function isExpectedWindowsEntrypoint(value: unknown): boolean {
  return Array.isArray(value) && value.length === expectedWindowsEntrypoint.length && expectedWindowsEntrypoint.every((entry, index) => value[index] === entry);
}
async function defaultDocker(args: string[]): Promise<DockerResult> { const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" }); return { code: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() }; }
function checked(result: DockerResult, operation: string): string { if (result.code !== 0) throw new Error(`${operation} failed: ${result.stderr.replaceAll(/\r?\n/g, " ").slice(0, 500)}`); return result.stdout.trim(); }
function parseMemoryBytes(value: string): number { const match = value.replaceAll(",", "").match(/([\d.]+)\s*([KMG]?i?B)/i); if (!match) return 0; const units: Record<string, number> = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 }; return Math.round(Number(match[1]) * (units[match[2]!.toLowerCase()] ?? 1)); }
async function waitForDockerEngine(docker: DockerRunner): Promise<string> {
  let delayMs = 1_000;
  for (;;) {
    const result = await docker(["info", "--format", "{{.OSType}}"]);
    if (result.code === 0) return result.stdout.trim();
    console.warn(`Docker engine unavailable; retrying in ${delayMs}ms: ${result.stderr.replaceAll(/\r?\n/g, " ").slice(0, 500)}`);
    await Bun.sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 30_000);
  }
}
async function validateLocalManifest(config: WindowsContainerConfig, docker: DockerRunner): Promise<void> {
  if (!config.requireLocalImageManifest) return;
  if (!config.imageManifestPath) throw new Error("local Windows image manifest path is required");
  let manifest: { schemaVersion?: number; image?: string; imageId?: string; runtimeProbe?: { mediaFoundation?: boolean; dns?: boolean; tcp443?: boolean } };
  try { manifest = JSON.parse(await Bun.file(config.imageManifestPath).text()); } catch { throw new Error("local Windows image manifest is unavailable"); }
  if (manifest.schemaVersion !== 1 || manifest.image !== config.image || !manifest.imageId) throw new Error("local Windows image manifest is invalid");
  if (!manifest.runtimeProbe?.mediaFoundation || !manifest.runtimeProbe.dns || !manifest.runtimeProbe.tcp443) throw new Error("local Windows image runtime probe is not verified");
  const imageId = checked(await docker(["image", "inspect", "--format", "{{.Id}}", config.image]), "image inspect");
  if (imageId !== manifest.imageId) throw new Error("local Windows image manifest image ID mismatch");
  const imageInspection = JSON.parse(checked(await docker(["image", "inspect", "--format", "{{json .}}", config.image]), "image inspect")) as { Config?: { Entrypoint?: unknown } };
  if (!isExpectedWindowsEntrypoint(imageInspection.Config?.Entrypoint)) throw new Error("Windows container image entrypoint is invalid");
}
function dockerSample(name: string, configuredMemoryBytes: number, docker: DockerRunner) {
  return async () => {
    const raw = checked(await docker(["stats", "--no-stream", "--format", "{{json .}}", name]), "docker stats");
    const value = JSON.parse(raw) as { CPUPerc?: string; MemUsage?: string };
    const cpuUsagePercent = Math.max(0, Math.min(100, Number.parseFloat(value.CPUPerc?.replace("%", "") ?? "0")));
    const [working, limit] = (value.MemUsage ?? "").split("/");
    const memoryWorkingSetBytes = parseMemoryBytes(working ?? "");
    const reportedLimitBytes = parseMemoryBytes(limit ?? "");
    const memoryLimitBytes = reportedLimitBytes >= configuredMemoryBytes ? reportedLimitBytes : configuredMemoryBytes;
    return { cpuUsagePercent, cpuTimeMs: 0, memoryWorkingSetBytes, memoryLimitBytes };
  };
}

type DockerInspection = {
  Id?: unknown;
  Name?: unknown;
  Config?: { Labels?: Record<string, unknown> };
  State?: { Status?: unknown };
  SizeRw?: unknown;
};
type DockerStats = { ID?: unknown; Container?: unknown; CPUPerc?: unknown; MemUsage?: unknown };
const dockerNotFound = /no such container|no such object|container .* not found|does not exist/i;
function isDockerNotFound(result: DockerResult): boolean {
  return dockerNotFound.test(`${result.stdout} ${result.stderr}`);
}
function parseInspectOutput(stdout: string): DockerInspection[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("docker inspect returned invalid JSON");
  return parsed as DockerInspection[];
}
function parseStatsOutput(stdout: string): DockerStats[] {
  const rows: DockerStats[] = [];
  for (const line of stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const parsed: unknown = JSON.parse(line);
    if (Array.isArray(parsed)) rows.push(...(parsed as DockerStats[]));
    else if (parsed && typeof parsed === "object") rows.push(parsed as DockerStats);
    else throw new Error("docker stats returned invalid JSON");
  }
  return rows;
}
function optionalMemoryBytes(value: unknown): number | null {
  if (typeof value !== "string" || !/[\d.]+\s*([KMG]?i?B)/i.test(value)) return null;
  const parsed = parseMemoryBytes(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function optionalCpuPercent(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}
function inspectSize(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("docker inspect SizeRw is invalid");
  return value;
}
const DIAGNOSTIC_LIMIT_BYTES = 10 * 1024 * 1024;
function redactRunnerLog(text: string): string {
  return text
    .replaceAll(/(authorization\s*:\s*bearer\s+)[^\s\r\n]+/gi, "$1[REDACTED]")
    .replaceAll(/([?&](?:token|sig|signature|access_token|oauth_token)=)[^&\s]+/gi, "$1[REDACTED]");
}
async function copyRunnerDiagnostics(root: string, containerName: string, run: (args: string[]) => Promise<DockerResult>): Promise<string> {
  const destination = join(root, "runner-diag");
  const copied = await run(["cp", `${containerName}:C:\\actions-runner\\_diag\\.`, destination]);
  if (copied.code !== 0) return `=== runner _diag copy failed ===\n${copied.stderr || copied.stdout}`;
  const files = (await readdir(destination, { withFileTypes: true }).catch(() => []))
    .filter(file => file.isFile() && (/^Runner_.*\.log$/i.test(file.name) || /^Worker_.*\.log$/i.test(file.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  let bytes = 0;
  const sections: string[] = [];
  for (const file of files) {
    if (bytes >= DIAGNOSTIC_LIMIT_BYTES) break;
    const content = redactRunnerLog(await readFile(join(destination, file.name), "utf8").catch(() => ""));
    const remaining = DIAGNOSTIC_LIMIT_BYTES - bytes;
    const section = `=== runner _diag\\${file.name} ===\n${content.slice(0, remaining)}`;
    sections.push(section);
    bytes += Buffer.byteLength(section);
  }
  if (bytes >= DIAGNOSTIC_LIMIT_BYTES) sections.push("=== runner _diag truncated ===\n");
  return sections.join("");
}

export class WindowsContainerDriver implements RuntimeDriver {
  readonly name = "windows-hyperv-container" as const;
  private readonly gracefulStops = new Set<string>();
  private readonly leases = new Map<string, { name: string; root: string; runtime: RuntimeLease }>();
  constructor(private readonly config: WindowsContainerConfig, private readonly docker: DockerRunner = defaultDocker) {}
  private containerName(leaseId: string): string { return `${this.config.prefix}-${leaseId}`; }
  private bootstrapPath(leaseId: string): string { return join(this.config.bootstrapRoot, leaseId); }
  validatePool(resources: PoolResources): void { validateResources(resources, this.config.limits); if (!digest.test(this.config.image) && !(this.config.allowLocalImage && this.config.image === localImage)) throw new Error("Windows container image must be digest pinned"); }
  async reserveCapacity(resources: PoolResources): Promise<void> {
    this.validatePool(resources);
    if (await waitForDockerEngine(this.docker) !== "windows") throw new Error("Windows Docker engine is required");
    if (this.config.allowLocalImage && this.config.image === localImage) {
      await validateLocalManifest(this.config, this.docker);
      checked(await this.docker(["image", "inspect", this.config.image]), "image inspect");
    } else {
      const digests = JSON.parse(checked(await this.docker(["image", "inspect", "--format", "{{json .RepoDigests}}", this.config.image]), "image inspect")) as string[];
      if (!digests.includes(this.config.image)) throw new Error("requested image digest is not present");
    }
  }
  async createLease(lease: Lease): Promise<RuntimeLease> {
    await this.reserveCapacity(lease.resources);
    const root = this.bootstrapPath(lease.id);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "bootstrap.json"), JSON.stringify({ version: 1, leaseId: lease.id, nonce: lease.nonce, encodedJitConfig: lease.encodedJitConfig, ...(lease.workerCache ? { workerCache: lease.workerCache } : {}) }), { mode: 0o600, flag: "wx" });
    const name = this.containerName(lease.id);
    const dnsArgs = parseWindowsContainerDnsServers(this.config.dnsServers?.join(",")).flatMap((server) => ["--dns", server]);
    try {
      checked(await this.docker(["create", "--name", name, "--log-driver", "json-file", "--log-opt", "max-size=50m", "--log-opt", "max-file=3", "--isolation=hyperv", "--label", "mars.managed=true", "--label", `mars.lease-id=${lease.id}`, "--cpus", String(lease.resources.vcpu), "--memory", String(lease.resources.memoryBytes), "--storage-opt", `size=${lease.resources.storageBytes}`, "--mount", `type=bind,source=${root},target=C:\\ProgramData\\Mars\\bootstrap,readonly`, ...dnsArgs, this.config.image]), "docker create");
      checked(await this.docker(["start", name]), "docker start");
      const inspect = JSON.parse(checked(await this.docker(["inspect", name]), "docker inspect")) as Array<{ HostConfig?: { Isolation?: string; NanoCpus?: number; Memory?: number } }>;
      if (inspect[0]?.HostConfig?.Isolation?.toLowerCase() !== "hyperv") throw new Error("container isolation is not Hyper-V");
      const observedVcpu = inspect[0]?.HostConfig?.NanoCpus;
      const observedMemoryBytes = inspect[0]?.HostConfig?.Memory;
      if (observedVcpu !== lease.resources.vcpu * 1_000_000_000 || observedMemoryBytes !== lease.resources.memoryBytes) throw new Error("container resource limits do not match requested values");
      const runtime: RuntimeLease = { runtimeInstanceId: name, observed: { vcpu: observedVcpu / 1_000_000_000, memoryBytes: observedMemoryBytes, storageBytes: lease.resources.storageBytes }, state: "sandbox_attested", completion: this.wait(name), sample: dockerSample(name, lease.resources.memoryBytes, this.docker) };
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
  private async inspectManagedContainers(ids: string[]): Promise<DockerInspection[]> {
    const batch = await this.docker(["inspect", "--size", ...ids]);
    if (batch.code === 0) return parseInspectOutput(checked(batch, "docker inspect"));
    if (!isDockerNotFound(batch)) checked(batch, "docker inspect");
    const rows: DockerInspection[] = [];
    for (const id of ids) {
      const result = await this.docker(["inspect", "--size", id]);
      if (result.code !== 0) {
        if (isDockerNotFound(result)) continue;
        checked(result, "docker inspect");
      }
      rows.push(...parseInspectOutput(checked(result, "docker inspect")));
    }
    return rows;
  }
  private async collectContainerStats(ids: string[]): Promise<{ rows: DockerStats[]; disappeared: Set<string> }> {
    if (ids.length === 0) return { rows: [], disappeared: new Set() };
    const batch = await this.docker(["stats", "--no-stream", "--format", "{{json .}}", ...ids]);
    if (batch.code === 0) return { rows: parseStatsOutput(checked(batch, "docker stats")), disappeared: new Set() };
    if (!isDockerNotFound(batch)) checked(batch, "docker stats");
    const rows: DockerStats[] = [];
    const disappeared = new Set<string>();
    for (const id of ids) {
      const result = await this.docker(["stats", "--no-stream", "--format", "{{json .}}", id]);
      if (result.code !== 0) {
        if (isDockerNotFound(result)) {
          disappeared.add(id);
          continue;
        }
        checked(result, "docker stats");
      }
      rows.push(...parseStatsOutput(checked(result, "docker stats")));
    }
    return { rows, disappeared };
  }
  async listContainerStatuses(): Promise<WorkerContainerStatusData[]> {
    const listed = checked(await this.docker(["ps", "-a", "--filter", "label=mars.managed=true", "--format", "{{.ID}}"]), "docker ps")
      .split(/\r?\n/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (listed.length === 0) return [];

    const inspections = await this.inspectManagedContainers(listed);
    const runningIds = inspections.flatMap((inspection) => inspection.State?.Status === "running" && typeof inspection.Id === "string" ? [inspection.Id] : []);
    const stats = await this.collectContainerStats(runningIds);
    const disappeared = new Set([...stats.disappeared].map((id) => id.toLowerCase()));
    const statsById = new Map<string, DockerStats>();
    for (const row of stats.rows) {
      for (const candidate of [row.ID, row.Container]) {
        if (typeof candidate === "string" && candidate.length > 0) statsById.set(candidate.toLowerCase(), row);
      }
    }
    const sampledAt = new Date().toISOString();
    const statuses: WorkerContainerStatusData[] = [];
    for (const inspection of inspections) {
      const id = typeof inspection.Id === "string" ? inspection.Id : "";
      if (disappeared.has(id.toLowerCase()) || disappeared.has(id.slice(0, 12).toLowerCase())) continue;
      const state = inspection.State?.Status;
      const running = state === "running";
      const statsRow = running ? statsById.get(id.toLowerCase()) ?? statsById.get(id.slice(0, 12).toLowerCase()) : undefined;
      const memoryUsage = typeof statsRow?.MemUsage === "string" ? statsRow.MemUsage.split("/").map((part) => part.trim()) : [];
      const memoryLimitBytes = statsRow ? optionalMemoryBytes(memoryUsage[1]) : null;
      const status = WorkerContainerStatus.parse({
        containerId: id,
        name: typeof inspection.Name === "string" ? inspection.Name.replace(/^\/+/, "") : "",
        leaseId: inspection.Config?.Labels?.["mars.lease-id"],
        state,
        cpuUsagePercent: statsRow ? optionalCpuPercent(statsRow.CPUPerc) : null,
        memoryWorkingSetBytes: statsRow ? optionalMemoryBytes(memoryUsage[0]) : null,
        memoryLimitBytes: memoryLimitBytes !== null && memoryLimitBytes > 0 ? memoryLimitBytes : null,
        diskUsageBytes: inspectSize(inspection.SizeRw),
        sampledAt,
      });
      statuses.push(status);
    }
    return statuses.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.containerId < b.containerId ? -1 : a.containerId > b.containerId ? 1 : 0);
  }
  async inspectLease(leaseId: string): Promise<RuntimeLease> { const lease = this.leases.get(leaseId); if (!lease) throw new Error("sandbox not found"); return lease.runtime; }
  async requestGracefulStop(leaseId: string, reason: "out_of_memory", message: string): Promise<boolean> {
    if (reason !== "out_of_memory" || this.gracefulStops.has(leaseId)) return this.gracefulStops.has(leaseId);
    const name = this.leases.get(leaseId)?.name ?? this.containerName(leaseId);
    this.gracefulStops.add(leaseId);
    console.warn("Requesting graceful job stop", { leaseId, reason, message: message.slice(0, 256) });
    const result = await this.docker(["exec", name, "cmd.exe", "/c", "taskkill", "/IM", "Runner.Listener.exe", "/T"]);
    if (result.code !== 0 && !/no instance|not found/i.test(`${result.stdout} ${result.stderr}`)) {
      this.gracefulStops.delete(leaseId);
      return false;
    }
    return true;
  }
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
      this.gracefulStops.delete(leaseId);
      this.leases.delete(leaseId);
      await rm(root, { recursive: true, force: true });
    }
  }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const lease = await this.inspectLease(leaseId); return { isolation: "hyperv", runtimeInstanceId: lease.runtimeInstanceId, observed: lease.observed }; }
  async collectRawDiagnostics(leaseId: string): Promise<string> {
    const owned = this.leases.get(leaseId);
    if (!owned) throw new Error("sandbox not found");
    const { root } = owned;
    const name = owned.runtime.runtimeInstanceId;
    const run = async (args: string[]) => {
      try { return await this.docker(args); } catch (error) { return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
    };
    const [inspect, logs, workerLog] = await Promise.all([
      run(["inspect", name]),
      run(["logs", "--timestamps", name]),
      run(["exec", name, "cmd.exe", "/c", "type", "C:\\ProgramData\\Mars\\logs\\worker.log"]),
    ]);
    const runnerDiag = await copyRunnerDiagnostics(root, name, run);
    const bundle = [
      "=== docker inspect ===\n", inspect.stdout || inspect.stderr,
      "\n=== docker logs --timestamps ===\n", logs.stdout || logs.stderr,
      "\n=== service worker.log ===\n", workerLog.stdout || workerLog.stderr,
      "\n", runnerDiag,
    ].join("");
    return bundle.length > DIAGNOSTIC_LIMIT_BYTES ? `${bundle.slice(0, DIAGNOSTIC_LIMIT_BYTES)}\n=== diagnostic bundle truncated ===\n` : bundle;
  }
}
