import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cpus, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import { WorkerBootstrapRequest, WorkerConfiguration, WorkerConfigurePayload, WorkerCommand, WorkerDoctorData, WorkerEvent, type WorkerCapacityData } from "@whitesmith/contracts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { authenticateWorker, workerSocketUrl, type WorkerIdentity } from "./worker-client.ts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";
import type { LibvirtVmDriver } from "./libvirt-vm.ts";
import type { WorkerLimits } from "@whitesmith/contracts";
export type LinuxWorkerResources = {
  appliance: { vcpu: number; memoryBytes: number; storageBytes: number };
  runtime: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
};

/** Apply the durable worker.configure command and report the exact observed values. */
export function applyLinuxWorkerConfigure(command: WorkerCommand, resources: LinuxWorkerResources): WorkerEvent {
  const payload = WorkerConfigurePayload.parse(command.payload);
  const observed = WorkerConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms });
  resources.appliance = observed.appliance;
  resources.runtime = observed.runtime;
  return {
    version: 1,
    id: crypto.randomUUID(),
    workerId: command.workerId,
    type: "worker.configured",
    occurredAt: new Date().toISOString(),
    payload: { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed },
  };
}

export function handleLinuxWorkerCommand(command: WorkerCommand, resources: LinuxWorkerResources): WorkerEvent {
  if (command.type !== "worker.configure") throw new Error(`unsupported worker command: ${command.type}`);
  return applyLinuxWorkerConfigure(command, resources);
}

export type LinuxWorkerCommandContext = {
  driver: Pick<LibvirtVmDriver, "createLease" | "stopLease" | "removeLease">;
  encryptionPrivateKey: string;
  runtimeReady: () => boolean;
  send: (event: WorkerEvent) => void;
  activeLeases?: Map<string, Promise<void>>;
};

export async function handleLinuxWorkerCommandWithContext(command: WorkerCommand, resources: LinuxWorkerResources, context: LinuxWorkerCommandContext): Promise<WorkerEvent | void> {
  if (command.type === "worker.configure") return handleLinuxWorkerCommand(command, resources);
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
  const lifecycle = runLeaseLifecycle(command, context.driver, bootstrap, context.send);
  active.set(bootstrap.leaseId, lifecycle);
  void lifecycle.finally(() => active.delete(bootstrap.leaseId));
}
export type LinuxWorkerJoinInput = {
  code: string;
  publicKey: string;
  encryptionPublicKey: string;
  vmUuid: string;
  machineUuid: string;
  doctor: WorkerDoctorData;
  capacity: WorkerCapacityData;
};
export type LinuxWorkerJoinPayload = LinuxWorkerJoinInput & { platform: "linux-x64" };
export function buildLinuxWorkerJoinPayload(input: LinuxWorkerJoinInput): LinuxWorkerJoinPayload {
  return WorkerBootstrapRequest.parse({ ...input, platform: "linux-x64" }) as LinuxWorkerJoinPayload;
}
function workerEvent(workerId: string, type: string, payload: Record<string, unknown>): WorkerEvent {
  return WorkerEvent.parse({ version: 1, id: randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });
}
function createLinuxIdentity(): WorkerIdentity {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    workerId: "",
    publicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKey: signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString(),
    encryptionPrivateKey: encryption.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}
function identityPath(): string { return Bun.env.WHITESMITH_WORKER_IDENTITY_FILE ?? "/var/lib/whitesmith/config/worker-identity.json"; }
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
  if (Bun.env.WHITESMITH_JOIN_CODE_FILE) return (await readFile(Bun.env.WHITESMITH_JOIN_CODE_FILE, "utf8")).trim();
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
  const code = await readEnrollmentCode();
  const capacity = linuxCapacity();
  const doctor = await linuxDoctor(driver, digest, channelRoot);
  const payload = buildLinuxWorkerJoinPayload({ code, publicKey: identity.publicKey, encryptionPublicKey: identity.encryptionPublicKey, vmUuid: Bun.env.WHITESMITH_VM_UUID ?? randomUUID(), machineUuid: Bun.env.WHITESMITH_MACHINE_UUID ?? randomUUID(), doctor, capacity });
  const response = await fetch(new URL("/api/workers/join", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`worker join failed: ${response.status}`);
  const joined = await response.json() as { workerId?: string };
  if (!joined.workerId) throw new Error("worker join response missing workerId");
  const enrolled = { ...identity, workerId: joined.workerId };
  await saveIdentity(enrolled);
  return enrolled;
}
async function connectLinuxWorker(baseUrl: URL, identity: WorkerIdentity, driver: LibvirtVmDriver, limits: WorkerLimits, resources: LinuxWorkerResources, digest: string, channelRoot: string): Promise<never> {
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
        if (frame.type === "authenticated" || frame.type === "ping") {
          doctor = await linuxDoctor(driver, digest, channelRoot);
          return ws.send(JSON.stringify({ version: 1, type: "doctor", workerId: identity.workerId, payload: { doctor: { ...doctor, activeLeases: [...activeLeases.keys()] }, capacity: linuxCapacity() } }));
        }
        if (frame.type === "doctor_ack") return;
        const command = WorkerCommand.parse(frame);
        if (command.type === "worker.configure") return ws.send(JSON.stringify(handleLinuxWorkerCommand(command, resources)));
        if (command.type === "linux-vm.create_lease") {
          ws.send(JSON.stringify(workerEvent(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId })));
          await handleLinuxWorkerCommandWithContext(command, resources, { driver, encryptionPrivateKey: identity.encryptionPrivateKey, runtimeReady: () => doctor.runtimeReady === true, send: (value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }, activeLeases });
          return;
        }
        if (command.type === "linux-vm.stop_lease") {
          await handleLinuxWorkerCommandWithContext(command, resources, { driver, encryptionPrivateKey: identity.encryptionPrivateKey, runtimeReady: () => true, send: (value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }, activeLeases });
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
  if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required");
  const required = ["WHITESMITH_GOLDEN_DISK", "WHITESMITH_GOLDEN_DIGEST", "WHITESMITH_DOMAIN_TEMPLATE", "WHITESMITH_CLONE_ROOT", "WHITESMITH_CHANNEL_ROOT", "WHITESMITH_LIBVIRT_NETWORK"];
  const missing = required.filter((name) => !Bun.env[name]);
  if (missing.length) throw new Error(`missing Linux worker configuration: ${missing.join(", ")}`);
  const host = await driver.validateHost();
  if (!host.runtimeReady) throw new Error(host.remediation ?? "linux runtime host validation failed");
  await driver.reconcileOrphans();
  const resources: LinuxWorkerResources = { appliance: { vcpu: cpus().length, memoryBytes: totalmem(), storageBytes: linuxCapacity().actualStorageBytes }, runtime: limits };
  const controlPlane = new URL(baseUrl);
  const identity = (await loadIdentity()) ?? await enrollLinuxWorker(controlPlane, createLinuxIdentity(), driver, Bun.env.WHITESMITH_GOLDEN_DIGEST!, Bun.env.WHITESMITH_CHANNEL_ROOT!);
  await connectLinuxWorker(controlPlane, identity, driver, limits, resources, Bun.env.WHITESMITH_GOLDEN_DIGEST!, Bun.env.WHITESMITH_CHANNEL_ROOT!);
}
