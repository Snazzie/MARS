import { createHmac, timingSafeEqual } from "node:crypto";
import type { Sql } from "@whitesmith/db";
import { jsonParameter } from "@whitesmith/db";
export async function readBody(request: Request, maxBytes=2*1024*1024): Promise<Buffer> { const reader=request.body?.getReader(); if (!reader) return Buffer.alloc(0); const chunks: Uint8Array[]=[]; let size=0; while(true){ const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>maxBytes) throw new Error("webhook body too large"); chunks.push(value); } return Buffer.concat(chunks); }
export function validSignature(body: Buffer, header: string| null, secret: string): boolean { if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false; const expected=Buffer.from(header.slice(7),"hex"); const actual=createHmac("sha256",secret).update(body).digest(); return timingSafeEqual(expected,actual); }
export async function acceptDelivery(sql: Sql<{}>, deliveryId:string, installationId:number, payload:unknown, eventName = "unknown"): Promise<boolean> {
  return sql.begin(async tx => {
    const inserted = await tx`insert into webhook_deliveries (delivery_id,installation_id,payload,event_name,state) values (${deliveryId},${installationId},${jsonParameter(tx, payload)},${eventName},'received') on conflict (delivery_id) do nothing returning delivery_id`;
    if (!inserted.length) {
      const claimed = await tx`update webhook_deliveries set state='processing',attempt_count=attempt_count+1,last_error=null where delivery_id=${deliveryId} and state <> 'completed' returning delivery_id`;
      return claimed.length === 1;
    }
    await tx`update webhook_deliveries set state='processing',attempt_count=attempt_count+1 where delivery_id=${deliveryId}`;
    return true;
  });
}
export async function completeDelivery(sql: Sql<{}>, deliveryId: string): Promise<void> {
  await sql`update webhook_deliveries set state='completed',processed_at=now(),last_error=null where delivery_id=${deliveryId}`;
}
export async function failDelivery(sql: Sql<{}>, deliveryId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sql`update webhook_deliveries set state='failed',last_error=${message.slice(0, 2000)} where delivery_id=${deliveryId}`;
}
