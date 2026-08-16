import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";

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
export async function createSession(sql: Sql<{}>, userId: string): Promise<string> { const token = tokenBytes(); await sql`insert into sessions (token_hash,user_id,expires_at) values (${sha256(token)},${userId},now()+interval '7 days')`; return token.toString("base64url"); }
export async function deleteSession(sql: Sql<{}>, token: string | undefined): Promise<void> {
  if (!token) return;
  await sql`delete from sessions where token_hash=${sha256(Buffer.from(token, "base64url"))}`;
}
export async function getSession(sql: Sql<{}>, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const [row] = await sql<Array<Omit<SessionUser, "githubUserId"> & { githubUserId: number | string }>>`select u.id,u.github_user_id as "githubUserId",u.login,u.is_global_admin as "isGlobalAdmin" from sessions s join users u on u.id=s.user_id where s.token_hash=${sha256(Buffer.from(token,"base64url"))} and s.expires_at>now()`;
  if (!row) return null;
  const githubUserId = Number(row.githubUserId);
  if (!Number.isSafeInteger(githubUserId)) throw new Error("session_github_user_id_invalid");
  return { ...row, githubUserId };
}
export function stateCookie(): string { return randomUUID(); }
