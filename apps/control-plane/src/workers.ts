import { createHash, generateKeyPairSync, verify } from "node:crypto";
import type { DatabaseClient } from "@mars/db";
import { defineQueries, schema } from "@mars/db";
import { eq, and, inArray, isNotNull, sql } from "drizzle-orm";

const queries = defineQueries(db => ({
  adopt: db.update(schema.workers).set({ admissionState: "adopted", configurationState: sql`case when ${schema.workers.doctor} is not null then 'ready' else 'unconfigured' end` }).where(and(eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.admissionState, "pending"))).returning({ id: schema.workers.id }).prepare("workers_adopt"),
  rename: db.update(schema.workers).set({ name: sql`${sql.placeholder("name")}` }).where(and(eq(schema.workers.id, sql.placeholder("workerId")), inArray(schema.workers.admissionState, ["pending", "adopted"]))).returning({ id: schema.workers.id }).prepare("workers_rename"),
  audit: db.insert(schema.auditEvents).values({ actor: sql.placeholder("actor"), type: sql.placeholder("type"), payload: sql`${sql.placeholder("payload")}::jsonb` }).prepare("workers_audit"),
}));
const q = (db: DatabaseClient) => queries(db);
export interface WorkerJoin { workerId: string; publicKey: string; fingerprint: string; vmUuid: string; platform: string; limits: Record<string, number>; }
export function fingerprint(publicKey: string): string { return createHash("sha256").update(publicKey).digest("hex"); }
export function createWorkerKey(): { privateKey: string; publicKey: string } { const pair = generateKeyPairSync("ed25519"); return { privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString() }; }
export function verifyWorkerSignature(publicKey: string, nonce: Buffer, signature: Buffer): boolean { return verify(null, nonce, publicKey, signature); }
export async function adoptWorker(db: DatabaseClient, workerId: string, adminId: string): Promise<void> { await db.transaction(async tx => { const rows = await q(tx).adopt.execute({ workerId }); if (rows.length !== 1) throw new Error("worker adoption conflict"); await q(tx).audit.execute({ actor: adminId, type: "worker.adopted", payload: JSON.stringify({ workerId }) }); }); }
export async function renameWorker(db: DatabaseClient, workerId: string, name: string, adminId: string): Promise<void> {
  await db.transaction(async tx => {
    const rows = await q(tx).rename.execute({ workerId, name });
    if (rows.length !== 1) throw new Error("worker rename conflict");
    await q(tx).audit.execute({ actor: adminId, type: "worker.renamed", payload: JSON.stringify({ workerId, name }) });
  });
}
