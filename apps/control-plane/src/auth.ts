import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { and, eq, gt, or, sql as drizzleSql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
const queries = defineQueries((db) => ({
  createSession: db.insert(schema.sessions).values({ tokenHash: drizzleSql`decode(${drizzleSql.placeholder("tokenHash")},'hex')`, userId: drizzleSql.placeholder("userId"), expiresAt: drizzleSql`now()+interval '7 days'` }).prepare("auth_create_session"),
  deleteSession: db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, drizzleSql`decode(${drizzleSql.placeholder("tokenHash")},'hex')`)).prepare("auth_delete_session"),
  getSession: db.select({ id: schema.users.id, githubUserId: schema.users.githubUserId, login: schema.users.login, isGlobalAdmin: schema.users.isGlobalAdmin })
    .from(schema.sessions).innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, drizzleSql`decode(${drizzleSql.placeholder("tokenHash")},'hex')`), gt(schema.sessions.expiresAt, drizzleSql`now()`),
      or(eq(schema.users.isGlobalAdmin, true), drizzleSql`EXISTS (SELECT 1 FROM memberships m JOIN dashboard_installations i ON i.organization_id=m.organization_id WHERE m.user_id=${schema.users.id} AND i.state IN ('pending','approved'))`)))
    .prepare("auth_get_session"),
}));

export interface SessionUser { id: string; githubUserId: number; login: string; isGlobalAdmin: boolean; }
export function tokenBytes(): Buffer { return randomBytes(32); }
export function sha256(value: Uint8Array | string): Buffer { return createHash("sha256").update(value).digest(); }
export function equalBytes(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
export class SecretBox {
  private readonly key: Buffer;
  constructor(raw: string) { this.key = Buffer.from(raw, "base64"); if (this.key.length !== 32) throw new Error("APP_MASTER_KEY must be base64-encoded 32 bytes"); }
  encrypt(value: string): string { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv); const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64"); }
  decrypt(encoded: string): string { const raw = Buffer.from(encoded, "base64"); const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"); }
}
export async function createSession(db: DatabaseClient, userId: string): Promise<string> { const token = tokenBytes(); await queries(db).createSession.execute({ tokenHash: sha256(token).toString("hex"), userId }); return token.toString("base64url"); }
export async function deleteSession(db: DatabaseClient, token: string | undefined): Promise<void> {
  if (!token) return;
  await queries(db).deleteSession.execute({ tokenHash: sha256(Buffer.from(token, "base64url")).toString("hex") });
}
export async function getSession(db: DatabaseClient, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const [row] = await queries(db).getSession.execute({ tokenHash: sha256(Buffer.from(token, "base64url")).toString("hex") });
  if (!row) return null;
  const githubUserId = Number(row.githubUserId);
  if (!Number.isSafeInteger(githubUserId)) throw new Error("session_github_user_id_invalid");
  return { ...row, githubUserId };
}
export function stateCookie(): string { return randomUUID(); }
