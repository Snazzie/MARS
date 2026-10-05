import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
const queries = defineQueries((db) => ({
  acceptInsert: db.insert(schema.webhookDeliveries).values({ deliveryId: sql.placeholder("deliveryId"), installationId: sql.placeholder("installationId"), payload: sql`(${sql.placeholder("payload")})::jsonb`, eventName: sql.placeholder("eventName"), state: "received" }).onConflictDoNothing({ target: schema.webhookDeliveries.deliveryId }).returning({ deliveryId: schema.webhookDeliveries.deliveryId }).prepare("webhook_accept_insert"),
  claim: db.update(schema.webhookDeliveries).set({ state: "processing", attemptCount: sql`${schema.webhookDeliveries.attemptCount}+1`, lastError: null }).where(and(eq(schema.webhookDeliveries.deliveryId, sql.placeholder("deliveryId")), ne(schema.webhookDeliveries.state, "completed"))).returning({ deliveryId: schema.webhookDeliveries.deliveryId }).prepare("webhook_claim"),
  complete: db.update(schema.webhookDeliveries).set({ state: "completed", processedAt: sql`now()`, lastError: null }).where(eq(schema.webhookDeliveries.deliveryId, sql.placeholder("deliveryId"))).prepare("webhook_complete"),
  fail: db.update(schema.webhookDeliveries).set({ state: "failed", lastError: sql`${sql.placeholder("message")}` }).where(eq(schema.webhookDeliveries.deliveryId, sql.placeholder("deliveryId"))).prepare("webhook_fail"),
}));
export async function readBody(request: Request, maxBytes=2*1024*1024): Promise<Buffer> { const reader=request.body?.getReader(); if (!reader) return Buffer.alloc(0); const chunks: Uint8Array[]=[]; let size=0; while(true){ const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>maxBytes) throw new Error("webhook body too large"); chunks.push(value); } return Buffer.concat(chunks); }
export function validSignature(body: Buffer, header: string| null, secret: string): boolean { if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false; const expected=Buffer.from(header.slice(7),"hex"); const actual=createHmac("sha256",secret).update(body).digest(); return timingSafeEqual(expected,actual); }
export async function acceptDelivery(db: DatabaseClient, deliveryId:string, installationId:number, payload:unknown, eventName = "unknown"): Promise<boolean> {
  return db.transaction(async tx => {
    const inserted = await queries(tx).acceptInsert.execute({ deliveryId, installationId, payload: JSON.stringify(payload), eventName });
    if (!inserted.length) return (await queries(tx).claim.execute({ deliveryId })).length === 1;
    await queries(tx).claim.execute({ deliveryId });
    return true;
  });
}
export async function completeDelivery(db: DatabaseClient, deliveryId: string): Promise<void> { await queries(db).complete.execute({ deliveryId }); }
export async function failDelivery(db: DatabaseClient, deliveryId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await queries(db).fail.execute({ deliveryId, message: message.slice(0, 2000) });
}