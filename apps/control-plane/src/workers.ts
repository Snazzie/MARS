import { createHash, generateKeyPairSync, randomBytes, verify, hkdfSync } from "node:crypto";
import type { Sql } from "postgres";
import { sha256 } from "./auth.ts";

export interface WorkerJoin { workerId: string; publicKey: string; fingerprint: string; vmUuid: string; platform: string; limits: Record<string, number>; }
export interface EnrollmentCode { code: string; guestHash: Buffer; statusHash: Buffer; expiresAt: Date; }
export function fingerprint(publicKey: string): string { return createHash("sha256").update(publicKey).digest("hex"); }
function derive(code: Buffer, purpose: string): Buffer { return Buffer.from(hkdfSync("sha256", code, "whitesmith", purpose, 32) as ArrayBuffer); }
export function createEnrollmentCode(): EnrollmentCode { const code = randomBytes(32); return { code: code.toString("base64url"), guestHash: sha256(derive(code,"guest-join")), statusHash: sha256(derive(code,"installer-status")), expiresAt: new Date(Date.now()+15*60_000) }; }
export async function consumeJoin(sql: Sql<{}>, code: Buffer): Promise<boolean> { const guestHash=sha256(derive(code,"guest-join")); const rows = await sql`update worker_join_codes set consumed_at=now() where guest_token_hash=${guestHash} and consumed_at is null and expires_at>now() returning id`; return rows.length === 1; }
export function createWorkerKey(): { privateKey: string; publicKey: string } { const pair = generateKeyPairSync("ed25519"); return { privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString() }; }
export function verifyWorkerSignature(publicKey: string, nonce: Buffer, signature: Buffer): boolean { return verify(null, nonce, publicKey, signature); }
export async function adoptWorker(sql: Sql<{}>, workerId: string, adminId: string): Promise<void> { await sql.begin(async tx => { const rows = await tx`update workers set admission_state='adopted' where id=${workerId} and admission_state='pending' returning id`; if (rows.length !== 1) throw new Error("worker adoption conflict"); await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.adopted',${JSON.stringify({workerId})})`; }); }
