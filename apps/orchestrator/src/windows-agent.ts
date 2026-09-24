import { generateKeyPairSync, sign as signMessage, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { WorkerBootstrapRequest, WorkerBuildImagePayload, WorkerCacheConfiguration, WorkerCommand, WorkerConfigurePayload, WorkerObservedConfiguration, WorkerRunnerCachePurgePayload, WorkerDoctorData, WorkerDoctorReport, WorkerEvent, type WorkerCapacityData, type WorkerContainerStatus, type LeaseBootstrapEnvelope } from "@mars/contracts";
import { collectWorkerServiceLogs } from "./worker-service-logs.ts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { createHyperVRuntime, HyperVDriver } from "./hyperv.ts";
import { WindowsContainerDriver, isExpectedWindowsEntrypoint, parseWindowsContainerDnsServers } from "./windows-container.ts";
import { prepareWindowsContainerImage } from "./windows-image-build.ts";
import type { RuntimeDriver } from "./runtime.ts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";
import { emitActionCacheSnapshot, startActionCacheService, type ActionCacheService } from "./action-cache/service.ts";
import { connectWorkerSocket, retryControlPlaneOperation, retryWorkerRuntime, waitForWorkerSocketClose, workerRuntimeVersions, WorkerEventTransport } from "./worker-client.ts";
import { openLeasePickupState, leasePickupStateFile, writeLeasePickupState, type LeasePickupStateController } from "./lease-pickup-state.ts";

type Limits = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
type Identity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string; vmUuid?: string; machineUuid?: string; preserveLeases?: boolean };
const identityPath = () => Bun.env.MARS_WORKER_IDENTITY_FILE ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Mars", "worker-identity.json");
const event = (workerId: string, type: string, payload: Record<string, unknown>): WorkerEvent => WorkerEvent.parse({ version: 1, id: randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });
const keys = () => { const signing = generateKeyPairSync("ed25519"), encryption = generateKeyPairSync("x25519"); return { workerId: "", publicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(), privateKey: signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString(), encryptionPrivateKey: encryption.privateKey.export({ format: "pem", type: "pkcs8" }).toString() }; };
const runBoundedCommand = async (command: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string }> => {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const stdout = new Response(process.stdout).text();
  const timeout = setTimeout(() => process.kill(), timeoutMs);
  try {
    return { code: await process.exited, stdout: await stdout };
  } finally {
    clearTimeout(timeout);
  }
};
const machineUuid = async () => { if (Bun.env.MARS_MACHINE_UUID) return Bun.env.MARS_MACHINE_UUID; return (await runBoundedCommand(["powershell.exe", "-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"])).stdout.trim(); };
const createIdentity = async (): Promise<Identity> => ({ ...keys(), vmUuid: Bun.env.MARS_VM_UUID ?? randomUUID(), machineUuid: await machineUuid() });
const runPowerShellJson = async (command: string): Promise<Record<string, number>> => { const result = await runBoundedCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]); const output = result.stdout.trim(); if (result.code !== 0) throw new Error(`Windows capacity query failed: ${output}`); const value = JSON.parse(output) as Record<string, number>; if (Object.values(value).some((entry) => !Number.isFinite(entry) || entry <= 0)) throw new Error("Windows capacity query returned invalid values"); return value; };
const capacity = async (): Promise<WorkerCapacityData> => {
  const value = await runPowerShellJson("$system=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop; $cpu=(Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; $available=(Get-Counter '\\Memory\\Available Bytes' -ErrorAction Stop).CounterSamples[0].CookedValue; $disk=Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object DeviceID -eq 'C:'; if (-not $disk) { throw 'C: drive not found' }; [pscustomobject]@{vcpu=[double]$cpu; memory=[double]$system.TotalPhysicalMemory; freeMemory=[double]$available; storage=[double]$disk.Size; freeStorage=[double]$disk.FreeSpace} | ConvertTo-Json -Compress");
  return { actualVcpu: value.vcpu, freeVcpu: value.vcpu, actualMemoryBytes: value.memory, freeMemoryBytes: value.freeMemory, actualStorageBytes: value.storage, freeStorageBytes: value.freeStorage };
};
const commandSucceeds = async (command: string[]): Promise<boolean> => {
  try {
    return (await runBoundedCommand(command)).code === 0;
  } catch {
    return false;
  }
};
const localImageVerification = async (image: string): Promise<{ manifest: boolean; entrypoint: boolean; imageId?: string }> => {
  if (image !== "mars/windows-job:local") return { manifest: false, entrypoint: false };
  const path = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Mars", "windows-job-image.json");
  try {
    const manifest = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) as { schemaVersion?: number; image?: string; imageId?: string; runtimeProbe?: { mediaFoundation?: boolean; runnerCacheRegistration?: boolean; dns?: boolean; tcp443?: boolean } };
    if (manifest.schemaVersion !== 1 || manifest.image !== image || !manifest.imageId || !manifest.runtimeProbe?.mediaFoundation || !manifest.runtimeProbe.runnerCacheRegistration || !manifest.runtimeProbe.dns || !manifest.runtimeProbe.tcp443) return { manifest: false, entrypoint: false };
    const imageIdResult = await runBoundedCommand(["docker.exe", "image", "inspect", "--format", "{{.Id}}", image]);
    const imageId = imageIdResult.stdout.trim();
    if (imageIdResult.code !== 0 || imageId !== manifest.imageId) return { manifest: false, entrypoint: false };
    const entrypointResult = await runBoundedCommand(["docker.exe", "image", "inspect", "--format", "{{json .}}", image]);
    const imageInspection = JSON.parse(entrypointResult.stdout.trim()) as { Config?: { Entrypoint?: unknown } };
    return { manifest: true, entrypoint: entrypointResult.code === 0 && isExpectedWindowsEntrypoint(imageInspection.Config?.Entrypoint), imageId };
  } catch {
    return { manifest: false, entrypoint: false };
  }
};
type WindowsVmImageState = {
  version: number;
  imageDigest: string;
  contentDigest: string;
  installedPath: string;
  ready: boolean;
  remediation?: string | null;
  probe?: { passed?: boolean };
};
export const verifiedWindowsVmImage = async (
  programData = Bun.env.ProgramData ?? "C:\\ProgramData",
  configuredPath = Bun.env.MARS_WINDOWS_CHECKPOINT_PATH,
  configuredDigest = Bun.env.MARS_WINDOWS_CHECKPOINT_DIGEST,
): Promise<{ ready: boolean; digest?: string; remediation?: string }> => {
  const statePath = join(programData, "Mars", "vm-provisioning", "image-state.json");
  try {
    const state = JSON.parse((await readFile(statePath, "utf8")).replace(/^\uFEFF/, "")) as WindowsVmImageState;
    if (!configuredPath || resolve(configuredPath).toLowerCase() !== resolve(state.installedPath).toLowerCase()) throw new Error("VM image state path does not match the service checkpoint path");
    if (state.version !== 1 || state.ready !== true || state.probe?.passed !== true) throw new Error("VM image state is not ready or lacks passing probe evidence");
    if (!configuredDigest || configuredDigest !== state.imageDigest) throw new Error("VM image state digest does not match the service checkpoint digest");
    if (!/^sha256:[0-9a-f]{64}$/.test(state.imageDigest) || !/^sha256:[0-9a-f]{64}$/.test(state.contentDigest)) throw new Error("VM image state digests are invalid");
    const manifest = JSON.parse((await readFile(join(state.installedPath, "manifest.json"), "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const probeEvidence = manifest.probe as Record<string, unknown> | undefined;
    if (manifest.format === 2) {
      if (manifest.kind !== "hyperv-checkpoint-export" || manifest.imageDigest !== state.imageDigest || manifest.contentDigest !== state.contentDigest) throw new Error("VM checkpoint manifest identity does not match image state");
      if (probeEvidence?.passed !== true || probeEvidence.imageDigest !== state.imageDigest || probeEvidence.contentDigest !== state.contentDigest) throw new Error("VM checkpoint probe evidence is not bound to the installed image");
    } else if (manifest.format !== 1) {
      throw new Error("VM checkpoint manifest format is unsupported");
    }
    const files = Array.isArray(manifest.files) ? manifest.files as Array<Record<string, unknown>> : [];
    if (files.length === 0 || files.filter(file => typeof file.path === "string" && file.path.toLowerCase().endsWith(".vmcx")).length !== 1) throw new Error("VM checkpoint manifest file inventory is invalid");
    for (const file of files) {
      if (typeof file.path !== "string" || file.path.includes("..") || typeof file.length !== "number" || !/^(?:sha256:)?[0-9a-f]{64}$/.test(String(file.sha256))) throw new Error("VM checkpoint manifest contains an invalid file record");
      const value = await stat(join(state.installedPath, file.path)).catch(() => null);
      if (!value?.isFile() || value.size !== file.length) throw new Error(`VM checkpoint file is missing or changed: ${file.path}`);
    }
    return { ready: true, digest: state.imageDigest };
  } catch (error) {
    return { ready: false, remediation: error instanceof Error ? error.message : String(error) };
  }
};
export const windowsDoctor = async (preserveLeases = false, runProbe: typeof commandSucceeds = commandSucceeds): Promise<WorkerDoctorData> => {
  const runtimeMode = Bun.env.MARS_WINDOWS_RUNTIME === "container" ? "container" : "vm";
  const artifactValue = runtimeMode === "container" ? Bun.env.MARS_WINDOWS_CONTAINER_IMAGE : Bun.env.MARS_WINDOWS_CHECKPOINT_DIGEST;
  const localVerification = runtimeMode === "container" ? await localImageVerification(artifactValue ?? "") : { manifest: false, entrypoint: true };
  const vmImage = runtimeMode === "vm" ? await verifiedWindowsVmImage() : undefined;
  const localManifest = localVerification.manifest;
  const digestPinned = typeof artifactValue === "string" && /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/.test(artifactValue);
  const immutableArtifact = runtimeMode === "container" ? localManifest || digestPinned : vmImage?.ready === true && vmImage.digest === artifactValue;
  const probe = runtimeMode === "container"
    ? await runProbe(["docker.exe", "info", "--format", "{{.OSType}}"])
    : await runProbe(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-VMHost -ErrorAction Stop | Out-Null"]);
  const failures = [
    !probe && `${runtimeMode === "container" ? "Windows container host" : "Hyper-V host"} probe failed`,
    !immutableArtifact && (runtimeMode === "container" ? "Verified Windows container image manifest is missing or stale" : vmImage?.remediation ?? "Verified Windows VM image state is missing or invalid"),
    runtimeMode === "container" && localManifest && !localVerification.entrypoint && "Windows container image entrypoint is invalid",
  ].filter((failure): failure is string => Boolean(failure));
  const artifactDigest = runtimeMode === "vm" ? vmImage?.digest : localVerification.imageId ?? (digestPinned ? artifactValue : undefined);
  return WorkerDoctorData.parse({ runtimeMode, preserveLeases, ...(runtimeMode === "container" ? { artifactSource: "worker_local", ...(artifactValue ? { artifactIdentity: artifactValue } : {}) } : { artifactSource: "template" }), ...(artifactDigest ? { artifactDigest } : {}), runtimeReady: failures.length === 0, probe, imageSignatures: immutableArtifact, remediation: failures.length ? failures.join("; ") : null });
};
const joinCode = async () => { const path = Bun.env.MARS_JOIN_CODE_FILE; if (path) return (await readFile(path, "utf8")).trim(); const reader = Bun.stdin.stream().getReader(); const { value } = await reader.read(); reader.releaseLock(); return Buffer.from(value ?? []).toString("utf8").trim(); };
const save = async (identity: Identity) => { const path = identityPath(); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(identity) + "\n", { mode: 0o600 }); };
const load = async () => { try { return JSON.parse(await readFile(identityPath(), "utf8")) as Identity; } catch { return null; } };
const auth = (nonce: string, identity: Identity) => ({ type: "authenticate", workerId: identity.workerId, encryptionPublicKey: identity.encryptionPublicKey, signature: signMessage(null, Buffer.from(`${nonce}\n${identity.workerId}\n${identity.encryptionPublicKey}`), identity.privateKey).toString("base64url") });
export async function buildWindowsImage(command: WorkerCommand, send: (event: WorkerEvent) => void): Promise<void> {
  const payload = WorkerBuildImagePayload.parse(command.payload);
  let failureStage = "receive_payload";
  console.log("Windows image build command received", { workerId: command.workerId, commandId: command.id, buildId: payload.buildId, image: payload.image, contentSha256: payload.contentSha256 });
  try {
    const manifestPath = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Mars", "windows-job-image.json");
    const { imageId } = await prepareWindowsContainerImage(payload, manifestPath, stage => { failureStage = stage; });
    console.log("Windows image build verified", { workerId: command.workerId, commandId: command.id, buildId: payload.buildId, image: payload.image, imageId, contentSha256: payload.contentSha256 });
    send(event(command.workerId, "worker.build_completed", { commandId: command.id, buildId: payload.buildId, image: payload.image, imageId, contentSha256: payload.contentSha256, runtimeReady: true, message: "Local image built and runtime probe passed" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Windows image build failed", { workerId: command.workerId, commandId: command.id, buildId: payload.buildId, image: payload.image, contentSha256: payload.contentSha256, failureStage, error: message });
    send(event(command.workerId, "worker.build_failed", { commandId: command.id, buildId: payload.buildId, image: payload.image, contentSha256: payload.contentSha256, runtimeReady: false, failureStage, message }));
  }
}
async function enroll(baseUrl: URL, identity: Identity): Promise<Identity> {
  const vmUuid = identity.vmUuid ?? Bun.env.MARS_VM_UUID ?? randomUUID();
  const machine = identity.machineUuid ?? await machineUuid();
  const persisted = { ...identity, vmUuid, machineUuid: machine };
  await save(persisted);
  const payload = WorkerBootstrapRequest.parse({ code: await joinCode(), computerName: hostname(), platform: "windows-x64", ...workerRuntimeVersions(), publicKey: persisted.publicKey, encryptionPublicKey: persisted.encryptionPublicKey, vmUuid, machineUuid: machine, doctor: await windowsDoctor(), capacity: await capacity() });
  const response = await retryControlPlaneOperation("worker enrollment", () => fetch(new URL("/api/workers/join", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
  if (!response.ok) throw new Error(`worker join failed: ${response.status}`);
  const joined = await response.json() as { workerId: string };
  const result = { ...persisted, workerId: joined.workerId };
  await save(result);
  return result;
}
type WindowsRuntimeDriver = Pick<RuntimeDriver, "reserveCapacity" | "createLease" | "stopLease" | "removeLease"> & { listContainerStatuses: () => Promise<WorkerContainerStatus[]>; reconcileOrphans: () => Promise<void> };
function emitWindowsWorkerEvent(workerId: string, leaseId: string | null, send: (workerEvent: WorkerEvent) => void, workerEvent: WorkerEvent): void {
  try {
    send(workerEvent);
  } catch (error) {
    console.error("Worker event delivery failed", { workerId, leaseId, type: workerEvent.type, error: error instanceof Error ? error.message : String(error) });
  }
}
export async function reconcileWindowsRuntime(identity: Pick<Identity, "preserveLeases">, driver: Pick<WindowsRuntimeDriver, "reconcileOrphans">): Promise<void> {
  if (identity.preserveLeases !== true) await driver.reconcileOrphans();
}
export function buildWindowsDoctorReport(input: { doctor: WorkerDoctorData; capacity: WorkerCapacityData; containers: WorkerContainerStatus[]; activeLeases: string[]; preserveLeases: boolean; versions?: { releaseVersion: string; contractVersion: string } }): WorkerDoctorReport {
  return WorkerDoctorReport.parse({
    ...(input.versions ?? workerRuntimeVersions()),
    doctor: {
      ...input.doctor,
      containers: input.containers,
      activeLeases: input.activeLeases,
      preserveLeases: input.preserveLeases,
    },
    capacity: input.capacity,
  });
}
export async function applyWindowsWorkerConfiguration(
  limits: Limits,
  cache: WorkerCacheConfiguration,
  payload: WorkerConfigurePayload,
  cacheService: Pick<ActionCacheService, "applyTtl" | "setRunnerCacheEnabled" | "setRunnerCacheMaxGiB">,
): Promise<WorkerObservedConfiguration> {
  const observed = WorkerObservedConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms, cache: payload.cache });
  await cacheService.applyTtl(observed.cache.ttlSeconds);
  cacheService.setRunnerCacheEnabled(observed.cache.runnerCacheEnabled);
  cacheService.setRunnerCacheMaxGiB(observed.cache.runnerCacheMaxGiB);
  Object.assign(limits, observed.runtime);
  Object.assign(cache, observed.cache);
  return observed;
}
export async function applyWindowsRunnerCachePurge(command: WorkerCommand, cacheService: Pick<ActionCacheService, "purgeRunnerCache">): Promise<WorkerEvent> {
  const payload = WorkerRunnerCachePurgePayload.parse(command.payload);
  if (payload.workerId !== command.workerId || command.leaseId !== null) throw new Error("runner cache purge command invalid");
  await cacheService.purgeRunnerCache();
  return event(command.workerId, "command.accepted", { commandId: command.id, leaseId: null });
}
export async function runWindowsLeaseCleanup(
  command: WorkerCommand,
  driver: Pick<RuntimeDriver, "stopLease" | "removeLease">,
  send: (workerEvent: WorkerEvent) => void,
  preserveLeases = false,
  inventoryChanged?: () => void,
): Promise<void> {
  if (!["tart.stop_lease", "windows-container.stop_lease", "hyperv.stop_lease"].includes(command.type) || !command.leaseId) throw new Error("Windows lease cleanup command invalid");
  const nonce = String((command.payload as Record<string, unknown>).nonce ?? "");
  const payload = { commandId: command.id, leaseId: command.leaseId, nonce };
  const emit = (workerEvent: WorkerEvent) => emitWindowsWorkerEvent(command.workerId, command.leaseId, send, workerEvent);
  const notifyInventory = () => {
    try { inventoryChanged?.(); } catch (error) {
      console.error("Windows worker inventory notification failed", { workerId: command.workerId, leaseId: command.leaseId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  if (command.type !== "tart.stop_lease" && preserveLeases) {
    emit(event(command.workerId, "lease.failed", { ...payload, reason: "debug_preserve" }));
    notifyInventory();
    return;
  }
  emit(event(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId }));
  let cleanupFailed = false;
  try { await driver.stopLease(command.leaseId); } catch { cleanupFailed = true; }
  try { await driver.removeLease(command.leaseId); } catch { cleanupFailed = true; }
  emit(event(command.workerId, cleanupFailed ? "lease.failed" : "lease.reaped", cleanupFailed
    ? { ...payload, reason: "cleanup_failed" }
    : payload));
  notifyInventory();
}

export function startWindowsLeaseLifecycle(
  command: WorkerCommand,
  driver: Pick<RuntimeDriver, "createLease" | "stopLease" | "removeLease">,
  bootstrap: LeaseBootstrapEnvelope,
  send: (workerEvent: WorkerEvent) => void,
  active: Map<string, Promise<void>>,
  preserveLeases: () => boolean = () => false,
  cacheService?: Pick<ActionCacheService, "transport" | "unregisterLease">,
  inventoryChanged?: () => void,
): Promise<void> {
  const existing = active.get(bootstrap.leaseId);
  if (existing) return existing;
  let terminal = false;
  const notifyInventory = (type: string) => {
    if (type !== "sandbox_attested" && type !== "lease.reaped" && type !== "lease.failed") return;
    if (type !== "sandbox_attested") {
      terminal = true;
      return;
    }
    try { inventoryChanged?.(); } catch (error) {
      console.error("Windows worker inventory notification failed", { workerId: command.workerId, leaseId: bootstrap.leaseId, type, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const emit = (workerEvent: WorkerEvent) => {
    try {
      send(workerEvent);
    } finally {
      notifyInventory(workerEvent.type);
    }
  };
  const lifecycle = runLeaseLifecycle(command, driver, bootstrap, emit, { preserveLeases, cacheService }).finally(() => {
    if (active.get(bootstrap.leaseId) === lifecycle) active.delete(bootstrap.leaseId);
    if (terminal) {
      try { inventoryChanged?.(); } catch (error) {
        console.error("Windows worker inventory notification failed", { workerId: command.workerId, leaseId: bootstrap.leaseId, type: "terminal", error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  active.set(bootstrap.leaseId, lifecycle);
  return lifecycle;
}

type WindowsWorkerCommandContext = {
  mode: "container" | "vm";
  limits: Limits;
  cache: WorkerCacheConfiguration;
  cacheService: Pick<ActionCacheService, "applyTtl" | "setRunnerCacheEnabled" | "setRunnerCacheMaxGiB" | "purgeRunnerCache" | "transport" | "unregisterLease">;
  driver: WindowsRuntimeDriver;
  identity: Identity;
  activeLeases: Map<string, Promise<void>>;
  acceptingLeases?: () => boolean;
  send: (event: WorkerEvent) => void;
  sendDoctor: () => void;
};


const normalizedError = (error: unknown): string => error instanceof Error ? error.message : String(error);
export function logDevelopmentWorkerEvent(workerEvent: WorkerEvent): void {
  if (workerEvent.type === "job.resource_sample") return;
  if (workerEvent.type === "job.log") {
    const content = workerEvent.payload.content;
    if (typeof content === "string") process.stdout.write(content);
    return;
  }
  console.log("Development worker event", {
    type: workerEvent.type,
    commandId: workerEvent.payload.commandId,
    leaseId: workerEvent.payload.leaseId,
    reason: workerEvent.payload.reason,
    exitCode: workerEvent.payload.exitCode,
  });
}
export async function executeWindowsWorkerCommand(command: WorkerCommand, context: WindowsWorkerCommandContext): Promise<void> {
  const { mode, limits, cache, cacheService, driver, identity, activeLeases, acceptingLeases, send, sendDoctor } = context;
  if (command.type === "worker.collect_logs") {
    return send(await collectWorkerServiceLogs(command));
  }
  if (command.type === "worker.set_lease_preservation") {
    const enabled = (command.payload as Record<string, unknown>).enabled;
    if (typeof enabled !== "boolean") throw new Error("lease preservation command invalid");
    identity.preserveLeases = enabled;
    await save(identity);
    return send(event(command.workerId, "command.accepted", { commandId: command.id, leaseId: null }));
  }
  if (command.type === "worker.configure") {
    const payload = WorkerConfigurePayload.parse(command.payload);
    const observed = await applyWindowsWorkerConfiguration(limits, cache, payload, cacheService);
    return send(event(command.workerId, "worker.configured", { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed }));
  }
  if (command.type === "worker.runner_cache_purge") {
    return send(await applyWindowsRunnerCachePurge(command, cacheService));
  }
  if (command.type === "worker.build_image") {
    await buildWindowsImage(command, send);
    sendDoctor();
    return;
  }
  if (command.type === "tart.stop_lease" || command.type === "windows-container.stop_lease" || command.type === "hyperv.stop_lease") {
    return runWindowsLeaseCleanup(command, driver, send, identity.preserveLeases === true, sendDoctor);
  }
  if (command.type === "windows-container.create_lease" || command.type === "hyperv.create_lease") {
    const expectedType = mode === "container" ? "windows-container.create_lease" : "hyperv.create_lease";
    if (command.type !== expectedType) throw new Error(`Windows runtime mode ${mode} rejects ${command.type}`);
    const cipher = (command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] }).bootstrapCiphertext;
    if (!cipher) throw new Error("lease bootstrap payload invalid");
    const bootstrap: LeaseBootstrapEnvelope = openLeaseBootstrap(cipher, identity.encryptionPrivateKey);
    if (acceptingLeases && !acceptingLeases()) {
      return send(event(command.workerId, "lease.declined", { commandId: command.id, leaseId: command.leaseId, nonce: bootstrap.nonce, reason: "pickup_paused" }));
    }
    send(event(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId }));
    await startWindowsLeaseLifecycle(command, driver, bootstrap, send, activeLeases, () => identity.preserveLeases === true, cache.runnerCacheEnabled ? cacheService : undefined, sendDoctor);
  }
}
export function dispatchWindowsWorkerFrame(
  frame: Record<string, unknown>,
  input: { workerId: string; send: (data: string) => void; close: () => void; sendDoctor: () => Promise<void>; execute: (command: WorkerCommand) => Promise<void> },
): void {
  if (frame.type === "ping") {
    input.send(JSON.stringify({ version: 1, type: "pong", workerId: input.workerId }));
    void input.sendDoctor();
    return;
  }
  if (frame.type === "doctor_ack") return;
  let command: WorkerCommand;
  try {
    command = WorkerCommand.parse(frame);
  } catch {
    input.close();
    return;
  }
  void input.execute(command).catch(error => {
    console.error("Windows worker command failed", {
      workerId: command.workerId,
      commandId: command.id,
      type: command.type,
      leaseId: command.leaseId,
      error: normalizedError(error),
    });
  });
}



async function runWindowsWorkerWithCache(baseUrl: string, limits: Limits, cache: WorkerCacheConfiguration, cacheService: ActionCacheService): Promise<never> {
  const controlPlane = new URL(baseUrl);
  let identity = await load();
  if (!identity) {
    identity = await createIdentity();
    await save(identity);
  }
  const mode = Bun.env.MARS_WINDOWS_RUNTIME ?? "vm";
  let driver: WindowsRuntimeDriver;
  if (mode === "container") {
    const image = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE;
    if (!image) throw new Error("MARS_WINDOWS_CONTAINER_IMAGE is required in container mode");
    driver = new WindowsContainerDriver({ image, prefix: Bun.env.MARS_WINDOWS_CONTAINER_PREFIX ?? "mars", bootstrapRoot: Bun.env.ProgramData ? `${Bun.env.ProgramData}\\Mars\\leases` : "C:\\ProgramData\\Mars\\leases", limits, readyTimeoutMs: Number(Bun.env.MARS_WINDOWS_CONTAINER_READY_TIMEOUT_MS ?? 15_000), jobTimeoutMs: Number(Bun.env.MARS_WINDOWS_CONTAINER_JOB_TIMEOUT_MS ?? 900_000), allowLocalImage: Bun.env.MARS_ALLOW_LOCAL_CONTAINER_IMAGE === "true", imageManifestPath: Bun.env.MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST, requireLocalImageManifest: image === "mars/windows-job:local", dnsServers: parseWindowsContainerDnsServers(Bun.env.MARS_WINDOWS_CONTAINER_DNS_SERVERS) });
  } else if (mode === "vm") {
    const checkpointPath = Bun.env.MARS_WINDOWS_CHECKPOINT_PATH;
    const checkpointDigest = Bun.env.MARS_WINDOWS_CHECKPOINT_DIGEST;
    if (!checkpointPath || !checkpointDigest) throw new Error("Windows Hyper-V checkpoint path and digest are required in VM mode");
    driver = new HyperVDriver(createHyperVRuntime(), checkpointPath, checkpointDigest, Bun.env.MARS_HYPERV_VM_PREFIX ?? "mars", limits);
  } else {
    throw new Error(`Unsupported Windows runtime: ${mode}`);
  }
  const runtimeIdentity = identity;
  await retryWorkerRuntime("Windows orphan reconciliation", () => reconcileWindowsRuntime(runtimeIdentity, driver));
  if (!identity.workerId) identity = await enroll(controlPlane, identity);
  const pickupState = await openLeasePickupState(leasePickupStateFile());
  const activeLeases = new Map<string, Promise<void>>();
  const eventTransport = new WorkerEventTransport(() => cacheService.runnerCacheStatus().enabled);
  const developmentConsole = Bun.env.MARS_DEV_WORKER_CONSOLE_LOGS === "true";
  const publishInventory = () => { void writeLeasePickupState(leasePickupStateFile(), pickupState.acceptingLeases, activeLeases.size); };
  const sendDoctor = async (ws: WebSocket): Promise<void> => {
    publishInventory();
    try {
      const [currentDoctor, currentCapacity, containers] = await Promise.all([windowsDoctor(identity.preserveLeases === true), capacity(), driver.listContainerStatuses()]);
      const report = buildWindowsDoctorReport({
        doctor: { ...currentDoctor, inventoryObservedAt: new Date().toISOString(), acceptingLeases: pickupState.acceptingLeases },
        capacity: currentCapacity,
        containers,
        activeLeases: [...activeLeases.keys()],
        preserveLeases: identity.preserveLeases === true,
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ version: 1, type: "doctor", workerId: identity.workerId, payload: report }));
      }
    } catch (error) {
      console.error("Windows worker doctor collection failed", { workerId: identity.workerId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const loop = async (signal?: AbortSignal): Promise<never> => {
    for (;;) {
      if (signal?.aborted) throw new Error("worker stopped");
      const url = new URL("/api/v1/workers/connect", controlPlane);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("workerId", identity.workerId);
      const ws = await connectWorkerSocket(url.toString());
      const closed = waitForWorkerSocketClose(ws);
      if (developmentConsole) ws.addEventListener("close", event => console.warn("Development worker connection closed", { workerId: identity.workerId, code: event.code, reason: event.reason }));
      ws.onmessage = async (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as Record<string, unknown>;
          if (frame.type === "challenge") return ws.send(JSON.stringify(auth(String(frame.nonce), identity)));
          if (frame.type === "authenticated") {
            if (developmentConsole) console.log("Development worker authenticated", { workerId: identity.workerId });
            eventTransport.bind(ws);
            if (Bun.env.MARS_JOIN_CODE_FILE) await unlink(Bun.env.MARS_JOIN_CODE_FILE).catch(() => {});
            await emitActionCacheSnapshot(cacheService, (type, payload) => {
              eventTransport.send(event(identity.workerId, type, payload));
            });
            await sendDoctor(ws);
            return;
          }
          if (frame.type === "event_ack" && typeof frame.eventId === "string") {
            eventTransport.acknowledge(frame.eventId);
            return;
          }
          dispatchWindowsWorkerFrame(frame, {
            workerId: identity.workerId,
            send: data => ws.send(data),
            close: () => ws.close(1011, "worker command failed"),
            sendDoctor: () => sendDoctor(ws),
            execute: async command => {
              if (developmentConsole) console.log("Development worker command", { type: command.type, commandId: command.id, leaseId: command.leaseId });
              const cacheWasEnabled = cacheService.runnerCacheStatus().enabled;
              await executeWindowsWorkerCommand(command, {
                mode: mode === "container" ? "container" : "vm",
                limits,
                cache,
                cacheService,
                driver,
                acceptingLeases: () => pickupState.acceptingLeases,
                identity,
                activeLeases,
                send: workerEvent => { if (developmentConsole) logDevelopmentWorkerEvent(workerEvent); eventTransport.send(workerEvent); },
                sendDoctor: () => { void sendDoctor(ws); },
              });
              if (command.type === "worker.configure" && !cacheWasEnabled && cacheService.runnerCacheStatus().enabled) {
                await emitActionCacheSnapshot(cacheService, (type, payload) => {
                  eventTransport.send(event(identity.workerId, type, payload));
                });
              }
            },
          });
        } catch {
          ws.close(1011, "worker command failed");
        }
      };
      await closed;
      eventTransport.unbind(ws);
      await Bun.sleep(1000);
    }
  };
  return loop();
}

export async function runWindowsWorker(baseUrl: string, limits: Limits, cache = WorkerCacheConfiguration.parse({})): Promise<never> {
  const controlPlane = new URL(baseUrl);
  const cacheService = await startActionCacheService({ controlPlaneOrigin: controlPlane.origin, ttlSeconds: cache.ttlSeconds, runnerCacheEnabled: cache.runnerCacheEnabled, runnerCacheMaxGiB: cache.runnerCacheMaxGiB });
  try {
    return await runWindowsWorkerWithCache(baseUrl, limits, cache, cacheService);
  } finally {
    await cacheService.close();
  }
}
