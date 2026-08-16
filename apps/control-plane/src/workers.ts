import { createHash, generateKeyPairSync, verify } from "node:crypto";
import type { Sql } from "postgres";
import { jsonParameter } from "@whitesmith/db";

export interface WorkerJoin { workerId: string; publicKey: string; fingerprint: string; vmUuid: string; platform: string; limits: Record<string, number>; }
export function fingerprint(publicKey: string): string { return createHash("sha256").update(publicKey).digest("hex"); }
export function createWorkerKey(): { privateKey: string; publicKey: string } { const pair = generateKeyPairSync("ed25519"); return { privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString() }; }
export function verifyWorkerSignature(publicKey: string, nonce: Buffer, signature: Buffer): boolean { return verify(null, nonce, publicKey, signature); }
export async function adoptWorker(sql: Sql<{}>, workerId: string, adminId: string): Promise<void> { await sql.begin(async tx => { const rows = await tx`update workers set admission_state='adopted', configuration_state=case when doctor is not null then 'ready' else 'unconfigured' end where id=${workerId} and admission_state='pending' returning id`; if (rows.length !== 1) throw new Error("worker adoption conflict"); await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.adopted',${jsonParameter(tx, { workerId })})`; }); }
