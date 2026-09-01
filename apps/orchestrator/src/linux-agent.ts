import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cpus, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import { WorkerBootstrapRequest, WorkerCacheConfiguration, WorkerObservedConfiguration, WorkerConfigurePayload, WorkerRunnerCachePurgePayload, WorkerCommand, WorkerDoctorData, WorkerEvent, type WorkerCapacityData } from "@mars/contracts";
import { z } from "zod";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { authenticateWorker, retryControlPlaneOperation, workerSocketUrl, type WorkerIdentity } from "./worker-client.ts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";
import type { LibvirtVmDriver } from "./libvirt-vm.ts";
import type { WorkerLimits } from "@mars/contracts";
import { emitActionCacheSnapshot, startActionCacheService, type ActionCacheService } from "./action-cache/service.ts";
export type LinuxWorkerResources = {
  appliance: { vcpu: number; memoryBytes: number; storageBytes: number };
  runtime: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
  cache: WorkerCacheConfiguration;
};

/** Apply the durable worker.configure command and report the exact observed values. */
export async function applyLinuxWorkerConfigure(
  command: WorkerCommand,
  resources: LinuxWorkerResources,
  cacheService: Pick<ActionCacheService, "applyTtl" | "setRunnerCacheEnabled" | "setRunnerCacheMaxGiB">,
): Promise<WorkerEvent> {
  const payload = WorkerConfigurePayload.parse(command.payload);
  const observed = WorkerObservedConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms, cache: payload.cache });
  await cacheService.applyTtl(observed.cache.ttlSeconds);
  cacheService.setRunnerCacheEnabled(observed.cache.runnerCacheEnabled);
  cacheService.setRunnerCacheMaxGiB(observed.cache.runnerCacheMaxGiB);
  resources.appliance = observed.appliance;
  resources.runtime = observed.runtime;
  Object.assign(resources.cache, observed.cache);
  return {
    version: 1,
    id: crypto.randomUUID(),
    workerId: command.workerId,
    type: "worker.configured",
    occurredAt: new Date().toISOString(),
    payload: { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed },
  };
}

export async function handleLinuxWorkerCommand(
  command: WorkerCommand,
  resources: LinuxWorkerResources,
  cacheService: Pick<ActionCacheService, "applyTtl" | "setRunnerCacheEnabled" | "setRunnerCacheMaxGiB"> & Partial<Pick<ActionCacheService, "purgeRunnerCache">>,
): Promise<WorkerEvent> {
  if (command.type === "worker.runner_cache_purge") {
    const payload = WorkerRunnerCachePurgePayload.parse(command.payload);
    if (payload.workerId !== command.workerId || command.leaseId !== null || !cacheService.purgeRunnerCache) throw new Error("runner cache purge command invalid");
    await cacheService.purgeRunnerCache();
    return { version: 1, id: crypto.randomUUID(), workerId: command.workerId, type: "command.accepted", occurredAt: new Date().toISOString(), payload: { commandId: command.id, leaseId: null } };
  }
  if (command.type !== "worker.configure") throw new Error(`unsupported worker command: ${command.type}`);
  return applyLinuxWorkerConfigure(command, resources, cacheService);
}

export type LinuxWorkerCommandContext = {
  driver: Pick<LibvirtVmDriver, "createLease" | "stopLease" | "removeLease">;
  encryptionPrivateKey: string;
  runtimeReady: () => boolean;
  send: (event: WorkerEvent) => void;
  activeLeases?: Map<string, Promise<void>>;
  cacheService: Pick<ActionCacheService, "applyTtl" | "setRunnerCacheEnabled" | "setRunnerCacheMaxGiB" | "transport" | "unregisterLease"> & Partial<Pick<ActionCacheService, "purgeRunnerCache">>;
};

export async function handleLinuxWorkerCommandWithContext(command: WorkerCommand, resources: LinuxWorkerResources, context: LinuxWorkerCommandContext): Promise<WorkerEvent | void> {
  if (command.type === "worker.configure" || command.type === "worker.runner_cache_purge") return handleLinuxWorkerCommand(command, resources, context.cacheService);
  if (command.type === "linux-vm.stop_lease") {
    if (!command.leaseId) throw new Error("lease_id_required");
    await context.driver.stopLease(command.leaseId);
    const event = { version: 1 as const, id: crypto.randomUUID(), workerId: command.workerId, type: "lease.reaped", occurredAt: new Date().toISOString(), payload: { leaseId: command.leaseId } };
    context.send(event);
    return event;
  }
  if (command.type !== "linux-vm.create_lease") throw new Error(`unsupported worker command: ${command.type}`);
  if (!context.runtimeReady()) throw new Error("worker_runtime_not_ready");
  const payload = command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] };
  if (!payload.bootstrapCiphertext) throw new Error("bootstrap_ciphertext_missing");
  const bootstrap = openLeaseBootstrap(payload.bootstrapCiphertext, context.encryptionPrivateKey);
  if (command.leaseId !== bootstrap.leaseId) throw new Error("lease_id_mismatch");
  const active = context.activeLeases ?? new Map<string, Promise<void>>();
  if (active.has(bootstrap.leaseId)) return;
  const lifecycle = runLeaseLifecycle(command, context.driver, bootstrap, context.send, { cacheService: context.cacheService });
  active.set(bootstrap.leaseId, lifecycle);
  void lifecycle.finally(() => active.delete(bootstrap.leaseId));
}
export type LinuxWorkerJoinInput = {
  code: string;
  publicKey: string;
  encryptionPublicKey: string;
  vmUuid: string;
  machineUuid: string;
  doctor: z.input<typeof WorkerDoctorData>;
  capacity: WorkerCapacityData;
};
export type LinuxWorkerJoinPayload = LinuxWorkerJoinInput & { platform: "linux-x64" };
export function buildLinuxWorkerJoinPayload(input: LinuxWorkerJoinInput): LinuxWorkerJoinPayload {
  return WorkerBootstrapRequest.parse({ ...input, platform: "linux-x64" }) as LinuxWorkerJoinPayload;
}
function workerEvent(workerId: string, type: string, payload: Record<string, unknown>): WorkerEvent {
  return WorkerEvent.parse({ version: 1, id: randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });
}
export function createLinuxIdentity(): WorkerIdentity {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    workerId: "",
    publicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKey: signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString(),
    encryptionPrivateKey: encryption.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    vmUuid: Bun.env.MARS_VM_UUID ?? randomUUID(),
    machineUuid: Bun.env.MARS_MACHINE_UUID ?? randomUUID(),
  };
}
function identityPath(): string { return Bun.env.MARS_WORKER_IDENTITY_FILE ?? "/var/lib/mars/config/worker-identity.json"; }
async function loadIdentity(): Promise<WorkerIdentity | null> {
  try { return JSON.parse(await readFile(identityPath(), "utf8")) as WorkerIdentity; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function saveIdentity(identity: WorkerIdentity): Promise<void> {
  const path = identityPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function readEnrollmentCode(): Promise<string> {
  if (Bun.env.MARS_JOIN_CODE_FILE) return (await readFile(Bun.env.MARS_JOIN_CODE_FILE, "utf8")).trim();
  const value = await Bun.stdin.text();
  return value.trim();
}
function linuxCapacity(): WorkerCapacityData {
  const disk = statfsSync("/");
  const actualVcpu = cpus().length;
  return { actualVcpu, actualMemoryBytes: totalmem(), actualStorageBytes: disk.blocks * disk.bsize, freeVcpu: actualVcpu, freeMemoryBytes: totalmem(), freeStorageBytes: disk.bavail * disk.bsize };
}
async function linuxDoctor(driver: LibvirtVmDriver, digest: string, channelRoot: string): Promise<WorkerDoctorData> {
  const host = await driver.validateHost();
  let smoke = false;
  try {
    const evidence = JSON.parse(await readFile(`${channelRoot}/real-smoke-evidence.json`, "utf8")) as Record<string, unknown>;
    smoke = evidence.digest === digest;
  } catch {}
  return WorkerDoctorData.parse({ runtimeMode: "vm", artifactSource: "worker_local", artifactDigest: digest, runtimeReady: host.runtimeReady && smoke, libvirtReady: host.libvirtReady, networkReady: host.networkReady, cloneStorageReady: host.cloneStorageReady, realVmSmoke: smoke, imageSignatures: true, smokeArtifactDigest: smoke ? digest : undefined, smokeObservedAt: smoke ? new Date().toISOString() : undefined, remediation: host.remediation ?? (smoke ? null : "real Linux VM smoke evidence is missing") });
}
async function enrollLinuxWorker(baseUrl: URL, identity: WorkerIdentity, driver: LibvirtVmDriver, digest: string, channelRoot: string): Promise<WorkerIdentity> {
  const vmUuid = identity.vmUuid ?? Bun.env.MARS_VM_UUID ?? randomUUID();
  const machineUuid = identity.machineUuid ?? Bun.env.MARS_MACHINE_UUID ?? randomUUID();
  const persisted = { ...identity, vmUuid, machineUuid };
  await saveIdentity(persisted);
  const code = await readEnrollmentCode();
  const capacity = linuxCapacity();
  const doctor = await linuxDoctor(driver, digest, channelRoot);
  const payload = buildLinuxWorkerJoinPayload({ code, publicKey: persisted.publicKey, encryptionPublicKey: persisted.encryptionPublicKey, vmUuid, machineUuid, doctor, capacity });
  const response = await retryControlPlaneOperation("worker enrollment", () => fetch(new URL("/api/workers/join", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) }));
  if (!response.ok) throw new Error(`worker join failed: ${response.status}`);
  const joined = await response.json() as { workerId?: string };
  if (!joined.workerId) throw new Error("worker join response missing workerId");
  const enrolled = { ...persisted, workerId: joined.workerId };
  await saveIdentity(enrolled);
  return enrolled;
}
async function connectLinuxWorker(
  baseUrl: URL,
  identity: WorkerIdentity,
  driver: LibvirtVmDriver,
  limits: WorkerLimits,
  resources: LinuxWorkerResources,
  digest: string,
  channelRoot: string,
  cacheService: ActionCacheService,
): Promise<never> {
  const activeLeases = new Map<string, Promise<void>>();
  let doctor = await linuxDoctor(driver, digest, channelRoot);
  for (;;) {
    const ws = new WebSocket(workerSocketUrl(baseUrl.toString(), identity.workerId));
    const closed = Promise.withResolvers<void>();
    ws.onclose = () => closed.resolve();
    ws.onerror = () => ws.close();
    ws.onmessage = async (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { type?: string; nonce?: string } & Partial<WorkerCommand>;
        if (frame.type === "challenge" && frame.nonce) return ws.send(JSON.stringify(authenticateWorker(frame.nonce, identity)));
        if (frame.type === "authenticated") {
          if (Bun.env.MARS_JOIN_CODE_FILE) await unlink(Bun.env.MARS_JOIN_CODE_FILE).catch(() => {});
          await emitActionCacheSnapshot(cacheService, (type, payload) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(workerEvent(identity.workerId, type, payload)));
          });
          doctor = await linuxDoctor(driver, digest, channelRoot);
          return ws.send(JSON.stringify({ version: 1, type: "doctor", workerId: identity.workerId, payload: { doctor: { ...doctor, activeLeases: [...activeLeases.keys()] }, capacity: linuxCapacity() } }));
        }
        if (frame.type === "ping") {
          doctor = await linuxDoctor(driver, digest, channelRoot);
          return ws.send(JSON.stringify({ version: 1, type: "doctor", workerId: identity.workerId, payload: { doctor: { ...doctor, activeLeases: [...activeLeases.keys()] }, capacity: linuxCapacity() } }));
        }
        if (frame.type === "doctor_ack") return;
        const command = WorkerCommand.parse(frame);
        if (command.type === "worker.configure" || command.type === "worker.runner_cache_purge") return ws.send(JSON.stringify(await handleLinuxWorkerCommand(command, resources, cacheService)));
        if (command.type === "linux-vm.create_lease") {
          ws.send(JSON.stringify(workerEvent(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId })));
          await handleLinuxWorkerCommandWithContext(command, resources, { driver, encryptionPrivateKey: identity.encryptionPrivateKey, runtimeReady: () => doctor.runtimeReady === true, send: (value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }, activeLeases, cacheService });
          return;
        }
        if (command.type === "linux-vm.stop_lease") {
          await handleLinuxWorkerCommandWithContext(command, resources, { driver, encryptionPrivateKey: identity.encryptionPrivateKey, runtimeReady: () => true, send: (value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }, activeLeases, cacheService });
          return;
        }
        throw new Error("unsupported Linux worker command");
      } catch { ws.close(1011, "worker command failed"); }
    };
    await closed.promise;
    await Bun.sleep(1_000);
  }
}
export async function runLinuxWorker(baseUrl: string, driver: LibvirtVmDriver, limits: WorkerLimits): Promise<void> {
  if (!baseUrl) throw new Error("MARS_CONTROL_PLANE_URL is required");
  const required = ["MARS_GOLDEN_DISK", "MARS_GOLDEN_DIGEST", "MARS_DOMAIN_TEMPLATE", "MARS_CLONE_ROOT", "MARS_CHANNEL_ROOT", "MARS_LIBVIRT_NETWORK"];
  const missing = required.filter((name) => !Bun.env[name]);
  if (missing.length) throw new Error(`missing Linux worker configuration: ${missing.join(", ")}`);
  const host = await driver.validateHost();
  if (!host.runtimeReady) throw new Error(host.remediation ?? "linux runtime host validation failed");
  await driver.reconcileOrphans();
  const resources: LinuxWorkerResources = { appliance: { vcpu: cpus().length, memoryBytes: totalmem(), storageBytes: linuxCapacity().actualStorageBytes }, runtime: limits, cache: WorkerCacheConfiguration.parse({}) };
  const controlPlane = new URL(baseUrl);
  const cacheService = await startActionCacheService({ controlPlaneOrigin: controlPlane.origin, ttlSeconds: resources.cache.ttlSeconds, runnerCacheEnabled: resources.cache.runnerCacheEnabled, runnerCacheMaxGiB: resources.cache.runnerCacheMaxGiB });
  try {
    let identity = await loadIdentity();
    if (!identity) {
      identity = createLinuxIdentity();
      await saveIdentity(identity);
    }
    if (!identity.workerId) identity = await enrollLinuxWorker(controlPlane, identity, driver, Bun.env.MARS_GOLDEN_DIGEST!, Bun.env.MARS_CHANNEL_ROOT!);
    await connectLinuxWorker(controlPlane, identity, driver, limits, resources, Bun.env.MARS_GOLDEN_DIGEST!, Bun.env.MARS_CHANNEL_ROOT!, cacheService);
  } finally {
    await cacheService.close();
  }
}
