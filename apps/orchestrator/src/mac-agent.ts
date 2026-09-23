import { generateKeyPairSync, randomUUID, sign as signMessage } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { statfsSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { WorkerBootstrapRequest, WorkerCacheConfiguration, WorkerCommand, WorkerConfigurePayload, WorkerContractVersion, WorkerObservedConfiguration, WorkerRunnerCachePurgePayload, WorkerDoctorData, WorkerEvent, type LeaseBootstrapEnvelope, type WorkerCapacityData } from "@mars/contracts";
import { z } from "zod";
import type { Lease, RuntimeLease } from "./runtime.ts";
import { createTartVmRuntime, resolveTartExecutable, TartVmDriver } from "./tart.ts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { retryControlPlaneOperation, waitForWorkerSocketClose, workerRuntimeVersions, WorkerEventTransport } from "./worker-client.ts";
import { emitActionCacheSnapshot, startActionCacheService, type ActionCacheService } from "./action-cache/service.ts";
import { collectWorkerServiceLogs } from "./worker-service-logs.ts";
import { openLeasePickupState, leasePickupStateFile, writeLeasePickupState, type LeasePickupStateController } from "./lease-pickup-state.ts";
import { MacStatusItemSupervisor, statusItemExecutable } from "./mac-status-item.ts";
export interface MacWorkerLimits { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number }
export interface MacWorkerJoinInput {
  code: string;
  computerName: string;
  releaseVersion: string;
  contractVersion: string;
  publicKey: string;
  encryptionPublicKey: string;
  vmUuid: string;
  machineUuid: string;
  doctor: z.input<typeof WorkerDoctorData>;
  capacity: WorkerCapacityData;
}
export type MacWorkerJoinPayload = MacWorkerJoinInput & { platform: "macos-arm64" };
export function workerEvent(workerId: string, type: string, payload: Record<string, unknown>): WorkerEvent {
  return WorkerEvent.parse({ version: 1, id: randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });
}
export async function applyWorkerConfigure(
  command: WorkerCommand,
  limits: MacWorkerLimits,
  cache: WorkerCacheConfiguration,
  cacheService: Pick<ActionCacheService, "applyTtl" | "setRunnerCacheEnabled" | "setRunnerCacheMaxGiB">,
): Promise<WorkerEvent> {
  const payload = WorkerConfigurePayload.parse(command.payload);
  const observed = WorkerObservedConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms, cache: payload.cache });
  await cacheService.applyTtl(observed.cache.ttlSeconds);
  cacheService.setRunnerCacheEnabled(observed.cache.runnerCacheEnabled);
  cacheService.setRunnerCacheMaxGiB(observed.cache.runnerCacheMaxGiB);
  Object.assign(limits, payload.runtime);
  Object.assign(cache, observed.cache);
  return workerEvent(command.workerId, "worker.configured", { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed });
}
export function buildMacWorkerJoinPayload(input: MacWorkerJoinInput): MacWorkerJoinPayload { return { code: input.code, computerName: input.computerName, releaseVersion: input.releaseVersion, contractVersion: input.contractVersion, publicKey: input.publicKey, encryptionPublicKey: input.encryptionPublicKey, vmUuid: input.vmUuid, machineUuid: input.machineUuid, doctor: input.doctor, capacity: input.capacity, platform: "macos-arm64" }; }
export function buildMacWorkerAuthentication(challenge: string, workerId: string, privateKey: string, encryptionPublicKey?: string): { type: "authenticate"; workerId: string; encryptionPublicKey?: string; signature: string } {
  const canonical = encryptionPublicKey ? `${challenge}\n${workerId}\n${encryptionPublicKey}` : challenge;
  const signature = signMessage(null, encryptionPublicKey ? Buffer.from(canonical) : Buffer.from(challenge, "base64url"), privateKey).toString("base64url");
  return { type: "authenticate", workerId, ...(encryptionPublicKey ? { encryptionPublicKey } : {}), signature };
}
export function buildMacWorkerSocketUrl(base: string, workerId: string): string { const url = new URL(base); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/api/v1/workers/connect"; url.search = new URLSearchParams({ workerId }).toString(); return url.toString(); }
async function emitRuntimeLogs(workerId: string, jobId: string, logs: AsyncIterable<string> | undefined, send: (event: WorkerEvent) => void): Promise<void> {
  if (!logs) return;
  let sequence = 0;
  for await (const output of logs) {
    for (let offset = 0; offset < output.length; offset += 256 * 1024) {
      const content = output.slice(offset, offset + 256 * 1024);
      if (!content) continue;
      send(workerEvent(workerId, "job.log", { jobId, stepId: null, sequence, content, occurredAt: new Date().toISOString() }));
      sequence += 1;
    }
  }
}

export async function runMacLeaseLifecycle(
  command: WorkerCommand,
  driver: TartVmDriver,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
  preserveLeases = false,
  inventoryChanged?: () => void,
): Promise<void> {
  const notifyInventory = () => {
    try { inventoryChanged?.(); } catch (error) {
      console.error("macOS worker inventory notification failed", { workerId: command.workerId, leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  let runtime: RuntimeLease;
  try {
    runtime = await driver.createLease({ id: bootstrap.leaseId, jobId: bootstrap.jobId, contractVersion: bootstrap.contractVersion, guestPlatform: bootstrap.guestPlatform, imageDigest: bootstrap.imageDigest, resources: bootstrap.resources, nonce: bootstrap.nonce, encodedJitConfig: bootstrap.encodedJitConfig });
  } catch (error) {
    console.error("macOS lease provisioning failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    send(workerEvent(command.workerId, "lease.failed", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, reason: "provisioning_failed" }));
    return;
  }
  send(workerEvent(command.workerId, "sandbox_attested", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed }));
  notifyInventory();
  let sampling = true;
  const sampleRuntime = runtime.sample;
  const sampler = sampleRuntime ? (async () => {
    while (sampling) {
      await Promise.race([Bun.sleep(5_000), runtime.completion?.then(() => undefined, () => undefined)]);
      if (!sampling || !runtime.completion) break;
      try {
        const occurredAt = new Date().toISOString();
        send(workerEvent(command.workerId, "job.resource_sample", { jobId: bootstrap.jobId, leaseId: bootstrap.leaseId, occurredAt, ...await sampleRuntime() }));
      } catch (error) {
        console.error("macOS VM resource sample failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  })() : Promise.resolve();
  const logPump = emitRuntimeLogs(command.workerId, bootstrap.jobId, runtime.logs, send).catch(error => {
    console.error("macOS runner log streaming failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
  });
  try {
    if (!runtime.completion) throw new Error("runner completion unavailable");
    const exitCode = await runtime.completion;
    sampling = false;
    await sampler;
    await logPump;
    send(workerEvent(command.workerId, "runner.finished", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, exitCode }));
  } catch (error) {
    sampling = false;
    await sampler.catch(() => undefined);
    console.error("macOS runner failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    send(workerEvent(command.workerId, "lease.failed", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, reason: "runner_failed" }));
  }
  let cleanupFailed = false;
  if (preserveLeases) {
    send(workerEvent(command.workerId, "lease.failed", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, reason: "debug_preserve" }));
    return;
  }
  try { await driver.stopLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("macOS lease stop failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) }); }
  try { await driver.removeLease(bootstrap.leaseId); } catch (error) { cleanupFailed = true; console.error("macOS lease removal failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) }); }
  send(workerEvent(command.workerId, cleanupFailed ? "lease.failed" : "lease.reaped", cleanupFailed
    ? { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, reason: "cleanup_failed" }
    : { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce }));
}

export function startMacLeaseLifecycle(
  command: WorkerCommand,
  driver: TartVmDriver,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
  active: Map<string, Promise<void>>,
  preserveLeases: () => boolean = () => false,
  inventoryChanged?: () => void,
): Promise<void> {
  const existing = active.get(bootstrap.leaseId);
  if (existing) return existing;
  const lifecycle = runMacLeaseLifecycle(command, driver, bootstrap, send, preserveLeases(), inventoryChanged).finally(() => {
    if (active.get(bootstrap.leaseId) === lifecycle) active.delete(bootstrap.leaseId);
    try { inventoryChanged?.(); } catch (error) {
      console.error("macOS worker inventory notification failed", { workerId: command.workerId, leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    }
  });
  active.set(bootstrap.leaseId, lifecycle);
  return lifecycle;
}

export async function handleMacWorkerCommand(command: WorkerCommand, driver: TartVmDriver, limits?: MacWorkerLimits, encryptionPrivateKey?: string, cache?: WorkerCacheConfiguration, cacheService?: Pick<ActionCacheService, "applyTtl" | "setRunnerCacheEnabled" | "setRunnerCacheMaxGiB"> & Partial<Pick<ActionCacheService, "purgeRunnerCache">>, inventoryChanged?: () => void): Promise<WorkerEvent> {
  if (command.type === "worker.runner_cache_purge") {
    const payload = WorkerRunnerCachePurgePayload.parse(command.payload);
    if (payload.workerId !== command.workerId || command.leaseId !== null || !cacheService?.purgeRunnerCache) throw new Error("runner cache purge command invalid");
    await cacheService.purgeRunnerCache();
    return workerEvent(command.workerId, "command.accepted", { commandId: command.id, leaseId: null });
  }
  if (command.type === "worker.configure") {
    if (!limits) throw new Error("worker limits unavailable");
    if (!cache) throw new Error("worker cache configuration unavailable");
    if (!cacheService) throw new Error("worker cache service unavailable");
    return applyWorkerConfigure(command, limits, cache, cacheService);
  }
  if (command.type === "tart.create_lease") {
    if (!command.leaseId || !encryptionPrivateKey) throw new Error("lease encryption key required");
    const payload = command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] };
    if (!payload.bootstrapCiphertext) throw new Error("lease bootstrap payload invalid");
    const bootstrap = openLeaseBootstrap(payload.bootstrapCiphertext, encryptionPrivateKey);
    if (bootstrap.leaseId !== command.leaseId) throw new Error("lease bootstrap mismatch");
    const runtime = await driver.createLease({ id: bootstrap.leaseId, jobId: bootstrap.jobId, contractVersion: bootstrap.contractVersion, guestPlatform: bootstrap.guestPlatform, imageDigest: bootstrap.imageDigest, resources: bootstrap.resources, nonce: bootstrap.nonce, encodedJitConfig: bootstrap.encodedJitConfig });
    return workerEvent(command.workerId, "sandbox_attested", { commandId: command.id, leaseId: command.leaseId, nonce: bootstrap.nonce, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed });
  }
  if (command.type === "tart.stop_lease" && command.leaseId) {
    await driver.stopLease(command.leaseId).catch(() => undefined);
    await driver.removeLease(command.leaseId);
    try { inventoryChanged?.(); } catch (error) {
      console.error("macOS worker inventory notification failed", { workerId: command.workerId, leaseId: command.leaseId, error: error instanceof Error ? error.message : String(error) });
    }
    return workerEvent(command.workerId, "lease.reaped", { commandId: command.id, leaseId: command.leaseId, nonce: String((command.payload as Record<string, unknown>).nonce ?? "") });
  }
  throw new Error("unsupported worker command");
}
export interface MacWorkerCommandDependencies {
  driver: TartVmDriver;
  limits: MacWorkerLimits;
  encryptionPrivateKey: string;
  cache: WorkerCacheConfiguration;
  cacheService: ActionCacheService;
  activeLeases: Map<string, Promise<void>>;
  preserveLeases: () => boolean;
  acceptingLeases?: () => boolean;
  saveIdentity: () => Promise<void>;
  setPreserveLeases: (enabled: boolean) => void;
  send: (event: WorkerEvent) => void;
  sendDoctor: () => void;
}
export async function executeMacWorkerCommand(command: WorkerCommand, dependencies: MacWorkerCommandDependencies): Promise<void> {
  const { driver, limits, encryptionPrivateKey, cache, cacheService, activeLeases, preserveLeases, acceptingLeases = () => true, sendDoctor, saveIdentity, setPreserveLeases, send } = dependencies;
  if (command.type === "worker.collect_logs") {
    send(await collectWorkerServiceLogs(command));
    return;
  }
  if (command.type === "worker.set_lease_preservation") {
    const enabled = (command.payload as Record<string, unknown>).enabled;
    setPreserveLeases(enabled === true);
    await saveIdentity();
    send(workerEvent(command.workerId, "command.accepted", { commandId: command.id, leaseId: null }));
    return;
  }
  if (command.type === "tart.stop_lease" && preserveLeases() && command.leaseId) {
    const nonce = String((command.payload as Record<string, unknown>).nonce ?? "");
    send(workerEvent(command.workerId, "lease.failed", { commandId: command.id, leaseId: command.leaseId, nonce, reason: "debug_preserve" }));
    sendDoctor();
    return;
  }
  if (command.type === "tart.create_lease") {
    if (!command.leaseId) throw new Error("lease id required");
    const payload = command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] };
    if (!payload.bootstrapCiphertext) throw new Error("lease bootstrap payload invalid");
    const bootstrap = openLeaseBootstrap(payload.bootstrapCiphertext, encryptionPrivateKey);
    if (!acceptingLeases()) {
      send(workerEvent(command.workerId, "lease.declined", { commandId: command.id, leaseId: command.leaseId, nonce: bootstrap.nonce, reason: "pickup_paused" }));
      return;
    }
    send(workerEvent(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId }));
    void startMacLeaseLifecycle(command, driver, bootstrap, send, activeLeases, preserveLeases, sendDoctor);
    return;
  }
  const result = await handleMacWorkerCommand(command, driver, limits, encryptionPrivateKey, cache, cacheService);
  send(result);
  if (command.type === "tart.stop_lease") sendDoctor();
}
function createKeyPair(): { privateKey: string; publicKey: string; encryptionPrivateKey: string; encryptionPublicKey: string } {
 const signing = generateKeyPairSync("ed25519");
 const encryption = generateKeyPairSync("x25519");
 return {
  privateKey: signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  publicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
  encryptionPrivateKey: encryption.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString(),
 };
}
async function readJoinCode(): Promise<Buffer> {
  const path = Bun.env.MARS_JOIN_CODE_FILE;
  const codeBytes = path
    ? Buffer.from((await readFile(path, "utf8")).trim(), "utf8")
    : await (async () => {
      const reader = Bun.stdin.stream().getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      return Buffer.from(value ?? []);
    })();
  if (!codeBytes.toString("utf8").trim()) throw new Error(path ? "join code required in file" : "join code required on stdin");
  return codeBytes;
}
export function availableMacMemoryBytes(output: string, totalMemoryBytes: number): number {
  const percentage = output.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/)?.[1];
  if (percentage === undefined) throw new Error("macOS memory availability is unavailable");
  const value = Number(percentage);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("macOS memory availability is invalid");
  return Math.floor(totalMemoryBytes * value / 100);
}

function currentMacMemoryBytes(): number {
  const result = Bun.spawnSync(["memory_pressure", "-Q"]);
  if (result.exitCode !== 0) throw new Error("macOS memory availability is unavailable");
  return availableMacMemoryBytes(new TextDecoder().decode(result.stdout), totalmem());
}

function capacity(): WorkerCapacityData {
  const disk = statfsSync("/", { bigint: true });
  const actualVcpu = cpus().length;
  return {
    actualVcpu,
    actualMemoryBytes: totalmem(),
    actualStorageBytes: Number(disk.blocks * disk.bsize),
    freeVcpu: actualVcpu,
    freeMemoryBytes: currentMacMemoryBytes(),
    freeStorageBytes: Number(disk.bavail * disk.bsize),
  };
}
export function capacityForMacDoctor(readCapacity: () => WorkerCapacityData = capacity): WorkerCapacityData {
  try {
    return readCapacity();
  } catch (error) {
    console.error("macOS capacity metrics unavailable; publishing doctor with zero available capacity", { error: error instanceof Error ? error.message : String(error) });
    return { actualVcpu: 0, actualMemoryBytes: 0, actualStorageBytes: 0, freeVcpu: 0, freeMemoryBytes: 0, freeStorageBytes: 0 };
  }
}

async function macMachineUuid(): Promise<string> {
  if (Bun.env.MARS_MACHINE_UUID) return Bun.env.MARS_MACHINE_UUID.toLowerCase();
  const process = Bun.spawn(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  if (await process.exited !== 0) throw new Error(`could not read macOS machine UUID: ${await new Response(process.stderr).text()}`);
  const uuid = output.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}/)?.[0];
  if (!uuid) throw new Error("macOS machine UUID is unavailable");
  return uuid.toLowerCase();
}
async function runMacCommand(command: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string }> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const stdout = new Response(process.stdout).text();
  const timeout = setTimeout(() => process.kill(), timeoutMs);
  try {
    return { code: await process.exited, stdout: await stdout };
  } finally {
    clearTimeout(timeout);
  }
}
export async function currentMacDoctor(): Promise<WorkerDoctorData> {
  const tartExecutable = resolveTartExecutable(Bun.env.MARS_TART_EXECUTABLE);
  const tart = await runMacCommand([tartExecutable, "--version"]).catch(() => ({ code: -1, stdout: "" }));
  const probe = tart.code === 0;
  const macosBaseImage = Bun.env.MARS_TART_MACOS_BASE_IMAGE ?? Bun.env.MARS_TART_BASE_IMAGE ?? "mars-macos-worker";
  const linuxBaseImage = Bun.env.MARS_TART_LINUX_ARM64_BASE_IMAGE ?? "ghcr.io/cirruslabs/ubuntu:latest";
  const tartList = await runMacCommand([tartExecutable, "list", "--format", "json"]).catch(() => ({ code: -1, stdout: "" }));
  let localImages = false;
  try {
    const entries = JSON.parse(tartList.stdout) as Array<{ Name?: unknown }>;
    const names = new Set(entries.map(entry => entry.Name).filter((name): name is string => typeof name === "string"));
    localImages = tartList.code === 0 && names.has(macosBaseImage) && names.has(linuxBaseImage);
  } catch {}
  const macosDigest = Bun.env.MARS_TART_MACOS_IMAGE_DIGEST?.trim();
  const linuxDigest = Bun.env.MARS_TART_LINUX_ARM64_IMAGE_DIGEST?.trim();
  const digestPattern = /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/i;
  const artifactDigests = { "macos-arm64": macosDigest ?? "", "linux-arm64": linuxDigest ?? "" };
  const immutableImages = digestPattern.test(artifactDigests["macos-arm64"]) && digestPattern.test(artifactDigests["linux-arm64"]);
  const contractVersion = Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim();
  const failures = [!probe && "Tart runtime probe failed", !localImages && "Prepared Tart base images are unavailable", !immutableImages && "Both immutable Tart image digests are required", !WorkerContractVersion.safeParse(contractVersion).success && "Worker contract version is missing or invalid"].filter(Boolean);
  return WorkerDoctorData.parse({ runtimeMode: "tart", artifactSource: "registry", ...(immutableImages ? { artifactDigests, artifactDigest: artifactDigests["macos-arm64"], artifactIdentity: artifactDigests["macos-arm64"] } : {}), runtimeReady: failures.length === 0, probe, imageSignatures: immutableImages, remediation: failures.length ? failures.join("; ") : null });
}
async function currentMacWorkerJoinPayload(code: string, publicKey: string, encryptionPublicKey: string, vmUuid?: string, machineUuid?: string): Promise<MacWorkerJoinPayload> {
  const stableMachineUuid = machineUuid ?? await macMachineUuid();
  const resources = capacity();
  return WorkerBootstrapRequest.parse(buildMacWorkerJoinPayload({
    code,
    computerName: hostname(),
    ...workerRuntimeVersions(),
    publicKey,
    encryptionPublicKey,
    machineUuid: stableMachineUuid,
    vmUuid: (vmUuid ?? Bun.env.MARS_VM_UUID ?? stableMachineUuid).toLowerCase(),
    doctor: { ...await currentMacDoctor(), ...resources },
    capacity: resources,
  })) as MacWorkerJoinPayload;
}
function validateControlPlaneUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  const allowInsecureHttp = Bun.env.MARS_ALLOW_INSECURE_HTTP === "true";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:") && !allowInsecureHttp) throw new Error("control plane must use HTTPS (TLS 1.3) except explicit localhost development");
  return url;
}
type MacWorkerIdentity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string; vmUuid?: string; machineUuid?: string; preserveLeases?: boolean };

function identityFilePath(): string {
  return Bun.env.MARS_WORKER_IDENTITY_FILE ?? `${Bun.env.HOME ?? "."}/Library/Application Support/Mars/worker-identity.json`;
}
export function parseMacWorkerIdentity(value: unknown): MacWorkerIdentity {
  if (!value || typeof value !== "object") throw new Error("worker identity is invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.workerId !== "string" || typeof record.publicKey !== "string" || typeof record.privateKey !== "string" || typeof record.encryptionPublicKey !== "string" || typeof record.encryptionPrivateKey !== "string") throw new Error("worker identity is invalid");
  return {
    workerId: record.workerId,
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    encryptionPublicKey: record.encryptionPublicKey,
    encryptionPrivateKey: record.encryptionPrivateKey,
    ...(typeof record.vmUuid === "string" ? { vmUuid: record.vmUuid } : {}),
    ...(typeof record.machineUuid === "string" ? { machineUuid: record.machineUuid } : {}),
    preserveLeases: record.preserveLeases === true,
  };
}

async function loadMacWorkerIdentity(): Promise<MacWorkerIdentity | null> {
  const path = identityFilePath();
  try { return parseMacWorkerIdentity(JSON.parse(await readFile(path, "utf8"))); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveMacWorkerIdentity(identity: MacWorkerIdentity): Promise<void> {
  const path = identityFilePath();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function enrollMacWorker(controlPlane: URL, identity: MacWorkerIdentity): Promise<MacWorkerIdentity> {
  const machineUuid = (identity.machineUuid ?? await macMachineUuid()).toLowerCase();
  const vmUuid = (identity.vmUuid ?? Bun.env.MARS_VM_UUID ?? machineUuid).toLowerCase();
  const persisted = { ...identity, vmUuid, machineUuid };
  await saveMacWorkerIdentity(persisted);
  const codeBytes = await readJoinCode();
  try {
    const payload = await currentMacWorkerJoinPayload(codeBytes.toString("utf8").trim(), persisted.publicKey, persisted.encryptionPublicKey, vmUuid, machineUuid);
    const response = await retryControlPlaneOperation("worker enrollment", () => fetch(new URL("/api/workers/join", controlPlane), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) }));
    if (!response.ok) throw new Error(`worker join failed: ${response.status} ${await response.text()}`);
    const joined = await response.json() as { workerId?: string };
    if (typeof joined.workerId !== "string" || !joined.workerId) throw new Error("worker join response missing workerId");
    const enrolled = { ...persisted, workerId: joined.workerId };
    await saveMacWorkerIdentity(enrolled);
    return enrolled;
  } finally { codeBytes.fill(0); }
}

async function connectMacWorker(controlPlane: URL, identity: MacWorkerIdentity, driver: TartVmDriver, limits: MacWorkerLimits, cache: WorkerCacheConfiguration, cacheService: ActionCacheService, pickupState: LeasePickupStateController): Promise<never> {
  const activeLeases = new Map<string, Promise<void>>();
  const eventTransport = new WorkerEventTransport(() => cacheService.runnerCacheStatus().enabled);
  for (;;) {
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildMacWorkerSocketUrl(controlPlane.toString(), identity.workerId));
    } catch (error) {
      console.error("Mac worker connection attempt failed", { workerId: identity.workerId, error: error instanceof Error ? error.message : String(error) });
      await Bun.sleep(1_000);
      continue;
    }
    const closed = waitForWorkerSocketClose(ws);
    ws.onclose = event => {
      console.error("Mac worker connection closed; reconnecting", { workerId: identity.workerId, code: event.code, reason: event.reason });
    };
    const publishInventory = () => { void writeLeasePickupState(leasePickupStateFile(), pickupState.acceptingLeases, activeLeases.size); };
    const sendDoctor = () => {
      publishInventory();
      void currentMacDoctor().then(doctorReport => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ version: 1, type: "doctor", workerId: identity.workerId, payload: { ...workerRuntimeVersions(), doctor: { ...doctorReport, inventoryObservedAt: new Date().toISOString(), acceptingLeases: pickupState.acceptingLeases, preserveLeases: identity.preserveLeases === true, activeLeases: [...activeLeases.keys()] }, capacity: capacityForMacDoctor() } }));
      }).catch(error => {
        console.error("Mac worker doctor collection failed", { workerId: identity.workerId, error: error instanceof Error ? error.message : String(error) });
      });
    };
    ws.onmessage = async event => {
      let frame: { type?: string; nonce?: string } & Partial<WorkerCommand>;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        ws.close(1011, "worker command failed");
        return;
      }
      try {
        if (frame.type === "challenge" && typeof frame.nonce === "string") {
          ws.send(JSON.stringify(buildMacWorkerAuthentication(frame.nonce, identity.workerId, identity.privateKey, identity.encryptionPublicKey)));
          return;
        }
        if (frame.type === "authenticated") {
          eventTransport.bind(ws);
          console.log("Mac worker authenticated", { workerId: identity.workerId });
          if (Bun.env.MARS_JOIN_CODE_FILE) await unlink(Bun.env.MARS_JOIN_CODE_FILE).catch(() => {});
          await emitActionCacheSnapshot(cacheService, (type, payload) => {
            eventTransport.send(workerEvent(identity.workerId, type, payload));
          });
          sendDoctor();
          return;
        }
        if (frame.type === "ping") {
          ws.send(JSON.stringify({ version: 1, type: "pong", workerId: identity.workerId }));
          sendDoctor();
          return;
        }
        if (frame.type === "doctor_ack") return;
        if (frame.type === "event_ack" && typeof (frame as Record<string, unknown>).eventId === "string") {
          eventTransport.acknowledge((frame as Record<string, unknown>).eventId as string);
          return;
        }
      } catch {
        ws.close(1011, "worker command failed");
        return;
      }
      let command: WorkerCommand;
      try {
        command = WorkerCommand.parse(frame);
      } catch {
        ws.close(1011, "worker command failed");
        return;
      }
      try {
        const cacheWasEnabled = cacheService.runnerCacheStatus().enabled;
        await executeMacWorkerCommand(command, {
          driver,
          limits,
          encryptionPrivateKey: identity.encryptionPrivateKey,
          cache,
          cacheService,
          activeLeases,
          preserveLeases: () => identity.preserveLeases === true,
          setPreserveLeases: enabled => { identity.preserveLeases = enabled; },
          acceptingLeases: () => pickupState.acceptingLeases,
          saveIdentity: () => saveMacWorkerIdentity(identity),
          send: eventToSend => eventTransport.send(eventToSend),
          sendDoctor,
        });
        if (command.type === "worker.configure" && !cacheWasEnabled && cacheService.runnerCacheStatus().enabled) {
          await emitActionCacheSnapshot(cacheService, (type, payload) => {
            eventTransport.send(workerEvent(identity.workerId, type, payload));
          });
        }
      } catch (error) {
        console.error("Mac worker command failed", {
          workerId: command.workerId,
          commandId: command.id,
          type: command.type,
          leaseId: command.leaseId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    await closed;
    eventTransport.unbind(ws);
    await Bun.sleep(1_000);
  }
}
export async function runWorkerJoin(platform: "macos-arm64" | "windows-x64", baseUrl: string): Promise<void> {
  if (platform !== "macos-arm64") throw new Error("Windows worker enrollment is not implemented");
  const controlPlane = validateControlPlaneUrl(baseUrl);
  let identity = await loadMacWorkerIdentity();
  if (!identity) {
    const machineUuid = (Bun.env.MARS_MACHINE_UUID ?? await macMachineUuid()).toLowerCase();
    identity = { workerId: "", ...createKeyPair(), machineUuid, vmUuid: (Bun.env.MARS_VM_UUID ?? machineUuid).toLowerCase() };
    await saveMacWorkerIdentity(identity);
  }
  if (!identity.workerId) await enrollMacWorker(controlPlane, identity);
}
export async function runMacWorker(baseUrl: string, limits: MacWorkerLimits, cache = WorkerCacheConfiguration.parse({})): Promise<never> {
  const controlPlane = validateControlPlaneUrl(baseUrl);
  const cacheService = await startActionCacheService({ controlPlaneOrigin: controlPlane.origin, ttlSeconds: cache.ttlSeconds, runnerCacheEnabled: cache.runnerCacheEnabled, runnerCacheMaxGiB: cache.runnerCacheMaxGiB });
  const pickupState = await openLeasePickupState(leasePickupStateFile());
  const statusItem = new MacStatusItemSupervisor(statusItemExecutable(), leasePickupStateFile());
  void statusItem.run();
  try {
    const macosBaseImage = Bun.env.MARS_TART_MACOS_BASE_IMAGE ?? Bun.env.MARS_TART_BASE_IMAGE ?? "mars-macos-worker";
    const linuxBaseImage = Bun.env.MARS_TART_LINUX_ARM64_BASE_IMAGE ?? "ghcr.io/cirruslabs/ubuntu:latest";
    const macosImageDigest = Bun.env.MARS_TART_MACOS_IMAGE_DIGEST ?? Bun.env.MARS_TART_IMAGE_DIGEST ?? "";
    const linuxImageDigest = Bun.env.MARS_TART_LINUX_ARM64_IMAGE_DIGEST ?? "";
    const driver = new TartVmDriver(createTartVmRuntime(), { "macos-arm64": { baseImage: macosBaseImage, imageDigest: macosImageDigest }, "linux-arm64": { baseImage: linuxBaseImage, imageDigest: linuxImageDigest } }, "mars-job", limits, Bun.env.MARS_WORKER_CONTRACT_VERSION ?? "");
    let identity = await loadMacWorkerIdentity();
    if (!identity) {
      const machineUuid = (Bun.env.MARS_MACHINE_UUID ?? await macMachineUuid()).toLowerCase();
      identity = { workerId: "", ...createKeyPair(), machineUuid, vmUuid: (Bun.env.MARS_VM_UUID ?? machineUuid).toLowerCase() };
      await saveMacWorkerIdentity(identity);
    }
    if (!identity.workerId) identity = await enrollMacWorker(controlPlane, identity);
    return await connectMacWorker(controlPlane, identity, driver, limits, cache, cacheService, pickupState);
  } finally {
    await statusItem.close();
    await pickupState.close();
    await cacheService.close();
  }
}
if (import.meta.main && Bun.argv[2] === "mac-worker") { const baseUrl = Bun.env.MARS_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required"); await runMacWorker(baseUrl, { maxVcpuPerPod: Number(Bun.env.MAX_VCPU_PER_POD ?? 2), maxMemoryBytesPerPod: Number(Bun.env.MAX_MEMORY_BYTES_PER_POD ?? 4 * 1024 ** 3), maxStorageBytesPerPod: Number(Bun.env.MAX_STORAGE_BYTES_PER_POD ?? 20 * 1024 ** 3), maxConcurrentPods: Number(Bun.env.MAX_CONCURRENT_PODS ?? 1) }); }
if (import.meta.main && Bun.argv[2] === "join") { const platform = Bun.argv[3]; if (platform !== "macos-arm64" && platform !== "windows-x64") throw new Error("unsupported join platform"); const baseUrl = Bun.env.MARS_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required"); await runWorkerJoin(platform, baseUrl); }
