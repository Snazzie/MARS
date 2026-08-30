import { generateKeyPairSync, randomUUID, sign as signMessage } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { statfsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { WorkerBootstrapRequest, WorkerCacheConfiguration, WorkerCommand, WorkerConfigurePayload, WorkerObservedConfiguration, WorkerDoctorData, WorkerEvent, type LeaseBootstrapEnvelope, type WorkerCacheProxy, type WorkerCapacityData } from "@mars/contracts";
import type { Lease, RuntimeLease } from "./runtime.ts";
import { createTartVmRuntime, TartVmDriver } from "./tart.ts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { retryControlPlaneOperation } from "./worker-client.ts";
import { emitActionCacheSnapshot, startActionCacheService, type ActionCacheService } from "./action-cache/service.ts";

export interface MacWorkerLimits { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number }
export interface MacWorkerJoinInput {
  code: string;
  publicKey: string;
  encryptionPublicKey: string;
  vmUuid: string;
  machineUuid: string;
  doctor: WorkerDoctorData;
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
  cacheService: Pick<ActionCacheService, "applyTtl">,
): Promise<WorkerEvent> {
  const payload = WorkerConfigurePayload.parse(command.payload);
  const observed = WorkerObservedConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms, cache: payload.cache });
  await cacheService.applyTtl(observed.cache.ttlSeconds);
  Object.assign(limits, payload.runtime);
  Object.assign(cache, observed.cache);
  return workerEvent(command.workerId, "worker.configured", { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed });
}
export function buildMacWorkerJoinPayload(input: MacWorkerJoinInput): MacWorkerJoinPayload { return { code: input.code, publicKey: input.publicKey, encryptionPublicKey: input.encryptionPublicKey, vmUuid: input.vmUuid, machineUuid: input.machineUuid, doctor: input.doctor, capacity: input.capacity, platform: "macos-arm64" }; }
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

async function runMacLeaseLifecycleWithTransport(
  command: WorkerCommand,
  driver: TartVmDriver,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
  preserveLeases = false,
  workerCache?: WorkerCacheProxy,
): Promise<void> {
  let runtime: RuntimeLease;
  try {
    runtime = await driver.createLease({ id: bootstrap.leaseId, jobId: bootstrap.jobId, imageDigest: bootstrap.imageDigest, resources: bootstrap.resources, nonce: bootstrap.nonce, encodedJitConfig: bootstrap.encodedJitConfig, ...(workerCache ? { workerCache } : {}) });
  } catch (error) {
    console.error("macOS lease provisioning failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    send(workerEvent(command.workerId, "lease.failed", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, reason: "provisioning_failed" }));
    return;
  }
  send(workerEvent(command.workerId, "sandbox_attested", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed }));
  const logPump = emitRuntimeLogs(command.workerId, bootstrap.jobId, runtime.logs, send).catch(error => {
    console.error("macOS runner log streaming failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
  });
  try {
    if (!runtime.completion) throw new Error("runner completion unavailable");
    const exitCode = await runtime.completion;
    await logPump;
    send(workerEvent(command.workerId, "runner.finished", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, exitCode }));
  } catch (error) {
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

export async function runMacLeaseLifecycle(
  command: WorkerCommand,
  driver: TartVmDriver,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
  preserveLeases = false,
  cacheService?: Pick<ActionCacheService, "transport" | "unregisterLease">,
): Promise<void> {
  let workerCache: WorkerCacheProxy | undefined;
  try {
    if (cacheService) workerCache = cacheService.transport(bootstrap.leaseId, bootstrap.expiresAt);
  } catch (error) {
    console.error("macOS lease cache transport setup failed", { leaseId: bootstrap.leaseId, error: error instanceof Error ? error.message : String(error) });
    send(workerEvent(command.workerId, "lease.failed", { commandId: command.id, leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, reason: "provisioning_failed" }));
    return;
  }
  try {
    await runMacLeaseLifecycleWithTransport(command, driver, bootstrap, send, preserveLeases, workerCache);
  } finally {
    cacheService?.unregisterLease(bootstrap.leaseId);
  }
}
export function startMacLeaseLifecycle(
  command: WorkerCommand,
  driver: TartVmDriver,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
  active: Map<string, Promise<void>>,
  preserveLeases: () => boolean = () => false,
  cacheService?: Pick<ActionCacheService, "transport" | "unregisterLease">,
): Promise<void> {
  const existing = active.get(bootstrap.leaseId);
  if (existing) return existing;
  const lifecycle = runMacLeaseLifecycle(command, driver, bootstrap, send, preserveLeases(), cacheService).finally(() => {
    if (active.get(bootstrap.leaseId) === lifecycle) active.delete(bootstrap.leaseId);
  });
  active.set(bootstrap.leaseId, lifecycle);
  return lifecycle;
}
export async function handleMacWorkerCommand(command: WorkerCommand, driver: TartVmDriver, limits?: MacWorkerLimits, encryptionPrivateKey?: string, cache?: WorkerCacheConfiguration, cacheService?: Pick<ActionCacheService, "applyTtl">): Promise<WorkerEvent> {
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
    const runtime = await driver.createLease({ id: bootstrap.leaseId, jobId: bootstrap.jobId, imageDigest: bootstrap.imageDigest, resources: bootstrap.resources, nonce: bootstrap.nonce, encodedJitConfig: bootstrap.encodedJitConfig });
    return workerEvent(command.workerId, "sandbox_attested", { commandId: command.id, leaseId: command.leaseId, nonce: bootstrap.nonce, runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed });
  }
  if (command.type === "tart.stop_lease" && command.leaseId) {
    await driver.stopLease(command.leaseId).catch(() => undefined);
    await driver.removeLease(command.leaseId);
    return workerEvent(command.workerId, "lease.reaped", { commandId: command.id, leaseId: command.leaseId, nonce: String((command.payload as Record<string, unknown>).nonce ?? "") });
  }
  throw new Error("unsupported worker command");
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
async function macMachineUuid(): Promise<string> {
  if (Bun.env.MARS_MACHINE_UUID) return Bun.env.MARS_MACHINE_UUID.toLowerCase();
  const process = Bun.spawn(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text();
  if (await process.exited !== 0) throw new Error(`could not read macOS machine UUID: ${await new Response(process.stderr).text()}`);
  const uuid = output.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}/)?.[0];
  if (!uuid) throw new Error("macOS machine UUID is unavailable");
  return uuid.toLowerCase();
}
async function currentMacDoctor(): Promise<WorkerDoctorData> {
  const tart = Bun.spawnSync(["tart", "--version"]);
  const probe = tart.exitCode === 0;
  let egress = false;
  try {
    const response = await fetch("https://api.github.com/meta", { signal: AbortSignal.timeout(5_000), headers: { "user-agent": "mars-worker-doctor" } });
    egress = response.ok;
  } catch {
    egress = false;
  }
  const artifactDigest = Bun.env.MARS_TART_IMAGE_DIGEST ?? Bun.env.MARS_TART_BASE_IMAGE;
  const immutableArtifact = typeof artifactDigest === "string" && /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/i.test(artifactDigest);
  const failures = [!probe && "Tart runtime probe failed", !egress && "GitHub egress probe failed", !immutableArtifact && "Immutable Tart image digest is missing"].filter(Boolean);
  return WorkerDoctorData.parse({ runtimeMode: "tart", artifactSource: "registry", ...(immutableArtifact ? { artifactDigest, artifactIdentity: artifactDigest } : {}), runtimeReady: failures.length === 0, probe, egress, imageSignatures: immutableArtifact, remediation: failures.length ? failures.join("; ") : null });
}
async function currentMacWorkerJoinPayload(code: string, publicKey: string, encryptionPublicKey: string, vmUuid?: string, machineUuid?: string): Promise<MacWorkerJoinPayload> {
  const stableMachineUuid = machineUuid ?? await macMachineUuid();
  const resources = capacity();
  return WorkerBootstrapRequest.parse(buildMacWorkerJoinPayload({
    code,
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

async function connectMacWorker(controlPlane: URL, identity: MacWorkerIdentity, driver: TartVmDriver, limits: MacWorkerLimits, cache: WorkerCacheConfiguration, cacheService: ActionCacheService): Promise<never> {
  const doctorReport = await currentMacDoctor();
  const activeLeases = new Map<string, Promise<void>>();
  for (;;) {
    const ws = new WebSocket(buildMacWorkerSocketUrl(controlPlane.toString(), identity.workerId));
    const closed = Promise.withResolvers<void>();
    ws.onclose = () => closed.resolve();
    ws.onerror = () => ws.close();
    ws.onmessage = async event => {
      try {
        const frame = JSON.parse(String(event.data)) as { type?: string; nonce?: string } & Partial<WorkerCommand>;
        if (frame.type === "challenge" && typeof frame.nonce === "string") {
          ws.send(JSON.stringify(buildMacWorkerAuthentication(frame.nonce, identity.workerId, identity.privateKey, identity.encryptionPublicKey)));
          return;
        }
        if (frame.type === "authenticated") {
          if (Bun.env.MARS_JOIN_CODE_FILE) await unlink(Bun.env.MARS_JOIN_CODE_FILE).catch(() => {});
          await emitActionCacheSnapshot(cacheService, (type, payload) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(workerEvent(identity.workerId, type, payload)));
          });
          return ws.send(JSON.stringify({ version: 1, type: "doctor", workerId: identity.workerId, payload: { doctor: { ...doctorReport, preserveLeases: identity.preserveLeases === true, activeLeases: [...activeLeases.keys()] }, capacity: capacity() } }));
        }
        if (frame.type === "ping") { ws.send(JSON.stringify({ version: 1, type: "pong", workerId: identity.workerId })); return ws.send(JSON.stringify({ version: 1, type: "doctor", workerId: identity.workerId, payload: { doctor: { ...doctorReport, preserveLeases: identity.preserveLeases === true, activeLeases: [...activeLeases.keys()] }, capacity: capacity() } })); }
        if (frame.type === "doctor_ack") return;
        const command = WorkerCommand.parse(frame);
        if (command.type === "worker.set_lease_preservation") {
          const enabled = (command.payload as Record<string, unknown>).enabled;
          if (typeof enabled !== "boolean") throw new Error("lease preservation command invalid");
          identity.preserveLeases = enabled;
          await saveMacWorkerIdentity(identity);
          return ws.send(JSON.stringify(workerEvent(command.workerId, "command.accepted", { commandId: command.id, leaseId: null })));
        }
        if (command.type === "tart.stop_lease" && identity.preserveLeases === true && command.leaseId) {
          const nonce = String((command.payload as Record<string, unknown>).nonce ?? "");
          return ws.send(JSON.stringify(workerEvent(command.workerId, "lease.failed", { commandId: command.id, leaseId: command.leaseId, nonce, reason: "debug_preserve" })));
        }
        if (command.type === "tart.create_lease") {
          if (!command.leaseId) throw new Error("lease id required");
          const payload = command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] };
          if (!payload.bootstrapCiphertext) throw new Error("lease bootstrap payload invalid");
          const bootstrap = openLeaseBootstrap(payload.bootstrapCiphertext, identity.encryptionPrivateKey);
          if (bootstrap.leaseId !== command.leaseId) throw new Error("lease bootstrap mismatch");
          ws.send(JSON.stringify(workerEvent(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId })));
          void startMacLeaseLifecycle(command, driver, bootstrap, lifecycleEvent => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(lifecycleEvent));
          }, activeLeases, () => identity.preserveLeases === true, cacheService);
          return;
        }
        ws.send(JSON.stringify(await handleMacWorkerCommand(command, driver, limits, identity.encryptionPrivateKey, cache, cacheService)));
      } catch { ws.close(1011, "worker command failed"); }
    };
    await closed.promise;
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
  const cacheService = await startActionCacheService({ controlPlaneOrigin: controlPlane.origin, ttlSeconds: cache.ttlSeconds });
  try {
    const driver = new TartVmDriver(createTartVmRuntime(), Bun.env.MARS_TART_BASE_IMAGE ?? "mars-macos-worker", "mars-job", limits, Bun.env.MARS_TART_IMAGE_DIGEST ?? Bun.env.MARS_TART_BASE_IMAGE ?? "mars-macos-worker");
    let identity = await loadMacWorkerIdentity();
    if (!identity) {
      const machineUuid = (Bun.env.MARS_MACHINE_UUID ?? await macMachineUuid()).toLowerCase();
      identity = { workerId: "", ...createKeyPair(), machineUuid, vmUuid: (Bun.env.MARS_VM_UUID ?? machineUuid).toLowerCase() };
      await saveMacWorkerIdentity(identity);
    }
    if (!identity.workerId) identity = await enrollMacWorker(controlPlane, identity);
    return await connectMacWorker(controlPlane, identity, driver, limits, cache, cacheService);
  } finally {
    await cacheService.close();
  }
}
if (import.meta.main && Bun.argv[2] === "mac-worker") { const baseUrl = Bun.env.MARS_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required"); await runMacWorker(baseUrl, { maxVcpuPerPod: Number(Bun.env.MAX_VCPU_PER_POD ?? 2), maxMemoryBytesPerPod: Number(Bun.env.MAX_MEMORY_BYTES_PER_POD ?? 4 * 1024 ** 3), maxStorageBytesPerPod: Number(Bun.env.MAX_STORAGE_BYTES_PER_POD ?? 20 * 1024 ** 3), maxConcurrentPods: Number(Bun.env.MAX_CONCURRENT_PODS ?? 1) }); }
if (import.meta.main && Bun.argv[2] === "join") { const platform = Bun.argv[3]; if (platform !== "macos-arm64" && platform !== "windows-x64") throw new Error("unsupported join platform"); const baseUrl = Bun.env.MARS_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required"); await runWorkerJoin(platform, baseUrl); }
