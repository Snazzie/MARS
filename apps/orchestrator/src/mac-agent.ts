import { generateKeyPairSync, randomUUID, sign as signMessage } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { statfsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { WorkerBootstrapRequest, WorkerCommand, WorkerConfigurePayload, WorkerConfiguration, WorkerDoctorData, WorkerEvent, type LeaseBootstrapEnvelope, type WorkerCapacityData } from "@whitesmith/contracts";
import type { Lease } from "./runtime.ts";
import { createTartVmRuntime, TartVmDriver } from "./tart.ts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";

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
export function applyWorkerConfigure(command: WorkerCommand, limits: MacWorkerLimits): WorkerEvent {
  const payload = WorkerConfigurePayload.parse(command.payload);
  const observed = WorkerConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms });
  Object.assign(limits, payload.runtime);
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

export async function runMacLeaseLifecycle(
  command: WorkerCommand,
  driver: TartVmDriver,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
): Promise<void> {
  let runtime: Awaited<ReturnType<TartVmDriver["createLease"]>>;
  try {
    runtime = await driver.createLease({ id: bootstrap.leaseId, jobId: bootstrap.jobId, imageDigest: bootstrap.imageDigest, resources: bootstrap.resources, nonce: bootstrap.nonce, encodedJitConfig: bootstrap.encodedJitConfig });
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
): Promise<void> {
  const existing = active.get(bootstrap.leaseId);
  if (existing) return existing;
  const lifecycle = runMacLeaseLifecycle(command, driver, bootstrap, send).finally(() => {
    if (active.get(bootstrap.leaseId) === lifecycle) active.delete(bootstrap.leaseId);
  });
  active.set(bootstrap.leaseId, lifecycle);
  return lifecycle;
}
export async function handleMacWorkerCommand(command: WorkerCommand, driver: TartVmDriver, limits?: MacWorkerLimits, encryptionPrivateKey?: string): Promise<WorkerEvent> {
  if (command.type === "worker.configure") {
    if (!limits) throw new Error("worker limits unavailable");
    return applyWorkerConfigure(command, limits);
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
async function readJoinCode(): Promise<Buffer> { const reader = Bun.stdin.stream().getReader(); const { value } = await reader.read(); reader.releaseLock(); const code = Buffer.from(value ?? []); if (!code.toString("utf8").trim()) throw new Error("join code required on stdin"); return code; }
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
  if (Bun.env.WHITESMITH_MACHINE_UUID) return Bun.env.WHITESMITH_MACHINE_UUID.toLowerCase();
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
    const response = await fetch("https://api.github.com/meta", { signal: AbortSignal.timeout(5_000), headers: { "user-agent": "whitesmith-worker-doctor" } });
    egress = response.ok;
  } catch {
    egress = false;
  }
  const artifactDigest = Bun.env.WHITESMITH_TART_IMAGE_DIGEST ?? Bun.env.WHITESMITH_TART_BASE_IMAGE;
  const immutableArtifact = typeof artifactDigest === "string" && /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/i.test(artifactDigest);
  const failures = [!probe && "Tart runtime probe failed", !egress && "GitHub egress probe failed", !immutableArtifact && "Immutable Tart image digest is missing"].filter(Boolean);
  return WorkerDoctorData.parse({ runtimeMode: "tart", ...(immutableArtifact ? { artifactDigest } : {}), probe, egress, imageSignatures: immutableArtifact, remediation: failures.length ? failures.join("; ") : null });
}
async function currentMacWorkerJoinPayload(code: string, publicKey: string, encryptionPublicKey: string): Promise<MacWorkerJoinPayload> {
  const machineUuid = await macMachineUuid();
  const resources = capacity();
  return WorkerBootstrapRequest.parse(buildMacWorkerJoinPayload({
    code,
    publicKey,
    encryptionPublicKey,
    machineUuid,
    vmUuid: (Bun.env.WHITESMITH_VM_UUID ?? machineUuid).toLowerCase(),
    doctor: { ...await currentMacDoctor(), ...resources },
    capacity: resources,
  })) as MacWorkerJoinPayload;
}
function validateControlPlaneUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  const allowInsecureHttp = Bun.env.WHITESMITH_ALLOW_INSECURE_HTTP === "true";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:") && !allowInsecureHttp) throw new Error("control plane must use HTTPS (TLS 1.3) except explicit localhost development");
  return url;
}
type MacWorkerIdentity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string };

function identityFilePath(): string {
  return Bun.env.WHITESMITH_WORKER_IDENTITY_FILE ?? `${Bun.env.HOME ?? "."}/Library/Application Support/Whitesmith/worker-identity.json`;
}
export function parseMacWorkerIdentity(value: unknown): MacWorkerIdentity {
  if (!value || typeof value !== "object") throw new Error("worker identity is invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.workerId !== "string" || typeof record.publicKey !== "string" || typeof record.privateKey !== "string" || typeof record.encryptionPublicKey !== "string" || typeof record.encryptionPrivateKey !== "string") throw new Error("worker identity is invalid");
  return { workerId: record.workerId, publicKey: record.publicKey, privateKey: record.privateKey, encryptionPublicKey: record.encryptionPublicKey, encryptionPrivateKey: record.encryptionPrivateKey };
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function enrollMacWorker(controlPlane: URL, identity: MacWorkerIdentity): Promise<MacWorkerIdentity> {
  const codeBytes = await readJoinCode();
  try {
    const payload = await currentMacWorkerJoinPayload(codeBytes.toString("utf8").trim(), identity.publicKey, identity.encryptionPublicKey);
    const response = await fetch(new URL("/api/workers/join", controlPlane), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`worker join failed: ${response.status} ${await response.text()}`);
    const joined = await response.json() as { workerId?: string };
    if (typeof joined.workerId !== "string" || !joined.workerId) throw new Error("worker join response missing workerId");
    const enrolled = { ...identity, workerId: joined.workerId };
    await saveMacWorkerIdentity(enrolled);
    if (Bun.env.WHITESMITH_JOIN_CODE_FILE) await unlink(Bun.env.WHITESMITH_JOIN_CODE_FILE).catch(() => {});
    return enrolled;
  } finally { codeBytes.fill(0); }
}

async function connectMacWorker(controlPlane: URL, identity: MacWorkerIdentity, driver: TartVmDriver, limits: MacWorkerLimits): Promise<never> {
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
        if (frame.type === "authenticated" || frame.type === "doctor_ack" || frame.type === "ping") return;
        const command = WorkerCommand.parse(frame);
        if (command.type === "tart.create_lease") {
          if (!command.leaseId) throw new Error("lease id required");
          const payload = command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] };
          if (!payload.bootstrapCiphertext) throw new Error("lease bootstrap payload invalid");
          const bootstrap = openLeaseBootstrap(payload.bootstrapCiphertext, identity.encryptionPrivateKey);
          if (bootstrap.leaseId !== command.leaseId) throw new Error("lease bootstrap mismatch");
          ws.send(JSON.stringify(workerEvent(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId })));
          void startMacLeaseLifecycle(command, driver, bootstrap, lifecycleEvent => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(lifecycleEvent));
          }, activeLeases);
          return;
        }
        ws.send(JSON.stringify(await handleMacWorkerCommand(command, driver, limits, identity.encryptionPrivateKey)));
      } catch { ws.close(1011, "worker command failed"); }
    };
    await closed.promise;
    await Bun.sleep(1_000);
  }
}
export async function runWorkerJoin(platform: "macos-arm64" | "windows-x64", baseUrl: string): Promise<void> {
  if (platform !== "macos-arm64") throw new Error("Windows worker enrollment is not implemented");
  const controlPlane = validateControlPlaneUrl(baseUrl);
  const key = createKeyPair();
  const codeBytes = await readJoinCode();
  try {
    const payload = await currentMacWorkerJoinPayload(codeBytes.toString("utf8").trim(), key.publicKey, key.encryptionPublicKey);
    const response = await fetch(new URL("/api/workers/join", controlPlane), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`worker join failed: ${response.status} ${await response.text()}`);
  } finally { codeBytes.fill(0); }
}
export async function runMacWorker(baseUrl: string, limits: MacWorkerLimits): Promise<never> {
  const controlPlane = validateControlPlaneUrl(baseUrl);
  const driver = new TartVmDriver(createTartVmRuntime(), Bun.env.WHITESMITH_TART_BASE_IMAGE ?? "whitesmith-macos-worker", "whitesmith-job", limits, Bun.env.WHITESMITH_TART_IMAGE_DIGEST ?? Bun.env.WHITESMITH_TART_BASE_IMAGE ?? "whitesmith-macos-worker");
  const existing = await loadMacWorkerIdentity();
  const identity = existing ?? await enrollMacWorker(controlPlane, { workerId: "", ...createKeyPair() });
  return connectMacWorker(controlPlane, identity, driver, limits);
}
if (import.meta.main && Bun.argv[2] === "mac-worker") { const baseUrl = Bun.env.WHITESMITH_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required"); await runMacWorker(baseUrl, { maxVcpuPerPod: Number(Bun.env.MAX_VCPU_PER_POD ?? 2), maxMemoryBytesPerPod: Number(Bun.env.MAX_MEMORY_BYTES_PER_POD ?? 4 * 1024 ** 3), maxStorageBytesPerPod: Number(Bun.env.MAX_STORAGE_BYTES_PER_POD ?? 20 * 1024 ** 3), maxConcurrentPods: Number(Bun.env.MAX_CONCURRENT_PODS ?? 1) }); }
if (import.meta.main && Bun.argv[2] === "join") { const platform = Bun.argv[3]; if (platform !== "macos-arm64" && platform !== "windows-x64") throw new Error("unsupported join platform"); const baseUrl = Bun.env.WHITESMITH_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required"); await runWorkerJoin(platform, baseUrl); }
