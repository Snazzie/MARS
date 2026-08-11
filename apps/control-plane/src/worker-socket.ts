import { randomBytes } from "node:crypto";
export interface WorkerChallenge { workerId: string; nonce: Buffer }
export function createWorkerChallenge(workerId: string): WorkerChallenge { return { workerId, nonce: randomBytes(32) }; }
export function decodeWorkerSignature(value: string): Buffer { const signature = Buffer.from(value, "base64url"); if (signature.length !== 64) throw new Error("invalid worker signature"); return signature; }
