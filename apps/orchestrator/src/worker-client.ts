import { sign as signMessage } from "node:crypto";
import type { WorkerEvent } from "@mars/contracts";
export type WorkerIdentity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string; vmUuid?: string; machineUuid?: string };
export function workerSocketUrl(baseUrl: string, workerId: string): string { const url = new URL(baseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/api/v1/workers/connect"; url.search = new URLSearchParams({ workerId }).toString(); return url.toString(); }
export function authenticateWorker(challenge: string, identity: WorkerIdentity): Record<string, string> { const canonical = `${challenge}\n${identity.workerId}\n${identity.encryptionPublicKey}`; return { type: "authenticate", workerId: identity.workerId, encryptionPublicKey: identity.encryptionPublicKey, signature: signMessage(null, Buffer.from(canonical), identity.privateKey).toString("base64url") }; }
export async function retryControlPlaneOperation<T>(operationName: string, operation: () => Promise<T>, sleep: (milliseconds: number) => Promise<void> = Bun.sleep): Promise<T> {
  let unavailable = false;
  for (;;) {
    try {
      const value = await operation();
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
