import { sign as signMessage } from "node:crypto";
import type { WorkerEvent } from "@whitesmith/contracts";
export type WorkerIdentity = { workerId: string; publicKey: string; privateKey: string; encryptionPublicKey: string; encryptionPrivateKey: string };
export function workerSocketUrl(baseUrl: string, workerId: string): string { const url = new URL(baseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/api/v1/workers/connect"; url.search = new URLSearchParams({ workerId }).toString(); return url.toString(); }
export function authenticateWorker(challenge: string, identity: WorkerIdentity): Record<string, string> { const canonical = `${challenge}\n${identity.workerId}\n${identity.encryptionPublicKey}`; return { type: "authenticate", workerId: identity.workerId, encryptionPublicKey: identity.encryptionPublicKey, signature: signMessage(null, Buffer.from(canonical), identity.privateKey).toString("base64url") }; }
export function encodeWorkerEvent(workerId: string, type: string, payload: Record<string, unknown>): WorkerEvent { return { version: 1, id: crypto.randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload }; }
