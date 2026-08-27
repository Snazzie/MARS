import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Sql } from "@mars/db";
import { jsonParameter } from "@mars/db";
import { sha256 } from "./auth.ts";

export interface BootstrapReveal { code: string; generation: number; createdAt: string }
export interface BootstrapStatus { initialized: boolean; generation: number | null; createdAt: string | null; rotatedAt: string | null }

type BootstrapRow = { generation: number; createdAt: string | Date; rotatedAt: string | Date | null; codeHash: Buffer };
function hash(code: string): Buffer { return sha256(Buffer.from(code, "base64url")); }
function result(row: BootstrapRow, code: string): BootstrapReveal { return { code, generation: row.generation, createdAt: new Date(row.createdAt).toISOString() }; }

export async function initializeWorkerBootstrap(db: Sql<{}>, actorId: string): Promise<BootstrapReveal> {
  const code = randomBytes(32).toString("base64url");
  try {
    const [row] = await db<BootstrapRow[]>`insert into worker_bootstrap_credentials (code_hash, generation, created_by) values (${hash(code)}, 1, ${actorId}) returning generation, created_at as "createdAt", rotated_at as "rotatedAt"`;
    return result({ ...row, createdAt: new Date(row.createdAt).toISOString(), rotatedAt: row.rotatedAt ? new Date(row.rotatedAt).toISOString() : null, codeHash: hash(code) }, code);
  } catch (error) { throw new Error("already initialized", { cause: error }); }
}

export async function rotateWorkerBootstrap(db: Sql<{}>, actorId: string): Promise<BootstrapReveal> {
  const code = randomBytes(32).toString("base64url");
  return db.begin(async (tx) => {
    const [current] = await tx<{ generation: number }[]>`select generation from worker_bootstrap_credentials where singleton=true for update`;
    if (!current) throw new Error("bootstrap credential is not initialized");
    const [row] = await tx<BootstrapRow[]>`update worker_bootstrap_credentials set code_hash=${hash(code)}, generation=generation+1, rotated_by=${actorId}, rotated_at=now(), consumed_at=null where singleton=true returning generation, created_at as "createdAt", rotated_at as "rotatedAt"`;
    await tx`insert into audit_events (actor,type,payload) values (${actorId},'worker.bootstrap.rotated',${jsonParameter(tx, { generation: row.generation })})`;
    return result({ ...row, createdAt: new Date(row.createdAt).toISOString(), rotatedAt: row.rotatedAt ? new Date(row.rotatedAt).toISOString() : null, codeHash: hash(code) }, code);
  });
}

export async function getWorkerBootstrapStatus(db: Sql<{}>): Promise<BootstrapStatus> {
  const [row] = await db<{ generation: number; createdAt: string | Date; rotatedAt: string | Date | null }[]>`select generation, created_at as "createdAt", rotated_at as "rotatedAt" from worker_bootstrap_credentials where singleton=true`;
  return row ? { initialized: true, generation: row.generation, createdAt: new Date(row.createdAt).toISOString(), rotatedAt: row.rotatedAt ? new Date(row.rotatedAt).toISOString() : null } : { initialized: false, generation: null, createdAt: null, rotatedAt: null };
}

export async function verifyWorkerBootstrap(db: Sql<{}>, code: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
  const [row] = await db<{ codeHash: Buffer }[]>`select code_hash as "codeHash" from worker_bootstrap_credentials where singleton=true and consumed_at is null`;
  if (!row) return false;
  const candidate = hash(code);
  return row.codeHash.length === candidate.length && timingSafeEqual(row.codeHash, candidate);
}
