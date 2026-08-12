import { generateKeyPairSync } from "node:crypto";
import { statfsSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import type { WorkerCapacityData, WorkerCommand, WorkerDoctorData } from "@whitesmith/contracts";
import { WorkerBootstrapRequest, WorkerConfigurePayload, WorkerConfiguration } from "@whitesmith/contracts";
import type { Lease } from "./runtime.ts";
import { createTartVmRuntime, TartVmDriver } from "./tart.ts";

export interface MacWorkerLimits { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number }
export interface MacWorkerJoinInput {
  code: string;
  publicKey: string;
  vmUuid: string;
  machineUuid: string;
  doctor: WorkerDoctorData;
  capacity: WorkerCapacityData;
}
export type MacWorkerJoinPayload = MacWorkerJoinInput & { platform: "macos-arm64" };
export function applyWorkerConfigure(command: WorkerCommand, limits: MacWorkerLimits): { version: 1; type: "worker.configured"; workerId: string; leaseId: null; payload: Record<string, unknown> } {
  const payload = WorkerConfigurePayload.parse(command.payload);
  const observed = WorkerConfiguration.parse({ appliance: payload.appliance, runtime: payload.runtime });
  Object.assign(limits, payload.runtime);
  return { version: 1, type: "worker.configured", workerId: command.workerId, leaseId: null, payload: { commandId: command.id, workerId: command.workerId, revision: payload.revision, observed } };
}
export function buildMacWorkerJoinPayload(input: MacWorkerJoinInput): MacWorkerJoinPayload {
  return { code: input.code, publicKey: input.publicKey, vmUuid: input.vmUuid, machineUuid: input.machineUuid, doctor: input.doctor, capacity: input.capacity, platform: "macos-arm64" };
}
export function buildMacWorkerSocketUrl(base: string, workerId: string): string { const url = new URL(base); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/api/v1/workers/connect"; url.search = new URLSearchParams({ workerId }).toString(); return url.toString(); }
export async function handleMacWorkerCommand(command: WorkerCommand, driver: TartVmDriver, limits?: MacWorkerLimits): Promise<{ version: 1; type: string; workerId: string; leaseId: string | null; payload: Record<string, unknown> }> { if (command.type === "worker.configure") { if (!limits) throw new Error("worker limits unavailable"); return applyWorkerConfigure(command, limits); } if (command.type === "tart.create_lease") { const lease = command.payload as unknown as Lease; const runtime = await driver.createLease(lease); return { version: 1, type: "sandbox_attested", workerId: command.workerId, leaseId: command.leaseId, payload: runtime as unknown as Record<string, unknown> }; } if (command.type === "tart.stop_lease" && command.leaseId) { await driver.stopLease(command.leaseId); return { version: 1, type: "lease_stopped", workerId: command.workerId, leaseId: command.leaseId, payload: {} }; } if (command.type === "tart.remove_lease" && command.leaseId) { await driver.removeLease(command.leaseId); return { version: 1, type: "lease_removed", workerId: command.workerId, leaseId: command.leaseId, payload: {} }; } throw new Error(`unsupported worker command ${command.type}`); }
function createKeyPair(): { privateKey: string; publicKey: string } { const pair = generateKeyPairSync("ed25519"); return { privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString() }; }
async function readJoinCode(): Promise<Buffer> { const reader = Bun.stdin.stream().getReader(); const { value } = await reader.read(); reader.releaseLock(); const code = Buffer.from(value ?? []); if (!code.toString("utf8").trim()) throw new Error("join code required on stdin"); return code; }
function capacity(): WorkerCapacityData {
  const disk = statfsSync("/", { bigint: true });
  const actualVcpu = cpus().length;
  return {
    actualVcpu,
    actualMemoryBytes: totalmem(),
    actualStorageBytes: Number(disk.blocks * disk.bsize),
    freeVcpu: actualVcpu,
    freeMemoryBytes: freemem(),
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
async function currentMacWorkerJoinPayload(code: string, publicKey: string): Promise<MacWorkerJoinPayload> {
  const machineUuid = await macMachineUuid();
  const resources = capacity();
  return WorkerBootstrapRequest.parse(buildMacWorkerJoinPayload({
    code,
    publicKey,
    machineUuid,
    vmUuid: (Bun.env.WHITESMITH_VM_UUID ?? machineUuid).toLowerCase(),
    doctor: { probe: true, egress: true, ...resources },
    capacity: resources,
  })) as MacWorkerJoinPayload;
}
function validateControlPlaneUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("control plane must use HTTPS (TLS 1.3) except explicit localhost development");
  return url;
}
export async function runWorkerJoin(platform: "macos-arm64" | "windows-x64", baseUrl: string): Promise<void> {
  if (platform !== "macos-arm64") throw new Error("Windows worker enrollment is not implemented");
  const controlPlane = validateControlPlaneUrl(baseUrl);
  const key = createKeyPair();
  const codeBytes = await readJoinCode();
  try {
    const payload = await currentMacWorkerJoinPayload(codeBytes.toString("utf8").trim(), key.publicKey);
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
  const key = createKeyPair();
  const driver = new TartVmDriver(createTartVmRuntime(), Bun.env.WHITESMITH_TART_BASE_IMAGE ?? "whitesmith-macos-worker", "whitesmith-job", limits);
  const codeBytes = await readJoinCode();
  try {
    const payload = await currentMacWorkerJoinPayload(codeBytes.toString("utf8").trim(), key.publicKey);
    const vmUuid = payload.vmUuid;
    const response = await fetch(new URL("/api/workers/join", controlPlane), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`worker join failed: ${response.status} ${await response.text()}`);
    const ws = new WebSocket(buildMacWorkerSocketUrl(controlPlane.toString(), vmUuid));
    ws.onmessage = async event => { const command = JSON.parse(String(event.data)) as WorkerCommand; const result = await handleMacWorkerCommand(command, driver, limits); ws.send(JSON.stringify(result)); };
    const { promise } = Promise.withResolvers<never>();
    return await promise;
  } finally { codeBytes.fill(0); }
}
if (import.meta.main && Bun.argv[2] === "mac-worker") { const baseUrl = Bun.env.WHITESMITH_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required"); await runMacWorker(baseUrl, { maxVcpuPerPod: Number(Bun.env.MAX_VCPU_PER_POD ?? 2), maxMemoryBytesPerPod: Number(Bun.env.MAX_MEMORY_BYTES_PER_POD ?? 4 * 1024 ** 3), maxStorageBytesPerPod: Number(Bun.env.MAX_STORAGE_BYTES_PER_POD ?? 20 * 1024 ** 3), maxConcurrentPods: Number(Bun.env.MAX_CONCURRENT_PODS ?? 1) }); }
if (import.meta.main && Bun.argv[2] === "join") { const platform = Bun.argv[3]; if (platform !== "macos-arm64" && platform !== "windows-x64") throw new Error("unsupported join platform"); const baseUrl = Bun.env.WHITESMITH_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required"); await runWorkerJoin(platform, baseUrl); }
