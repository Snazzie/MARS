import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, chmod, readFile, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import type { DashboardDb } from "@whitesmith/db";
import type { TransactionSql } from "postgres";
import { httpOrigin } from "./http-origin.ts";

const SETUP_LOCK = "whitesmith:control-plane-setup";
const digest = (code: string): Buffer => createHash("sha256").update(code).digest();
const sameDigest = (left: Buffer | null | undefined, right: Buffer): boolean => Boolean(left && left.length === right.length && timingSafeEqual(left, right));
const setupPath = (root: string) => join(root, "setup_code");
const masterPath = (root: string) => join(root, "app_master_key");

async function exclusiveSecretFile(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value, "utf8"); } finally { await handle.close(); }
  await chmod(path, 0o600);
}

function validKey(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32;
}

export async function loadOrCreateMasterKey(dataRoot: string, overridePath?: string): Promise<string> {
  const path = overridePath?.trim() || masterPath(dataRoot);
  if (!overridePath) await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (!validKey(value)) throw new Error("APP_MASTER_KEY_FILE contains an invalid key");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (overridePath) throw new Error(`APP_MASTER_KEY_FILE is unreadable: ${path}`);
    const value = randomBytes(32).toString("base64");
    try { await exclusiveSecretFile(path, value); } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      const existing = (await readFile(path, "utf8")).trim();
      if (!validKey(existing)) throw new Error("APP_MASTER_KEY_FILE contains an invalid key");
      return existing;
    }
    return value;
  }
}

export type ControlPlaneSetup = {
  publicOrigin(): string | null;
  configure(code: string, candidateOrigin: string): Promise<string>;
  authorize(code: string): Promise<boolean>;
  claimAdmin(code: string, githubUser: { id: number; login: string }): Promise<string>;
};

type ConfigRow = { publicBaseUrl: string | null; setupCodeHash: Buffer | null; setupCompletedAt: Date | string | null };
async function readConfig(db: DashboardDb): Promise<ConfigRow | null> {
  const rows = await db<ConfigRow[]>`select public_base_url as "publicBaseUrl", setup_code_hash as "setupCodeHash", setup_completed_at as "setupCompletedAt" from control_plane_config where singleton=true`;
  return rows[0] ?? null;
}

export async function initializeControlPlaneSetup(db: DashboardDb, dataRoot: string): Promise<{ setup: ControlPlaneSetup; setupCode: string | null; masterKey: string }> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
  const masterKey = await loadOrCreateMasterKey(dataRoot);
  let config = await readConfig(db);
  let setupCode: string | null = null;
  if (!config) {
    setupCode = randomBytes(32).toString("base64url");
    await db`insert into control_plane_config (singleton, setup_code_hash) values (true, ${digest(setupCode)}) on conflict (singleton) do nothing`;
    config = await readConfig(db);
  }
  if (config && !config.setupCompletedAt && !config.setupCodeHash) {
    const candidate = randomBytes(32).toString("base64url");
    await db.begin(async (tx: TransactionSql) => {
      await tx`select pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))`;
      const rows = await tx<ConfigRow[]>`select setup_code_hash as "setupCodeHash", setup_completed_at as "setupCompletedAt" from control_plane_config where singleton=true for update`;
      if (rows[0] && !rows[0].setupCompletedAt && !rows[0].setupCodeHash) {
        await tx`update control_plane_config set setup_code_hash=${digest(candidate)}, updated_at=now() where singleton=true`;
        setupCode = candidate;
      }
    });
  }
  if (!config?.setupCompletedAt && config?.setupCodeHash) {
    try { await readFile(setupPath(dataRoot), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const candidate = randomBytes(32).toString("base64url");
      await db.begin(async (tx: TransactionSql) => {
        await tx`select pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))`;
        const rows = await tx<ConfigRow[]>`select setup_code_hash as "setupCodeHash", setup_completed_at as "setupCompletedAt" from control_plane_config where singleton=true for update`;
        if (rows[0] && !rows[0].setupCompletedAt) {
          await tx`update control_plane_config set setup_code_hash=${digest(candidate)}, updated_at=now() where singleton=true`;
          setupCode = candidate;
        }
      });
    }
  }
  if (setupCode && !config?.setupCompletedAt) {
    try { await exclusiveSecretFile(setupPath(dataRoot), setupCode); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const setup: ControlPlaneSetup = {
    publicOrigin: () => config?.publicBaseUrl ?? null,
    configure: async (code, candidateOrigin) => {
      const origin = httpOrigin("publicBaseUrl", candidateOrigin);
      if (!(await setup.authorize(code))) throw new Error("setup_unauthorized");
      await db`update control_plane_config set public_base_url=${origin}, updated_at=now() where singleton=true and setup_completed_at is null`;
      config = { ...config!, publicBaseUrl: origin };
      return origin;
    },
    authorize: async code => {
      const current = await readConfig(db);
      return Boolean(current && !current.setupCompletedAt && sameDigest(current.setupCodeHash, digest(code)));
    },
    claimAdmin: async (code, githubUser) => {
      const result = await db.begin(async (tx: TransactionSql) => {
        await tx`select pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))`;
        const rows = await tx<ConfigRow[]>`select setup_code_hash as "setupCodeHash", setup_completed_at as "setupCompletedAt" from control_plane_config where singleton=true for update`;
        const current = rows[0];
        if (!current || current.setupCompletedAt || !sameDigest(current.setupCodeHash, digest(code))) throw new Error("setup_unauthorized");
        const users = await tx<Array<{ id: string }>>`insert into users (github_user_id, login) values (${githubUser.id}, ${githubUser.login}) on conflict (github_user_id) do update set login=excluded.login returning id`;
        const user = users[0];
        if (!user) throw new Error("setup_admin_failed");
        const existing = await tx<Array<{ adminUserId: string | null }>>`select admin_user_id as "adminUserId" from system_onboarding where singleton=true for update`;
        if (existing[0]?.adminUserId && existing[0].adminUserId !== user.id) throw new Error("setup_admin_conflict");
        await tx`update users set is_global_admin=true where id=${user.id}`;
        await tx`update system_onboarding set admin_user_id=${user.id} where singleton=true and (admin_user_id is null or admin_user_id=${user.id})`;
        await tx`update control_plane_config set setup_completed_at=now(), setup_code_hash=null, updated_at=now() where singleton=true`;
        return user.id;
      });
      await unlink(setupPath(dataRoot)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      config = { ...config!, setupCompletedAt: new Date(), setupCodeHash: null };
      return result;
    },
  };
  return { setup, setupCode: config?.setupCompletedAt ? null : setupCode, masterKey };
}
