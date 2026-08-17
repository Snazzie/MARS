import { generateKeyPairSync, sign as signMessage, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkerBootstrapRequest, WorkerCommand, WorkerConfigurePayload, WorkerConfiguration, WorkerDoctorData, WorkerEvent, type WorkerCapacityData, type LeaseBootstrapEnvelope } from "@whitesmith/contracts";
import { openLeaseBootstrap } from "../../control-plane/src/lease-dispatch.ts";
import { createHyperVRuntime, HyperVDriver } from "./hyperv.ts";
import { WindowsContainerDriver } from "./windows-container.ts";
import type { RuntimeDriver } from "./runtime.ts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";

type Limits = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
type Identity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string };
const identityPath = () => Bun.env.WHITESMITH_WORKER_IDENTITY_FILE ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Whitesmith", "worker-identity.json");
const event = (workerId: string, type: string, payload: Record<string, unknown>): WorkerEvent => WorkerEvent.parse({ version: 1, id: randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });
const keys = () => { const signing = generateKeyPairSync("ed25519"), encryption = generateKeyPairSync("x25519"); return { workerId: "", publicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(), privateKey: signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), encryptionPublicKey: encryption.publicKey.export({ format: "pem", type: "spki" }).toString(), encryptionPrivateKey: encryption.privateKey.export({ format: "pem", type: "pkcs8" }).toString() }; };
const machineUuid = async () => { const process = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"], { stdout: "pipe" }); return (await new Response(process.stdout).text()).trim(); };
const runPowerShellJson = async (command: string): Promise<Record<string, number>> => { const process = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], { stdout: "pipe", stderr: "pipe" }); const output = (await new Response(process.stdout).text()).trim(); if (await process.exited !== 0) throw new Error(`Windows capacity query failed: ${output}`); const value = JSON.parse(output) as Record<string, number>; if (Object.values(value).some((entry) => !Number.isFinite(entry) || entry <= 0)) throw new Error("Windows capacity query returned invalid values"); return value; };
const capacity = async (): Promise<WorkerCapacityData> => {
  const value = await runPowerShellJson("$system=Get-CimInstance Win32_ComputerSystem -ErrorAction Stop; $cpu=(Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; $os=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop; $disk=Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object DeviceID -eq 'C:'; if (-not $disk) { throw 'C: drive not found' }; [pscustomobject]@{vcpu=[double]$cpu; memory=[double]$system.TotalPhysicalMemory; freeMemory=[double]$os.FreePhysicalMemory * 1024; storage=[double]$disk.Size; freeStorage=[double]$disk.FreeSpace} | ConvertTo-Json -Compress");
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
const localImageManifestVerified = async (image: string): Promise<boolean> => {
  if (image !== "whitesmith/windows-job:local") return false;
  const path = Bun.env.WHITESMITH_WINDOWS_CONTAINER_IMAGE_MANIFEST ?? join(Bun.env.ProgramData ?? "C:\\ProgramData", "Whitesmith", "windows-job-image.json");
  try {
    const manifest = JSON.parse(await readFile(path, "utf8")) as { schemaVersion?: number; image?: string; imageId?: string; runtimeProbe?: { mediaFoundation?: boolean; dns?: boolean; tcp443?: boolean } };
    if (manifest.schemaVersion !== 1 || manifest.image !== image || !manifest.imageId || !manifest.runtimeProbe?.mediaFoundation || !manifest.runtimeProbe.dns || !manifest.runtimeProbe.tcp443) return false;
    const process = Bun.spawn(["docker.exe", "image", "inspect", "--format", "{{.Id}}", image], { stdout: "pipe", stderr: "ignore" });
    return (await process.exited) === 0 && (await new Response(process.stdout).text()).trim() === manifest.imageId;
  } catch {
    return false;
  }
};
export const windowsDoctor = async (): Promise<WorkerDoctorData> => {
  const runtimeMode = Bun.env.WHITESMITH_WINDOWS_RUNTIME === "container" ? "container" : "vm";
  const artifactDigest = runtimeMode === "container" ? Bun.env.WHITESMITH_WINDOWS_CONTAINER_IMAGE : Bun.env.WHITESMITH_WINDOWS_TEMPLATE_DIGEST;
  const localManifest = runtimeMode === "container" ? await localImageManifestVerified(artifactDigest ?? "") : false;
  const immutableArtifact = localManifest || (typeof artifactDigest === "string" && /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/i.test(artifactDigest));
  const probe = runtimeMode === "container"
    ? await commandSucceeds(["docker.exe", "info", "--format", "{{.OSType}}"])
    : await commandSucceeds(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-VMHost -ErrorAction Stop | Out-Null"]);
  let egress = false;
  try {
    const response = await fetch("https://api.github.com/meta", { signal: AbortSignal.timeout(5_000), headers: { "user-agent": "whitesmith-worker-doctor" } });
    egress = response.ok;
  } catch {
    egress = false;
  }
  const failures = [!probe && `${runtimeMode === "container" ? "Windows container host" : "Hyper-V host"} probe failed`, !egress && "GitHub egress probe failed", !immutableArtifact && "Verified Windows container image manifest is missing"].filter(Boolean);
  return WorkerDoctorData.parse({ runtimeMode, ...(artifactDigest && immutableArtifact ? { artifactDigest } : {}), probe, egress, imageSignatures: immutableArtifact, remediation: failures.length ? failures.join("; ") : null });
};
const joinCode = async () => { const path = Bun.env.WHITESMITH_JOIN_CODE_FILE; if (path) return (await readFile(path, "utf8")).trim(); const reader = Bun.stdin.stream().getReader(); const { value } = await reader.read(); reader.releaseLock(); return Buffer.from(value ?? []).toString("utf8").trim(); };
const save = async (identity: Identity) => { const path = identityPath(); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(identity) + "\n"); };
const load = async () => { try { return JSON.parse(await readFile(identityPath(), "utf8")) as Identity; } catch { return null; } };
const auth = (nonce: string, identity: Identity) => ({ type: "authenticate", workerId: identity.workerId, encryptionPublicKey: identity.encryptionPublicKey, signature: signMessage(null, Buffer.from(`${nonce}\n${identity.workerId}\n${identity.encryptionPublicKey}`), identity.privateKey).toString("base64url") });
async function enroll(baseUrl: URL, identity: Identity): Promise<Identity> { const payload = WorkerBootstrapRequest.parse({ code: await joinCode(), platform: "windows-x64", publicKey: identity.publicKey, encryptionPublicKey: identity.encryptionPublicKey, vmUuid: crypto.randomUUID(), machineUuid: await machineUuid(), doctor: await windowsDoctor(), capacity: await capacity() }); const response = await fetch(new URL("/api/workers/join", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }); if (!response.ok) throw new Error(`worker join failed: ${response.status}`); const joined = await response.json() as { workerId: string }; const result = { ...identity, workerId: joined.workerId }; await save(result); return result; }
type WindowsRuntimeDriver = Pick<RuntimeDriver, "reserveCapacity" | "createLease" | "stopLease" | "removeLease"> & { reconcileOrphans?: () => Promise<void> };
export function applyWindowsWorkerConfiguration(limits: Limits, payload: ReturnType<typeof WorkerConfigurePayload.parse>): ReturnType<typeof WorkerConfiguration.parse> {
  const observed = WorkerConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime, guestPlatforms: payload.guestPlatforms });
  Object.assign(limits, observed.runtime);
  return observed;
}


export async function runWindowsLeaseCleanup(
  command: WorkerCommand,
  driver: Pick<RuntimeDriver, "stopLease" | "removeLease">,
  send: (workerEvent: WorkerEvent) => void,
): Promise<void> {
  if (command.type !== "tart.stop_lease" || !command.leaseId) throw new Error("Windows lease cleanup command invalid");
  const nonce = String((command.payload as Record<string, unknown>).nonce ?? "");
  const payload = { commandId: command.id, leaseId: command.leaseId, nonce };
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
): Promise<void> {
  const existing = active.get(bootstrap.leaseId);
  if (existing) return existing;
  const lifecycle = runLeaseLifecycle(command, driver, bootstrap, send).finally(() => {
    if (active.get(bootstrap.leaseId) === lifecycle) active.delete(bootstrap.leaseId);
  });
  active.set(bootstrap.leaseId, lifecycle);
  return lifecycle;
}

export async function runWindowsWorker(baseUrl: string, limits: Limits): Promise<never> {
  const controlPlane = new URL(baseUrl);
  const identity = (await load()) ?? await enroll(controlPlane, keys());
  const mode = Bun.env.WHITESMITH_WINDOWS_RUNTIME ?? "vm";
  let driver: WindowsRuntimeDriver;
  if (mode === "container") {
    const image = Bun.env.WHITESMITH_WINDOWS_CONTAINER_IMAGE;
    if (!image) throw new Error("WHITESMITH_WINDOWS_CONTAINER_IMAGE is required in container mode");
    driver = new WindowsContainerDriver({ image, prefix: Bun.env.WHITESMITH_WINDOWS_CONTAINER_PREFIX ?? "whitesmith", bootstrapRoot: Bun.env.ProgramData ? `${Bun.env.ProgramData}\\Whitesmith\\leases` : "C:\\ProgramData\\Whitesmith\\leases", limits, readyTimeoutMs: Number(Bun.env.WHITESMITH_WINDOWS_CONTAINER_READY_TIMEOUT_MS ?? 15_000), jobTimeoutMs: Number(Bun.env.WHITESMITH_WINDOWS_CONTAINER_JOB_TIMEOUT_MS ?? 900_000), allowLocalImage: Bun.env.WHITESMITH_ALLOW_LOCAL_CONTAINER_IMAGE === "true", imageManifestPath: Bun.env.WHITESMITH_WINDOWS_CONTAINER_IMAGE_MANIFEST, requireLocalImageManifest: image === "whitesmith/windows-job:local" });
  } else if (mode === "vm") {
    const templatePath = Bun.env.WHITESMITH_WINDOWS_TEMPLATE_PATH;
    const templateDigest = Bun.env.WHITESMITH_WINDOWS_TEMPLATE_DIGEST;
    if (!templatePath || !templateDigest) throw new Error("Windows Hyper-V template path and digest are required in VM mode");
    driver = new HyperVDriver(createHyperVRuntime(), templatePath, templateDigest, Bun.env.WHITESMITH_HYPERV_VM_PREFIX ?? "whitesmith", limits);
  } else {
    throw new Error(`Unsupported Windows runtime: ${mode}`);
  }
  await driver.reserveCapacity({ vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 });
  await driver.reconcileOrphans?.();
  const doctorReport = await windowsDoctor();
  const capacityReport = await capacity();
  const activeLeases = new Map<string, Promise<void>>();
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
          if (frame.type === "authenticated") return ws.send(JSON.stringify({ version: 1, type: "doctor", workerId: identity.workerId, payload: { doctor: doctorReport, capacity: capacityReport } }));
          if (["doctor_ack", "ping"].includes(String(frame.type))) return;
          const command = WorkerCommand.parse(frame);
          if (command.type === "worker.configure") {
            const payload = WorkerConfigurePayload.parse(command.payload);
            const observed = applyWindowsWorkerConfiguration(limits, payload);
            return ws.send(JSON.stringify(event(command.workerId, "worker.configured", { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed })));
          }
          if (command.type === "tart.stop_lease") {
            await runWindowsLeaseCleanup(command, driver, workerEvent => ws.send(JSON.stringify(workerEvent)));
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
            void startWindowsLeaseLifecycle(command, driver, bootstrap, workerEvent => ws.send(JSON.stringify(workerEvent)), activeLeases);
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
