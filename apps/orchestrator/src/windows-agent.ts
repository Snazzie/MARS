import { generateKeyPairSync, sign as signMessage, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { WorkerBootstrapRequest, WorkerBuildImagePayload, WorkerCacheConfiguration, WorkerCommand, WorkerConfigurePayload, WorkerObservedConfiguration, WorkerRunnerCachePurgePayload, WorkerDoctorData, WorkerDoctorReport, WorkerEvent, type WorkerCapacityData, type WorkerContainerStatus, type LeaseBootstrapEnvelope } from "@mars/contracts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { createHyperVRuntime, HyperVDriver } from "./hyperv.ts";
import { WindowsContainerDriver, isExpectedWindowsEntrypoint, parseWindowsContainerDnsServers } from "./windows-container.ts";
import { downloadWindowsImageBuildArtifacts } from "./windows-image-build.ts";
import type { RuntimeDriver } from "./runtime.ts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";
import { emitActionCacheSnapshot, startActionCacheService, type ActionCacheService } from "./action-cache/service.ts";
import { retryControlPlaneOperation } from "./worker-client.ts";

type Limits = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
type Identity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string; vmUuid?: string; machineUuid?: string; preserveLeases?: boolean };
const identityPath = () => Bun.env.MARS_WORKER_IDENTITY_FILE ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Mars", "worker-identity.json");
const event = (workerId: string, type: string, payload: Record<string, unknown>): WorkerEvent => WorkerEvent.parse({ version: 1, id: randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });
const keys = () => { const signing = generateKeyPairSync("ed25519"), encryption = generateKeyPairSync("x25519"); return { workerId: "", publicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(), privateKey: signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString(), encryptionPrivateKey: encryption.privateKey.export({ format: "pem", type: "pkcs8" }).toString() }; };
const machineUuid = async () => { if (Bun.env.MARS_MACHINE_UUID) return Bun.env.MARS_MACHINE_UUID; const process = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"], { stdout: "pipe" }); return (await new Response(process.stdout).text()).trim(); };
const createIdentity = async (): Promise<Identity> => ({ ...keys(), vmUuid: Bun.env.MARS_VM_UUID ?? randomUUID(), machineUuid: await machineUuid() });
const runPowerShellJson = async (command: string): Promise<Record<string, number>> => { const process = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], { stdout: "pipe", stderr: "pipe" }); const output = (await new Response(process.stdout).text()).trim(); if (await process.exited !== 0) throw new Error(`Windows capacity query failed: ${output}`); const value = JSON.parse(output) as Record<string, number>; if (Object.values(value).some((entry) => !Number.isFinite(entry) || entry <= 0)) throw new Error("Windows capacity query returned invalid values"); return value; };
const capacity = async (): Promise<WorkerCapacityData> => {
  const value = await runPowerShellJson("$system=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop; $cpu=(Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; $available=(Get-Counter '\\Memory\\Available Bytes' -ErrorAction Stop).CounterSamples[0].CookedValue; $disk=Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object DeviceID -eq 'C:'; if (-not $disk) { throw 'C: drive not found' }; [pscustomobject]@{vcpu=[double]$cpu; memory=[double]$system.TotalPhysicalMemory; freeMemory=[double]$available; storage=[double]$disk.Size; freeStorage=[double]$disk.FreeSpace} | ConvertTo-Json -Compress");
  return { actualVcpu: value.vcpu, freeVcpu: value.vcpu, actualMemoryBytes: value.memory, freeMemoryBytes: value.freeMemory, actualStorageBytes: value.storage, freeStorageBytes: value.freeStorage };
};
const commandSucceeds = async (command: string[]): Promise<boolean> => {
  try {
    const process = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    return await process.exited === 0;
  } catch {
    return false;
  }
};
const localImageVerification = async (image: string): Promise<{ manifest: boolean; entrypoint: boolean; imageId?: string }> => {
  if (image !== "mars/windows-job:local") return { manifest: false, entrypoint: false };
  const path = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Mars", "windows-job-image.json");
  try {
    const manifest = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) as { schemaVersion?: number; image?: string; imageId?: string; runtimeProbe?: { mediaFoundation?: boolean; dns?: boolean; tcp443?: boolean } };
    if (manifest.schemaVersion !== 1 || manifest.image !== image || !manifest.imageId || !manifest.runtimeProbe?.mediaFoundation || !manifest.runtimeProbe.dns || !manifest.runtimeProbe.tcp443) return { manifest: false, entrypoint: false };
    const imageIdProcess = Bun.spawn(["docker.exe", "image", "inspect", "--format", "{{.Id}}", image], { stdout: "pipe", stderr: "ignore" });
    const imageId = (await new Response(imageIdProcess.stdout).text()).trim();
    if (await imageIdProcess.exited !== 0 || imageId !== manifest.imageId) return { manifest: false, entrypoint: false };
    const entrypointProcess = Bun.spawn(["docker.exe", "image", "inspect", "--format", "{{json .}}", image], { stdout: "pipe", stderr: "ignore" });
    const imageInspection = JSON.parse((await new Response(entrypointProcess.stdout).text()).trim()) as { Config?: { Entrypoint?: unknown } };
    return { manifest: true, entrypoint: (await entrypointProcess.exited) === 0 && isExpectedWindowsEntrypoint(imageInspection.Config?.Entrypoint), imageId };
  } catch {
    return { manifest: false, entrypoint: false };
  }
};
export const windowsDoctor = async (preserveLeases = false): Promise<WorkerDoctorData> => {
  const runtimeMode = Bun.env.MARS_WINDOWS_RUNTIME === "container" ? "container" : "vm";
  const artifactValue = runtimeMode === "container" ? Bun.env.MARS_WINDOWS_CONTAINER_IMAGE : Bun.env.MARS_WINDOWS_TEMPLATE_DIGEST;
  const localVerification = runtimeMode === "container" ? await localImageVerification(artifactValue ?? "") : { manifest: false, entrypoint: true };
  const localManifest = localVerification.manifest;
  const immutableArtifact = localManifest || (typeof artifactValue === "string" && /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/i.test(artifactValue));
  const probe = runtimeMode === "container"
    ? await commandSucceeds(["docker.exe", "info", "--format", "{{.OSType}}"])
    : await commandSucceeds(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-VMHost -ErrorAction Stop | Out-Null"]);
  let egress = false;
  try {
    const response = await fetch("https://api.github.com/meta", { signal: AbortSignal.timeout(5_000), headers: { "user-agent": "mars-worker-doctor" } });
    egress = response.ok;
  } catch {
    egress = false;
  }
  const failures = [
    !probe && `${runtimeMode === "container" ? "Windows container host" : "Hyper-V host"} probe failed`,
    !egress && "GitHub egress probe failed",
    !immutableArtifact && "Verified Windows container image manifest is missing or stale",
    runtimeMode === "container" && localManifest && !localVerification.entrypoint && "Windows container image entrypoint is invalid",
  ].filter((failure): failure is string => Boolean(failure));
  const artifactDigest = localVerification.imageId ?? (typeof artifactValue === "string" && /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/i.test(artifactValue) ? artifactValue : undefined);
  return WorkerDoctorData.parse({ runtimeMode, preserveLeases, ...(runtimeMode === "container" ? { artifactSource: "worker_local", ...(artifactValue ? { artifactIdentity: artifactValue } : {}) } : { artifactSource: "template", ...(artifactDigest ? { artifactDigest } : {}) }), ...(artifactDigest ? { artifactDigest } : {}), runtimeReady: failures.length === 0, probe, egress, imageSignatures: immutableArtifact, remediation: failures.length ? failures.join("; ") : null });
};
const joinCode = async () => { const path = Bun.env.MARS_JOIN_CODE_FILE; if (path) return (await readFile(path, "utf8")).trim(); const reader = Bun.stdin.stream().getReader(); const { value } = await reader.read(); reader.releaseLock(); return Buffer.from(value ?? []).toString("utf8").trim(); };
const save = async (identity: Identity) => { const path = identityPath(); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(identity) + "\n", { mode: 0o600 }); };
const load = async () => { try { return JSON.parse(await readFile(identityPath(), "utf8")) as Identity; } catch { return null; } };
const auth = (nonce: string, identity: Identity) => ({ type: "authenticate", workerId: identity.workerId, encryptionPublicKey: identity.encryptionPublicKey, signature: signMessage(null, Buffer.from(`${nonce}\n${identity.workerId}\n${identity.encryptionPublicKey}`), identity.privateKey).toString("base64url") });
async function runProcess(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  return { code: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
}
async function runDocker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess(["docker.exe", ...args]);
}
export async function buildWindowsImage(command: WorkerCommand, send: (event: WorkerEvent) => void): Promise<void> {
  const payload = WorkerBuildImagePayload.parse(command.payload);
  const root = await mkdtemp(join(Bun.env.ProgramData ?? "C:\\ProgramData", "Mars", "image-build-"));
  let failureStage = "receive_payload";
  console.log("Windows image build command received", { workerId: command.workerId, commandId: command.id, buildId: payload.buildId, image: payload.image, contentSha256: payload.contentSha256 });
  try {
    failureStage = "download_artifacts";
    const paths = await downloadWindowsImageBuildArtifacts(payload, root);
    const manifestPath = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Mars", "windows-job-image.json");
    failureStage = "build_and_probe";
    const built = await runProcess([
      "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.builder,
      "-BaseImage", payload.baseImage,
      "-RunnerUrl", payload.runner.url, "-RunnerSha256", payload.runner.sha256,
      "-GitUrl", payload.git.url, "-GitSha256", payload.git.sha256,
      "-VcRuntimeUrl", payload.vcRuntime.url, "-VcRuntimeSha256", payload.vcRuntime.sha256,
      "-JobAgent", paths.jobAgent, "-Image", payload.image, "-ManifestPath", manifestPath,
      "-VerifierPath", paths.verifier, "-ContainerfilePath", paths.containerfile, "-EntrypointPath", paths.entrypoint,
    ]);
    if (built.code !== 0) throw new Error((built.stderr || built.stdout).trim().slice(0, 1000) || `image builder exited ${built.code}`);
    failureStage = "inspect_image";
    const imageInspection = await runDocker(["image", "inspect", "--format", "{{json .}}", payload.image]);
    if (imageInspection.code !== 0) throw new Error(imageInspection.stderr.trim().slice(0, 1000) || "docker image inspect failed");
    const inspected = JSON.parse(imageInspection.stdout.trim()) as { Config?: { Entrypoint?: unknown }; Id?: string };
    if (!inspected.Id || !isExpectedWindowsEntrypoint(inspected.Config?.Entrypoint)) throw new Error("Windows image entrypoint is invalid");
    failureStage = "verify_manifest";
    const manifest = JSON.parse(await readFile(manifestPath, "utf8").then((value) => value.replace(/^\uFEFF/, ""))) as { image?: string; imageId?: string; runtimeProbe?: { mediaFoundation?: boolean; dns?: boolean; tcp443?: boolean } };
    if (manifest.image !== payload.image || manifest.imageId !== inspected.Id || !manifest.runtimeProbe?.mediaFoundation || !manifest.runtimeProbe.dns || !manifest.runtimeProbe.tcp443) throw new Error("Windows image manifest does not match the verified image");
    console.log("Windows image build verified", { workerId: command.workerId, commandId: command.id, buildId: payload.buildId, image: payload.image, imageId: inspected.Id, contentSha256: payload.contentSha256 });
    send(event(command.workerId, "worker.build_completed", { commandId: command.id, buildId: payload.buildId, image: payload.image, imageId: inspected.Id, contentSha256: payload.contentSha256, runtimeReady: true, message: "Local image built and runtime probe passed" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Windows image build failed", { workerId: command.workerId, commandId: command.id, buildId: payload.buildId, image: payload.image, contentSha256: payload.contentSha256, failureStage, error: message });
    send(event(command.workerId, "worker.build_failed", { commandId: command.id, buildId: payload.buildId, image: payload.image, contentSha256: payload.contentSha256, runtimeReady: false, failureStage, message }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function enroll(baseUrl: URL, identity: Identity): Promise<Identity> {
  const vmUuid = identity.vmUuid ?? Bun.env.MARS_VM_UUID ?? randomUUID();
  const machine = identity.machineUuid ?? await machineUuid();
  const persisted = { ...identity, vmUuid, machineUuid: machine };
  await save(persisted);
  const payload = WorkerBootstrapRequest.parse({ code: await joinCode(), platform: "windows-x64", publicKey: persisted.publicKey, encryptionPublicKey: persisted.encryptionPublicKey, vmUuid, machineUuid: machine, doctor: await windowsDoctor(), capacity: await capacity() });
  const response = await retryControlPlaneOperation("worker enrollment", () => fetch(new URL("/api/workers/join", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
  if (!response.ok) throw new Error(`worker join failed: ${response.status}`);
  const joined = await response.json() as { workerId: string };
  const result = { ...persisted, workerId: joined.workerId };
  await save(result);
  return result;
}
type WindowsRuntimeDriver = Pick<RuntimeDriver, "reserveCapacity" | "createLease" | "stopLease" | "removeLease"> & { listContainerStatuses: () => Promise<WorkerContainerStatus[]>; reconcileOrphans?: () => Promise<void> };
export function buildWindowsDoctorReport(input: { doctor: WorkerDoctorData; capacity: WorkerCapacityData; containers: WorkerContainerStatus[]; activeLeases: string[]; preserveLeases: boolean }): WorkerDoctorReport {
  return WorkerDoctorReport.parse({
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
): Promise<void> {
  if (!["tart.stop_lease", "windows-container.stop_lease", "hyperv.stop_lease"].includes(command.type) || !command.leaseId) throw new Error("Windows lease cleanup command invalid");
  const nonce = String((command.payload as Record<string, unknown>).nonce ?? "");
  const payload = { commandId: command.id, leaseId: command.leaseId, nonce };
  if (command.type !== "tart.stop_lease" && preserveLeases) {
    send(event(command.workerId, "lease.failed", { ...payload, reason: "debug_preserve" }));
    return;
  }
  send(event(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId }));
  let cleanupFailed = false;
  try { await driver.stopLease(command.leaseId); } catch { cleanupFailed = true; }
  try { await driver.removeLease(command.leaseId); } catch { cleanupFailed = true; }
  send(event(command.workerId, cleanupFailed ? "lease.failed" : "lease.reaped", cleanupFailed
    ? { ...payload, reason: "cleanup_failed" }
    : payload));
}

export function startWindowsLeaseLifecycle(
  command: WorkerCommand,
  driver: Pick<RuntimeDriver, "createLease" | "stopLease" | "removeLease">,
  bootstrap: LeaseBootstrapEnvelope,
  send: (workerEvent: WorkerEvent) => void,
  active: Map<string, Promise<void>>,
  preserveLeases: () => boolean = () => false,
  cacheService?: Pick<ActionCacheService, "transport" | "unregisterLease">,
): Promise<void> {
  const existing = active.get(bootstrap.leaseId);
  if (existing) return existing;
  const lifecycle = runLeaseLifecycle(command, driver, bootstrap, send, { preserveLeases, cacheService }).finally(() => {
    if (active.get(bootstrap.leaseId) === lifecycle) active.delete(bootstrap.leaseId);
  });
  active.set(bootstrap.leaseId, lifecycle);
  return lifecycle;
}

async function runWindowsWorkerWithCache(baseUrl: string, limits: Limits, cache: WorkerCacheConfiguration, cacheService: ActionCacheService): Promise<never> {
  const controlPlane = new URL(baseUrl);
  let identity = await load();
  if (!identity) {
    identity = await createIdentity();
    await save(identity);
  }
  if (!identity.workerId) identity = await enroll(controlPlane, identity);
  const mode = Bun.env.MARS_WINDOWS_RUNTIME ?? "vm";
  let driver: WindowsRuntimeDriver;
  if (mode === "container") {
    const image = Bun.env.MARS_WINDOWS_CONTAINER_IMAGE;
    if (!image) throw new Error("MARS_WINDOWS_CONTAINER_IMAGE is required in container mode");
    driver = new WindowsContainerDriver({ image, prefix: Bun.env.MARS_WINDOWS_CONTAINER_PREFIX ?? "mars", bootstrapRoot: Bun.env.ProgramData ? `${Bun.env.ProgramData}\\Mars\\leases` : "C:\\ProgramData\\Mars\\leases", limits, readyTimeoutMs: Number(Bun.env.MARS_WINDOWS_CONTAINER_READY_TIMEOUT_MS ?? 15_000), jobTimeoutMs: Number(Bun.env.MARS_WINDOWS_CONTAINER_JOB_TIMEOUT_MS ?? 900_000), allowLocalImage: Bun.env.MARS_ALLOW_LOCAL_CONTAINER_IMAGE === "true", imageManifestPath: Bun.env.MARS_WINDOWS_CONTAINER_IMAGE_MANIFEST, requireLocalImageManifest: image === "mars/windows-job:local", dnsServers: parseWindowsContainerDnsServers(Bun.env.MARS_WINDOWS_CONTAINER_DNS_SERVERS) });
  } else if (mode === "vm") {
    const templatePath = Bun.env.MARS_WINDOWS_TEMPLATE_PATH;
    const templateDigest = Bun.env.MARS_WINDOWS_TEMPLATE_DIGEST;
    if (!templatePath || !templateDigest) throw new Error("Windows Hyper-V template path and digest are required in VM mode");
    driver = new HyperVDriver(createHyperVRuntime(), templatePath, templateDigest, Bun.env.MARS_HYPERV_VM_PREFIX ?? "mars", limits);
  } else {
    throw new Error(`Unsupported Windows runtime: ${mode}`);
  }
  let doctorReport = await windowsDoctor(identity.preserveLeases === true);
  const activeLeases = new Map<string, Promise<void>>();
  const sendDoctor = async (ws: WebSocket): Promise<void> => {
    try {
      const [currentCapacity, containers] = await Promise.all([capacity(), driver.listContainerStatuses()]);
      const report = buildWindowsDoctorReport({
        doctor: doctorReport,
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
      const ws = new WebSocket(url);
      const closed = Promise.withResolvers<void>();
      ws.onclose = () => closed.resolve();
      ws.onerror = () => ws.close();
      ws.onmessage = async (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as Record<string, unknown>;
          if (frame.type === "challenge") return ws.send(JSON.stringify(auth(String(frame.nonce), identity)));
          if (frame.type === "authenticated") {
            if (Bun.env.MARS_JOIN_CODE_FILE) await unlink(Bun.env.MARS_JOIN_CODE_FILE).catch(() => {});
            await emitActionCacheSnapshot(cacheService, (type, payload) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event(identity.workerId, type, payload)));
            });
            await sendDoctor(ws);
            return;
          }
          if (frame.type === "ping") {
            ws.send(JSON.stringify({ version: 1, type: "pong", workerId: identity.workerId }));
            await sendDoctor(ws);
            return;
          }
          if (frame.type === "doctor_ack") return;
          const command = WorkerCommand.parse(frame);
          if (command.type === "worker.set_lease_preservation") {
            const enabled = (command.payload as Record<string, unknown>).enabled;
            if (typeof enabled !== "boolean") throw new Error("lease preservation command invalid");
            identity.preserveLeases = enabled;
            await save(identity);
            return ws.send(JSON.stringify(event(command.workerId, "command.accepted", { commandId: command.id, leaseId: null })));
          }
          if (command.type === "worker.configure") {
            const payload = WorkerConfigurePayload.parse(command.payload);
            const observed = await applyWindowsWorkerConfiguration(limits, cache, payload, cacheService);
            return ws.send(JSON.stringify(event(command.workerId, "worker.configured", { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed })));
          }
          if (command.type === "worker.runner_cache_purge") return ws.send(JSON.stringify(await applyWindowsRunnerCachePurge(command, cacheService)));
          if (command.type === "worker.build_image") {
            await buildWindowsImage(command, workerEvent => ws.send(JSON.stringify(workerEvent)));
            doctorReport = await windowsDoctor(identity.preserveLeases === true);
            return;
          }
          if (command.type === "tart.stop_lease" || command.type === "windows-container.stop_lease" || command.type === "hyperv.stop_lease") {
            await runWindowsLeaseCleanup(command, driver, workerEvent => ws.send(JSON.stringify(workerEvent)), identity.preserveLeases === true);
            return;
          }
          if (command.type === "windows-container.create_lease" || command.type === "hyperv.create_lease") {
            const expectedType = mode === "container" ? "windows-container.create_lease" : "hyperv.create_lease";
            if (command.type !== expectedType) throw new Error(`Windows runtime mode ${mode} rejects ${command.type}`);
            const cipher = (command.payload as { bootstrapCiphertext?: Parameters<typeof openLeaseBootstrap>[0] }).bootstrapCiphertext;
            if (!cipher || !command.leaseId) throw new Error("lease bootstrap payload invalid");
            const bootstrap: LeaseBootstrapEnvelope = openLeaseBootstrap(cipher, identity.encryptionPrivateKey);
            if (bootstrap.leaseId !== command.leaseId || (mode === "container" ? bootstrap.guestPlatform !== "windows-x64" : !["windows-x64", "linux-x64"].includes(bootstrap.guestPlatform))) throw new Error("Windows lease bootstrap mismatch");
            ws.send(JSON.stringify(event(command.workerId, "command.accepted", { commandId: command.id, leaseId: command.leaseId })));
            void startWindowsLeaseLifecycle(command, driver, bootstrap, workerEvent => ws.send(JSON.stringify(workerEvent)), activeLeases, () => identity.preserveLeases === true, cacheService);
          }
        } catch (error) {
          console.error("Windows worker command failed", error);
          ws.close(1011, "worker command failed");
        }
      };
      await closed.promise;
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
