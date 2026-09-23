import { sign as signMessage } from "node:crypto";
import type { WorkerEvent } from "@mars/contracts";
import { WorkerContractVersion, WorkerReleaseVersion } from "@mars/contracts";
export type WorkerIdentity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string; vmUuid?: string; machineUuid?: string; preserveLeases?: boolean };
export type WorkerRuntimeVersions = { releaseVersion: string; contractVersion: string };
export function workerRuntimeVersions(): WorkerRuntimeVersions {
  const releaseVersion = Bun.env.MARS_WORKER_VERSION?.trim();
  const contractVersion = Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim();
  if (!WorkerReleaseVersion.safeParse(releaseVersion).success) throw new Error("MARS_WORKER_VERSION is required and must be a strict major.minor.patch release version");
  if (!WorkerContractVersion.safeParse(contractVersion).success) throw new Error("MARS_WORKER_CONTRACT_VERSION is required and must be a strict major.minor.patch contract version");
  return { releaseVersion: releaseVersion!, contractVersion: contractVersion! };
}
export function workerSocketUrl(baseUrl: string, workerId: string): string { const url = new URL(baseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/api/v1/workers/connect"; url.search = new URLSearchParams({ workerId }).toString(); return url.toString(); }
export function authenticateWorker(challenge: string, identity: WorkerIdentity): Record<string, string> { const canonical = `${challenge}\n${identity.workerId}\n${identity.encryptionPublicKey}`; return { type: "authenticate", workerId: identity.workerId, encryptionPublicKey: identity.encryptionPublicKey, signature: signMessage(null, Buffer.from(canonical), identity.privateKey).toString("base64url") }; }
type ConnectionTimeoutHandle = ReturnType<typeof setTimeout>;
type ScheduleConnectionTimeout = (callback: () => void, delayMs: number) => ConnectionTimeoutHandle;
export function waitForWorkerSocketClose(socket: WebSocket, connectionTimeoutMs = 30_000, scheduleTimeout: ScheduleConnectionTimeout = setTimeout, cancelTimeout: (handle: ConnectionTimeoutHandle | undefined) => void = clearTimeout): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  let timeout: ConnectionTimeoutHandle | undefined;
  const connected = () => {
    cancelTimeout(timeout);
    timeout = undefined;
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    connected();
    socket.removeEventListener("open", connected);
    socket.removeEventListener("close", finish);
    socket.removeEventListener("error", fail);
    resolve();
  };
  const fail = () => {
    try { socket.close(); } finally { finish(); }
  };
  timeout = scheduleTimeout(() => {
    try { socket.close(1000, "worker connection timeout"); } finally { finish(); }
  }, connectionTimeoutMs);
  socket.addEventListener("open", connected);
  socket.addEventListener("close", finish);
  socket.addEventListener("error", fail);
  if (socket.readyState === WebSocket.OPEN) connected();
  return promise;
}
const MAX_TRANSIENT_OUTBOX_BYTES = 64 * 1024 * 1024;
const TRANSIENT_EVENT_TYPES = new Set(["job.log", "job.resource_sample"]);
const isCacheEvent = (type: string): boolean => type.startsWith("worker.cache_") || type === "worker.runner_cache_status";
export class WorkerEventTransport {
  private socket?: WebSocket;
  private readonly pending = new Map<string, { encoded: string; transient: boolean; cacheEvent: boolean }>();
  private transientBytes = 0;
  constructor(private readonly cacheEventsEnabled: () => boolean = () => true) {}
  private discardDisabledCacheEvents(): void {
    if (this.cacheEventsEnabled()) return;
    for (const [id, pending] of this.pending) {
      if (pending.cacheEvent) this.pending.delete(id);
    }
  }
  bind(socket: WebSocket): void {
    this.discardDisabledCacheEvents();
    this.socket = socket;
    this.flush();
  }
  unbind(socket: WebSocket): void {
    if (this.socket === socket) this.socket = undefined;
  }
  acknowledge(eventId: string): void {
    const pending = this.pending.get(eventId);
    if (!pending) return;
    if (pending.transient) this.transientBytes -= Buffer.byteLength(pending.encoded);
    this.pending.delete(eventId);
  }
  send(event: WorkerEvent): void {
    this.discardDisabledCacheEvents();
    if (isCacheEvent(event.type) && !this.cacheEventsEnabled()) return;
    const encoded = JSON.stringify(event);
    const transient = TRANSIENT_EVENT_TYPES.has(event.type);
    if (transient) {
      const bytes = Buffer.byteLength(encoded);
      while (this.transientBytes + bytes > MAX_TRANSIENT_OUTBOX_BYTES) {
        const oldest = [...this.pending].find(([, value]) => value.transient);
        if (!oldest) break;
        this.pending.delete(oldest[0]);
        this.transientBytes -= Buffer.byteLength(oldest[1].encoded);
      }
      if (bytes > MAX_TRANSIENT_OUTBOX_BYTES) return;
      this.transientBytes += bytes;
    }
    this.pending.set(event.id, { encoded, transient, cacheEvent: isCacheEvent(event.type) });
    this.sendEncoded(encoded);
  }
  private flush(): void {
    for (const { encoded } of this.pending.values()) this.sendEncoded(encoded);
  }
  private sendEncoded(encoded: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encoded);
  }
}
export async function retryControlPlaneOperation<T>(operationName: string, operation: () => Promise<T>, sleep: (milliseconds: number) => Promise<void> = Bun.sleep): Promise<T> {
  let unavailable = false;
  for (;;) {
    try {
      const value = await operation();
      if (value instanceof Response && (value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500)) {
        throw new Error(`control plane returned retryable HTTP ${value.status}`);
      }
      if (unavailable) console.log(`Control plane connection restored: ${operationName}`);
      return value;
    } catch (error) {
      if (!unavailable) {
        unavailable = true;
        console.error(`Control plane unavailable; worker will keep retrying: ${operationName}`, error);
      }
      await sleep(1_000);
    }
  }
}
export function encodeWorkerEvent(workerId: string, type: string, payload: Record<string, unknown>): WorkerEvent { return { version: 1, id: crypto.randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload }; }
