import { generateKeyPairSync, sign as signMessage, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { WorkerBootstrapRequest, WorkerBuildImagePayload, WorkerCacheConfiguration, WorkerCommand, WorkerConfigurePayload, WorkerObservedConfiguration, WorkerRunnerCachePurgePayload, WorkerDoctorData, WorkerDoctorReport, WorkerEvent, type WorkerCapacityData, type WorkerContainerStatus, type LeaseBootstrapEnvelope, selectedRuntimeDriver, legacyRuntimeDriver } from "@mars/contracts";
import { collectWorkerServiceLogs } from "./worker-service-logs.ts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { createHyperVRuntime, HyperVDriver } from "./hyperv.ts";
import { WindowsContainerDriver, isExpectedWindowsEntrypoint, parseWindowsContainerDnsServers } from "./windows-container.ts";
import { LinuxContainerDriver } from "./linux-container.ts";
import { prepareWindowsContainerImage } from "./windows-image-build.ts";
import type { RuntimeDriver } from "./runtime.ts";
import { admitWorkerLease, runLeaseLifecycle } from "./lease-lifecycle.ts";
import { emitActionCacheSnapshot, startActionCacheService, type ActionCacheService } from "./action-cache/service.ts";
import { connectWorkerSocket, retryControlPlaneOperation, retryWorkerRuntime, waitForWorkerSocketClose, workerRuntimeVersions, WorkerEventTransport } from "./worker-client.ts";
import { openLeasePickupState, leasePickupStateFile, writeLeasePickupState, type LeasePickupStateController } from "./lease-pickup-state.ts";

type Limits = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
type Identity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string; vmUuid?: string; machineUuid?: string; preserveLeases?: boolean; selectedDriver?: string; guestPlatform?: string };
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
export type WindowsHostPlatform = "windows-arm64" | "windows-x64";
export function windowsPlatformFromProcessorArchitecture(architecture: number): WindowsHostPlatform {
  if (architecture === 12) return "windows-arm64";
  if (architecture === 9) return "windows-x64";
  throw new Error(`Unsupported Windows processor architecture: ${architecture}`);
}
export const detectWindowsHostPlatform = async (): Promise<WindowsHostPlatform> => {
  const output = await runBoundedCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Architecture)"]);
  if (output.code !== 0) throw new Error(`Windows host architecture query failed: ${output.stdout}`);
  return windowsPlatformFromProcessorArchitecture(Number(output.stdout.trim()));
};
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
  const path = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Mars", "windows-job-image.json");
  if (!/@sha256:[0-9a-f]{64}$/.test(image) && Bun.env.MARS_ALLOW_LOCAL_CONTAINER_IMAGE !== "true") return { manifest: false, entrypoint: false };
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
type WindowsCapability = NonNullable<WorkerDoctorData["capabilities"]>[number];
export function linuxDockerCapability(engineOs: string, architecture: string, image: string | undefined, runtimeReady: boolean, missingNetwork?: string): WindowsCapability | null {
  if (engineOs !== "linux" || !["amd64", "x86_64", "arm64", "aarch64"].includes(architecture)) return null;
  const arm = architecture === "arm64" || architecture === "aarch64";
  const guestPlatform = arm ? "linux-arm64" : "linux-x64";
  const ready = runtimeReady && Boolean(image && /^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image));
  return { driver: "linux-docker-container", guestPlatform, imageDigest: ready ? image! : null, ready, remediation: ready ? null : !image ? `Set MARS_LINUX_${arm ? "ARM64" : "X64"}_CONTAINER_IMAGE to a digest-pinned verified ${guestPlatform} job image` : !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image) ? "Linux job image must be digest pinned" : missingNetwork ? `Create Docker network ${missingNetwork} or configure MARS_LINUX_CONTAINER_NETWORK` : "Linux Docker job image, entrypoint, architecture, or network validation failed" };
}
let sandboxProbeCache: { key: string; expiresAt: number; capabilities: WindowsCapability[] } | undefined;
async function probeWindowsIsolation(image: string, isolation: "process" | "hyperv"): Promise<boolean> {
  const name = `mars-probe-${randomUUID()}`;
  try {
    const created = await runBoundedCommand(["docker.exe", "create", "--name", name, `--isolation=${isolation}`, image, "powershell.exe", "-NoProfile", "-Command", "exit 0"]);
    if (created.code !== 0 || (await runBoundedCommand(["docker.exe", "start", name])).code !== 0) return false;
    const inspected = await runBoundedCommand(["docker.exe", "inspect", "--format", "{{.HostConfig.Isolation}}", name]);
    return inspected.code === 0 && inspected.stdout.trim().toLowerCase() === isolation;
  } finally {
    await runBoundedCommand(["docker.exe", "rm", "-f", name]).catch(() => ({ code: 1, stdout: "" }));
  }
}
export const windowsDoctor = async (preserveLeases = false, runProbe: typeof commandSucceeds = commandSucceeds, appliedDriver?: RuntimeSelection, hostPlatform?: WindowsHostPlatform): Promise<WorkerDoctorData> => {
  hostPlatform ??= await detectWindowsHostPlatform();
  const info = await runBoundedCommand(["docker.exe", "info", "--format", "{{json .}}"]).catch(() => ({ code: 1, stdout: "" }));
  let engineOs = "", architecture = "";
  try {
    const parsed = JSON.parse(info.stdout) as { OSType?: string; Architecture?: string };
    engineOs = String(parsed.OSType ?? "").toLowerCase();
    architecture = String(parsed.Architecture ?? "").toLowerCase();
  } catch { /* engine unavailable */ }
  const image = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE;
  const linuxImage = ["arm64", "aarch64"].includes(architecture) ? Bun.env.MARS_LINUX_ARM64_CONTAINER_IMAGE : Bun.env.MARS_LINUX_X64_CONTAINER_IMAGE;
  const vmImage = await verifiedWindowsVmImage();
  const vmReady = await runProbe(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$switchName = if ($env:MARS_HYPERV_SWITCH_NAME) { $env:MARS_HYPERV_SWITCH_NAME } else { 'Default Switch' }; Get-VMHost -ErrorAction Stop | Out-Null; Get-VMSwitch -Name $switchName -ErrorAction Stop | Out-Null"]);
  const windowsVerification = engineOs === "windows" && image ? await localImageVerification(image) : undefined;
  const linuxArchitecture = ["arm64", "aarch64"].includes(architecture) ? "arm64" : "amd64";
  const linuxGuest = linuxArchitecture === "arm64" ? "linux-arm64" : "linux-x64";
  const linuxNetwork = Bun.env.MARS_LINUX_CONTAINER_NETWORK ?? `mars-linux-${linuxArchitecture === "arm64" ? "arm64" : "x64"}`;
  const linuxDriver = engineOs === "linux" && (hostPlatform !== "windows-arm64" || ["arm64", "aarch64"].includes(architecture)) && ["amd64", "x86_64", "arm64", "aarch64"].includes(architecture) && linuxImage && /^[^@\s]+@sha256:[0-9a-f]{64}$/.test(linuxImage)
    ? new LinuxContainerDriver({ image: linuxImage, prefix: `mars-windows-linux-${linuxArchitecture === "arm64" ? "arm64" : "x64"}`, network: linuxNetwork, limits: { maxVcpuPerPod: 64, maxMemoryBytesPerPod: Number.MAX_SAFE_INTEGER, maxStorageBytesPerPod: Number.MAX_SAFE_INTEGER, maxConcurrentPods: 64 }, architecture: linuxArchitecture, hostPlacement: "serialized-no-pin" })
    : undefined;
  const linuxHost = linuxDriver ? await linuxDriver.validateHost() : undefined;
  const cacheKey = JSON.stringify([hostPlatform, engineOs, architecture, image, windowsVerification?.imageId, windowsVerification?.manifest, windowsVerification?.entrypoint, linuxImage, linuxNetwork, linuxHost?.runtimeReady, vmImage.digest, vmImage.ready, vmReady]);
  let capabilities: WindowsCapability[] = [];
  if (sandboxProbeCache?.key === cacheKey && sandboxProbeCache.expiresAt > Date.now()) capabilities = [...sandboxProbeCache.capabilities];
  else {
    if (hostPlatform === "windows-x64" && engineOs === "windows" && ["amd64", "x86_64"].includes(architecture) && image) {
      const verification = await localImageVerification(image);
      if (verification.manifest && verification.entrypoint && verification.imageId) {
        for (const isolation of ["process", "hyperv"] as const) {
          const ready = await probeWindowsIsolation(image, isolation).catch(() => false);
          capabilities.push({ driver: isolation === "process" ? "windows-process-container" : "windows-hyperv-container", guestPlatform: "windows-x64", imageDigest: ready ? verification.imageId : null, ready, remediation: ready ? null : `${isolation} isolation probe failed` });
        }
      }
    }
    const linuxCapability = linuxDockerCapability(engineOs, architecture, linuxImage, linuxHost?.runtimeReady === true, linuxHost?.imageReady && !linuxHost.networkReady ? linuxNetwork : undefined);
    if (linuxCapability && (hostPlatform !== "windows-arm64" || linuxCapability.guestPlatform === "linux-arm64")) capabilities.push(linuxCapability);
    if (hostPlatform === "windows-x64" && vmReady && vmImage.ready && vmImage.digest) capabilities.push({ driver: "windows-hyperv", guestPlatform: "windows-x64", imageDigest: vmImage.digest, ready: true, remediation: null });
    sandboxProbeCache = { key: cacheKey, expiresAt: Date.now() + 300_000, capabilities };
  }
  const selectedDriver = appliedDriver;
  const selected = capabilities.find((capability) => capability.driver === selectedDriver && (selectedDriver !== "linux-docker-container" || capability.guestPlatform === linuxGuest));
  const runtimeMode = selectedDriver === "windows-hyperv" ? "vm" : "container";
  const probe = info.code === 0 || vmReady;
  return WorkerDoctorData.parse({ runtimeMode, preserveLeases, artifactSource: runtimeMode === "container" ? "worker_local" : "template", ...(selected?.imageDigest ? { artifactDigest: selected.imageDigest } : {}), runtimeReady: selected?.ready ?? false, probe, imageSignatures: Boolean(selected?.imageDigest), remediation: selected ? selected.remediation : "No selected Windows runtime is ready", capabilities });
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
  const platform = await detectWindowsHostPlatform();
  const payload = WorkerBootstrapRequest.parse({ code: await joinCode(), computerName: hostname(), platform, ...workerRuntimeVersions(), publicKey: persisted.publicKey, encryptionPublicKey: persisted.encryptionPublicKey, vmUuid, machineUuid: machine, doctor: await windowsDoctor(false, commandSucceeds, undefined, platform), capacity: await capacity() });
  const response = await retryControlPlaneOperation("worker enrollment", () => fetch(new URL("/api/workers/join", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    const reason = typeof body?.error === "string" ? `: ${body.error}` : "";
    throw new Error(`worker join failed: ${response.status}${reason} (${baseUrl.origin})`);
  }
  const joined = await response.json() as { workerId: string };
  const result = { ...persisted, workerId: joined.workerId };
  await save(result);
  return result;
}
type RuntimeSelection = "windows-hyperv-container" | "windows-process-container" | "windows-hyperv" | "linux-docker-container";
const isRuntimeSelection = (driver: string): driver is RuntimeSelection =>
  driver === "windows-hyperv-container" || driver === "windows-process-container" || driver === "windows-hyperv" || driver === "linux-docker-container";
function createSelectedWindowsDriver(selected: RuntimeSelection | undefined, limits: Limits, guestPlatform?: string): WindowsRuntimeDriver | null {
  if (selected === "windows-hyperv-container" || selected === "windows-process-container") {
    const image = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE;
    if (!image) throw new Error("MARS_WINDOWS_CONTAINER_IMAGE is required for the applied runtime");
    return new WindowsContainerDriver({ image, isolation: selected === "windows-process-container" ? "process" : "hyperv", prefix: Bun.env.MARS_WINDOWS_CONTAINER_PREFIX ?? "mars", bootstrapRoot: Bun.env.ProgramData ? `${Bun.env.ProgramData}\\Mars\\leases` : "C:\\ProgramData\\Mars\\leases", limits, readyTimeoutMs: Number(Bun.env.MARS_WINDOWS_CONTAINER_READY_TIMEOUT_MS ?? 15_000), allowLocalImage: Bun.env.MARS_ALLOW_LOCAL_CONTAINER_IMAGE === "true", imageManifestPath: Bun.env.MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST, requireLocalImageManifest: !/@sha256:[0-9a-f]{64}$/.test(image), dnsServers: parseWindowsContainerDnsServers(Bun.env.MARS_WINDOWS_CONTAINER_DNS_SERVERS) });
  }
  if (selected === "windows-hyperv") {
    const checkpointPath = Bun.env.MARS_WINDOWS_CHECKPOINT_PATH, checkpointDigest = Bun.env.MARS_WINDOWS_CHECKPOINT_DIGEST;
    if (!checkpointPath || !checkpointDigest) throw new Error("Windows Hyper-V checkpoint path and digest are required");
    return new HyperVDriver(createHyperVRuntime(), checkpointPath, checkpointDigest, Bun.env.MARS_HYPERV_VM_PREFIX ?? "mars", limits);
  }
  if (selected === "linux-docker-container") {
    const arm = guestPlatform === "linux-arm64";
    const image = arm ? Bun.env.MARS_LINUX_ARM64_CONTAINER_IMAGE : Bun.env.MARS_LINUX_X64_CONTAINER_IMAGE;
    if (!image) throw new Error(`${arm ? "MARS_LINUX_ARM64_CONTAINER_IMAGE" : "MARS_LINUX_X64_CONTAINER_IMAGE"} is required`);
    return new LinuxContainerDriver({ image, prefix: `mars-windows-linux-${arm ? "arm64" : "x64"}`, network: Bun.env.MARS_LINUX_CONTAINER_NETWORK ?? `mars-linux-${arm ? "arm64" : "x64"}`, limits, architecture: arm ? "arm64" : "amd64", hostPlacement: "serialized-no-pin" });
  }
  return null;
}
type WindowsRuntimeDriver = Pick<RuntimeDriver, "reserveCapacity" | "createLease" | "stopLease" | "removeLease"> & { listContainerStatuses: () => Promise<WorkerContainerStatus[]>; reconcileOrphans: () => Promise<void> };
function emitWindowsWorkerEvent(workerId: string, leaseId: string | null, send: (workerEvent: WorkerEvent) => void, workerEvent: WorkerEvent): void {
  try {
    send(workerEvent);
  } catch (error) {
    console.error("Worker event delivery failed", { workerId, leaseId, type: workerEvent.type, error: error instanceof Error ? error.message : String(error) });
  }
}
export async function reconcileWindowsRuntime(identity: Pick<Identity, "preserveLeases">, driver: Pick<WindowsRuntimeDriver, "reconcileOrphans">): Promise<boolean> {
  if (identity.preserveLeases === true) return true;
  try {
    await driver.reconcileOrphans();
    return true;
  } catch (error) {
    console.error("Windows runtime unavailable; worker will report unavailable", error);
    return false;
  }
}
export function buildWindowsDoctorReport(input: { doctor: WorkerDoctorData; capacity: WorkerCapacityData; containers: WorkerContainerStatus[]; activeLeases: string[]; preserveLeases: boolean; hostPlatform: WindowsHostPlatform; versions?: { releaseVersion: string; contractVersion: string } }): WorkerDoctorReport {
  return WorkerDoctorReport.parse({
    hostPlatform: input.hostPlatform,
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
  hostPlatform?: WindowsHostPlatform,
): Promise<WorkerObservedConfiguration> {
  hostPlatform ??= await detectWindowsHostPlatform();
  const selectedDriver = payload.selectedDriver ?? legacyRuntimeDriver(hostPlatform, "container");
  if (payload.guestPlatforms.length !== 1 || selectedRuntimeDriver(hostPlatform, payload.guestPlatforms[0]!, selectedDriver) !== selectedDriver) throw new Error("worker configuration driver is incompatible with Windows");
  const observed = WorkerObservedConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms, selectedDriver, cache: payload.cache });
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
  if (!["tart.stop_lease", "windows-container.stop_lease", "hyperv.stop_lease", "linux-container.stop_lease"].includes(command.type) || !command.leaseId) throw new Error("Windows lease cleanup command invalid");
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
  const releaseAdmission = admitWorkerLease(bootstrap, active);
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
    releaseAdmission();
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
  limits: Limits;
  cache: WorkerCacheConfiguration;
  cacheService: Pick<ActionCacheService, "applyTtl" | "setRunnerCacheEnabled" | "setRunnerCacheMaxGiB" | "purgeRunnerCache" | "transport" | "unregisterLease">;
  driver: WindowsRuntimeDriver;
  applyDriver?: (selected: RuntimeSelection, guestPlatform: string) => Promise<void>;
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
  const { limits, cache, cacheService, driver, applyDriver, identity, activeLeases, acceptingLeases, send, sendDoctor } = context;
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
    try {
      if (activeLeases.size) throw new Error("Cannot change Windows runtime while leases are active");
      const selectedDriver = payload.selectedDriver ?? legacyRuntimeDriver("windows-x64", "container");
      const capabilities = (await windowsDoctor(identity.preserveLeases === true)).capabilities ?? [];
      const capability = capabilities.find((entry) => entry.driver === selectedDriver && entry.guestPlatform === payload.guestPlatforms[0]);
      if (!isRuntimeSelection(selectedDriver)) throw new Error("Selected Windows runtime driver is unsupported");
      if (!capability?.ready) throw new Error("Selected Windows runtime capability is not ready");
      const observed = await applyWindowsWorkerConfiguration(limits, cache, payload, cacheService);
      if (identity.selectedDriver !== selectedDriver || identity.guestPlatform !== payload.guestPlatforms[0]) {
        if (!applyDriver) throw new Error("Runtime driver switching is unavailable");
        await applyDriver(selectedDriver, payload.guestPlatforms[0]!);
      }
      identity.selectedDriver = selectedDriver;
      identity.guestPlatform = payload.guestPlatforms[0];
      await save(identity);
      send(event(command.workerId, "worker.configured", { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed }));
      sendDoctor();
    } catch (error) {
      send(event(command.workerId, "worker.configuration_failed", { commandId: command.id, workerId: command.workerId, revision: payload.revision, reason: normalizedError(error) }));
    }
    return;
  }
  if (command.type === "worker.runner_cache_purge") {
    return send(await applyWindowsRunnerCachePurge(command, cacheService));
  }
  if (command.type === "worker.build_image") {
    await buildWindowsImage(command, send);
    sendDoctor();
    return;
  }
  if (command.type === "tart.stop_lease" || command.type === "windows-container.stop_lease" || command.type === "hyperv.stop_lease" || command.type === "linux-container.stop_lease") {
    const expectedStop = identity.selectedDriver === "windows-hyperv" ? "hyperv.stop_lease" : identity.selectedDriver === "linux-docker-container" ? "linux-container.stop_lease" : "windows-container.stop_lease";
    if (command.type !== expectedStop) throw new Error(`Selected Windows runtime rejects ${command.type}`);
    return runWindowsLeaseCleanup(command, driver, send, identity.preserveLeases === true, sendDoctor);
  }
  if (command.type === "windows-container.create_lease" || command.type === "hyperv.create_lease" || command.type === "linux-container.create_lease") {
    const expectedType = identity.selectedDriver === "windows-hyperv" ? "hyperv.create_lease" : identity.selectedDriver === "linux-docker-container" ? "linux-container.create_lease" : "windows-container.create_lease";
    if (command.type !== expectedType || !identity.selectedDriver) throw new Error(`Selected Windows runtime rejects ${command.type}`);
    const cipher = (command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] }).bootstrapCiphertext;
    if (!cipher) throw new Error("lease bootstrap payload invalid");
    const bootstrap: LeaseBootstrapEnvelope = openLeaseBootstrap(cipher, identity.encryptionPrivateKey);
    if (bootstrap.guestPlatform !== identity.guestPlatform) throw new Error("Lease guest platform does not match selected Windows runtime");
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
  let selectedDriver = (identity.selectedDriver as RuntimeSelection | undefined) ?? (Bun.env.MARS_WINDOWS_RUNTIME === "container" ? "windows-hyperv-container" : Bun.env.MARS_WINDOWS_RUNTIME === "vm" ? "windows-hyperv" : undefined);
  const hostPlatform = await detectWindowsHostPlatform();
  if (hostPlatform === "windows-arm64" && (selectedDriver === "windows-hyperv" || selectedDriver === "windows-hyperv-container" || selectedDriver === "windows-process-container")) {
    selectedDriver = undefined;
    delete identity.selectedDriver;
    delete identity.guestPlatform;
    await save(identity);
  }
  if (!identity.selectedDriver && selectedDriver) {
    const report = await windowsDoctor(identity.preserveLeases === true, commandSucceeds, selectedDriver);
    const ready = report.capabilities?.find(capability => capability.driver === selectedDriver && capability.ready);
    if (ready) {
      identity.selectedDriver = selectedDriver;
      identity.guestPlatform = ready.guestPlatform;
      await save(identity);
    } else selectedDriver = undefined;
  }
  let activeDriver = createSelectedWindowsDriver(selectedDriver, limits, identity.guestPlatform);
  const driver: WindowsRuntimeDriver = {
    reserveCapacity: async resources => { if (!activeDriver) throw new Error("Worker is discovery-only"); return activeDriver.reserveCapacity(resources); },
    createLease: async lease => { if (!activeDriver) throw new Error("Worker is discovery-only"); return activeDriver.createLease(lease); },
    stopLease: async leaseId => { if (activeDriver) await activeDriver.stopLease(leaseId); },
    removeLease: async leaseId => { if (activeDriver) await activeDriver.removeLease(leaseId); },
    listContainerStatuses: async () => {
      if (!activeDriver) return [];
      try { return await activeDriver.listContainerStatuses(); }
      catch (error) {
        console.error("Windows runtime container inventory unavailable", error);
        return [];
      }
    },
    reconcileOrphans: async () => { if (activeDriver) await activeDriver.reconcileOrphans(); },
  };
  const applyDriver = async (next: RuntimeSelection, guestPlatform: string) => {
    await driver.reconcileOrphans();
    const replacement = createSelectedWindowsDriver(next, limits, guestPlatform);
    if (!replacement) throw new Error("Selected Windows runtime driver could not be created");
    await replacement.reconcileOrphans();
    activeDriver = replacement;
  };
  if (selectedDriver) await reconcileWindowsRuntime(identity, driver);
  if (!identity.workerId) identity = await enroll(controlPlane, identity);
  const pickupState = await openLeasePickupState(leasePickupStateFile());
  const activeLeases = new Map<string, Promise<void>>();
  const eventTransport = new WorkerEventTransport(() => cacheService.runnerCacheStatus().enabled);
  const developmentConsole = Bun.env.MARS_DEV_WORKER_CONSOLE_LOGS === "true";
  const publishInventory = () => { void writeLeasePickupState(leasePickupStateFile(), pickupState.acceptingLeases, activeLeases.size); };
  const sendDoctor = async (ws: WebSocket): Promise<void> => {
    publishInventory();
    try {
      const [currentDoctor, currentCapacity, containers] = await Promise.all([windowsDoctor(identity.preserveLeases === true, commandSucceeds, identity.selectedDriver as RuntimeSelection | undefined, hostPlatform), capacity(), driver.listContainerStatuses()]);
      const report = buildWindowsDoctorReport({
        doctor: { ...currentDoctor, inventoryObservedAt: new Date().toISOString(), acceptingLeases: pickupState.acceptingLeases },
        capacity: currentCapacity,
        containers,
        activeLeases: [...activeLeases.keys()],
        preserveLeases: identity.preserveLeases === true,
        hostPlatform,
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
                limits,
                cache,
                cacheService,
                driver,
                applyDriver,
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
