import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { hostname } from "node:os";
import type { WorkerCommand } from "@whitesmith/contracts";
import type { Lease } from "./runtime.ts";
import { createTartVmRuntime, TartVmDriver } from "./tart.ts";

export interface MacWorkerLimits { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number }
export interface MacWorkerJoinInput { code: string; publicKey: string; vmUuid: string; limits: MacWorkerLimits }
export interface MacWorkerJoinPayload extends MacWorkerJoinInput { platform: "macos-arm64" }
export function buildMacWorkerJoinPayload(input: MacWorkerJoinInput): MacWorkerJoinPayload { return { ...input, platform: "macos-arm64" }; }
export function buildMacWorkerSocketUrl(base: string, workerId: string): string { const url = new URL(base); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/api/v1/workers/connect"; url.search = new URLSearchParams({ workerId }).toString(); return url.toString(); }
export async function handleMacWorkerCommand(command: WorkerCommand, driver: TartVmDriver): Promise<{ version: 1; type: string; workerId: string; leaseId: string | null; payload: Record<string, unknown> }> { if (command.type === "tart.create_lease") { const lease = command.payload as unknown as Lease; const runtime = await driver.createLease(lease); return { version: 1, type: "sandbox_attested", workerId: command.workerId, leaseId: command.leaseId, payload: runtime as unknown as Record<string, unknown> }; } if (command.type === "tart.stop_lease" && command.leaseId) { await driver.stopLease(command.leaseId); return { version: 1, type: "lease_stopped", workerId: command.workerId, leaseId: command.leaseId, payload: {} }; } if (command.type === "tart.remove_lease" && command.leaseId) { await driver.removeLease(command.leaseId); return { version: 1, type: "lease_removed", workerId: command.workerId, leaseId: command.leaseId, payload: {} }; } throw new Error(`unsupported macOS worker command: ${command.type}`); }
function createKeyPair(): { privateKey: string; publicKey: string } { const pair = generateKeyPairSync("ed25519"); return { privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString() }; }
async function readJoinCode(): Promise<Buffer> { const reader = Bun.stdin.stream().getReader(); const { value } = await reader.read(); reader.releaseLock(); const code = Buffer.from(value ?? []); if (!code.toString("utf8").trim()) throw new Error("join code required on stdin"); return code; }
function validateControlPlaneUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("control plane must use HTTPS (TLS 1.3) except explicit localhost development");
  return url;
}
export async function runWorkerJoin(platform: "macos-arm64" | "windows-x64", baseUrl: string): Promise<void> {
  const controlPlane = validateControlPlaneUrl(baseUrl);
  const key = createKeyPair();
  const codeBytes = await readJoinCode();
  try {
    const code = codeBytes.toString("utf8").trim();
    const response = await fetch(new URL("/api/workers/join", controlPlane), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform, code, publicKey: key.publicKey, vmUuid: Bun.env.WHITESMITH_VM_UUID ?? hostname() }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`worker join failed: ${response.status}`);
  } finally { codeBytes.fill(0); }
}
export async function runMacWorker(baseUrl: string, limits: MacWorkerLimits): Promise<never> { const key = createKeyPair(); const driver = new TartVmDriver(createTartVmRuntime(), Bun.env.WHITESMITH_TART_BASE_IMAGE ?? "whitesmith-macos-worker", "whitesmith-job", limits); const codeBytes = await readJoinCode(); const code = codeBytes.toString("utf8").trim(); const vmUuid = Bun.env.WHITESMITH_VM_UUID ?? hostname(); const response = await fetch(new URL("/api/workers/join", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildMacWorkerJoinPayload({ code, publicKey: key.publicKey, vmUuid, limits })) }); codeBytes.fill(0); if (!response.ok) throw new Error(`worker join failed: ${response.status} ${await response.text()}`); const { promise } = Promise.withResolvers<never>(); return await promise; }
if (import.meta.main && Bun.argv[2] === "mac-worker") { const baseUrl = Bun.env.WHITESMITH_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required"); await runMacWorker(baseUrl, { maxVcpuPerPod: Number(Bun.env.MAX_VCPU_PER_POD ?? 2), maxMemoryBytesPerPod: Number(Bun.env.MAX_MEMORY_BYTES_PER_POD ?? 4 * 1024 ** 3), maxStorageBytesPerPod: Number(Bun.env.MAX_STORAGE_BYTES_PER_POD ?? 20 * 1024 ** 3), maxConcurrentPods: Number(Bun.env.MAX_CONCURRENT_PODS ?? 1) }); }
if (import.meta.main && Bun.argv[2] === "join") { const platform = Bun.argv[3]; if (platform !== "macos-arm64" && platform !== "windows-x64") throw new Error("unsupported join platform"); const baseUrl = Bun.env.WHITESMITH_CONTROL_PLANE_URL; if (!baseUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL is required"); await runWorkerJoin(platform, baseUrl); }
