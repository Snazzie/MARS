import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseClient } from "@mars/db";
import { defineQueries, schema } from "@mars/db";
import { eq, sql } from "drizzle-orm";
import { sha256 } from "./auth.ts";

export interface BootstrapReveal { code: string; generation: number; createdAt: string }
export interface BootstrapStatus { initialized: boolean; generation: number | null; createdAt: string | null; rotatedAt: string | null }

type BootstrapRow = { generation: number; createdAt: string | Date; rotatedAt: string | Date | null; codeHash: Buffer };
function hash(code: string): Buffer { return sha256(Buffer.from(code, "base64url")); }
function result(row: BootstrapRow, code: string): BootstrapReveal { return { code, generation: row.generation, createdAt: new Date(row.createdAt).toISOString() }; }

const queries = defineQueries(db => ({
  initialize: db.insert(schema.workerBootstrapCredentials).values({ codeHash: sql.placeholder("codeHash"), generation: 1, createdBy: sql.placeholder("actorId") }).returning({ generation: schema.workerBootstrapCredentials.generation, createdAt: schema.workerBootstrapCredentials.createdAt, rotatedAt: schema.workerBootstrapCredentials.rotatedAt }).prepare("worker_bootstrap_initialize"),
  lock: db.select({ generation: schema.workerBootstrapCredentials.generation }).from(schema.workerBootstrapCredentials).where(eq(schema.workerBootstrapCredentials.singleton, true)).for("update").prepare("worker_bootstrap_lock"),
  rotate: db.update(schema.workerBootstrapCredentials).set({ codeHash: sql`${sql.placeholder("codeHash")}`, generation: sql`${schema.workerBootstrapCredentials.generation} + 1`, rotatedBy: sql`${sql.placeholder("actorId")}`, rotatedAt: sql`now()`, consumedAt: null }).where(eq(schema.workerBootstrapCredentials.singleton, true)).returning({ generation: schema.workerBootstrapCredentials.generation, createdAt: schema.workerBootstrapCredentials.createdAt, rotatedAt: schema.workerBootstrapCredentials.rotatedAt }).prepare("worker_bootstrap_rotate"),
  audit: db.insert(schema.auditEvents).values({ actor: sql.placeholder("actor"), type: "worker.bootstrap.rotated", payload: sql`${sql.placeholder("payload")}::jsonb` }).prepare("worker_bootstrap_audit"),
  status: db.select({ generation: schema.workerBootstrapCredentials.generation, createdAt: schema.workerBootstrapCredentials.createdAt, rotatedAt: schema.workerBootstrapCredentials.rotatedAt }).from(schema.workerBootstrapCredentials).where(eq(schema.workerBootstrapCredentials.singleton, true)).prepare("worker_bootstrap_status"),
  verify: db.select({ codeHash: schema.workerBootstrapCredentials.codeHash }).from(schema.workerBootstrapCredentials).where(sql`${schema.workerBootstrapCredentials.singleton} = true and ${schema.workerBootstrapCredentials.consumedAt} is null`).prepare("worker_bootstrap_verify"),
}));

export async function initializeWorkerBootstrap(db: DatabaseClient, actorId: string): Promise<BootstrapReveal> {
  const code = randomBytes(32).toString("base64url");
  try {
    const [row] = await queries(db).initialize.execute({ codeHash: hash(code), actorId });
    return result({ ...row, codeHash: hash(code) }, code);
  } catch (error) { throw new Error("already initialized", { cause: error }); }
}

export async function rotateWorkerBootstrap(db: DatabaseClient, actorId: string): Promise<BootstrapReveal> {
  const code = randomBytes(32).toString("base64url");
  return db.transaction(async tx => {
    const [current] = await queries(tx).lock.execute();
    if (!current) throw new Error("bootstrap credential is not initialized");
    const [row] = await queries(tx).rotate.execute({ codeHash: hash(code), actorId });
    await queries(tx).audit.execute({ actor: actorId, payload: JSON.stringify({ generation: row!.generation }) });
    return result({ ...row!, codeHash: hash(code) }, code);
  });
}

export async function getWorkerBootstrapStatus(db: DatabaseClient): Promise<BootstrapStatus> {
  const [row] = await queries(db).status.execute();
  return row ? { initialized: true, generation: row.generation, createdAt: new Date(row.createdAt).toISOString(), rotatedAt: row.rotatedAt ? new Date(row.rotatedAt).toISOString() : null } : { initialized: false, generation: null, createdAt: null, rotatedAt: null };
}

export async function verifyWorkerBootstrap(db: DatabaseClient, code: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
  const [row] = await queries(db).verify.execute();
  if (!row) return false;
  const candidate = hash(code);
  return row.codeHash.length === candidate.length && timingSafeEqual(row.codeHash, candidate);
}
