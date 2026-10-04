import { mkdir, chmod, readFile, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { jsonParameter, type DashboardDb } from "@mars/db";
import type { TransactionSql } from "postgres";
import { httpOrigin } from "./http-origin.ts";
import { listGithubOrganizations, type OAuthUser } from "./github.ts";

const SETUP_LOCK = "mars:control-plane-setup";
const masterPath = (root: string) => join(root, "app_master_key");

async function exclusiveSecretFile(path: string, value: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value, "utf8"); } finally { await handle.close(); }
  await chmod(path, 0o600);
}
function validKey(value: string): boolean { return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32; }

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
  publicOriginManaged(): boolean;
  configure(candidateOrigin: string): Promise<string>;
  authenticate(githubUser: OAuthUser): Promise<{ userId: string; firstAdmin: boolean }>;
};
type ConfigRow = { publicBaseUrl: string | null; setupCompletedAt: Date | string | null };
async function readConfig(db: DashboardDb): Promise<ConfigRow | null> {
  const rows = await db<ConfigRow[]>`select public_base_url as "publicBaseUrl", setup_completed_at as "setupCompletedAt" from control_plane_config where singleton=true`;
  return rows[0] ?? null;
}
export async function initializeControlPlaneSetup(db: DashboardDb, dataRoot: string, configuredOrigin?: string): Promise<{ setup: ControlPlaneSetup; masterKey: string }> {
  const environmentOrigin = configuredOrigin?.trim() ? httpOrigin("PUBLIC_BASE_URL", configuredOrigin) : undefined;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 }); await chmod(dataRoot, 0o700);
  const masterKey = Bun.env.APP_MASTER_KEY?.trim() ?? await loadOrCreateMasterKey(dataRoot);
  if (!validKey(masterKey)) throw new Error("APP_MASTER_KEY must be base64-encoded 32 bytes");
  let config = await readConfig(db);
  if (!config) { await db`insert into control_plane_config (singleton) values (true) on conflict (singleton) do nothing`; config = await readConfig(db); }
  await db`INSERT INTO system_onboarding (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`;
  config ??= { publicBaseUrl: null, setupCompletedAt: null };
  if (environmentOrigin) {
    await db`insert into control_plane_config (singleton, public_base_url) values (true, ${environmentOrigin}) on conflict (singleton) do update set public_base_url=excluded.public_base_url, updated_at=now()`;
    config = { ...config, publicBaseUrl: environmentOrigin };
  }
  const setup: ControlPlaneSetup = {
    publicOrigin: () => config?.publicBaseUrl ?? null,
    publicOriginManaged: () => Boolean(environmentOrigin),
    configure: async candidateOrigin => {
      const origin = httpOrigin("PUBLIC_BASE_URL", candidateOrigin);
      if (environmentOrigin && origin !== environmentOrigin) throw new Error("configured_origin_mismatch");
      const updated = await db<Array<{ publicBaseUrl: string | null }>>`update control_plane_config set public_base_url=${origin}, updated_at=now() where singleton=true and setup_completed_at is null returning public_base_url as "publicBaseUrl"`;
      const persisted = updated[0]?.publicBaseUrl ?? null;
      if (!updated[0]) throw new Error("setup_state_expired");
      config = { ...config!, publicBaseUrl: persisted ?? origin };
      return persisted ?? origin;
    },
    authenticate: async githubUser => {
      const [knownUser] = await db<Array<{ isGlobalAdmin: boolean }>>`SELECT is_global_admin AS "isGlobalAdmin" FROM users WHERE github_user_id=${githubUser.id}`;
      const [installedOrganization] = await db`SELECT 1 FROM organizations o JOIN dashboard_installations i ON i.organization_id=o.id WHERE o.github_account_type='Organization' AND i.state IN ('pending','approved') LIMIT 1`;
      const githubOrganizationIds = installedOrganization && !knownUser?.isGlobalAdmin
        ? (await listGithubOrganizations(githubUser.accessToken)).map((organization) => organization.id)
        : [];
      const result = await db.begin(async (tx: TransactionSql) => {
        await tx`select pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))`;
        const rows = await tx<Array<{ setupCompletedAt: Date | string | null }>>`select setup_completed_at as "setupCompletedAt" from control_plane_config where singleton=true for update`;
        if (!rows[0]) throw new Error("setup_state_expired");
        const [administrator] = await tx`SELECT id FROM users WHERE github_user_id=${githubUser.id} AND is_global_admin=true`;
        const organizations = await tx<Array<{ id: string }>>`
          SELECT DISTINCT o.id FROM organizations o JOIN dashboard_installations i ON i.organization_id=o.id
          WHERE i.state IN ('pending','approved') AND (
            ${Boolean(administrator)} OR
            (o.github_account_type='User' AND o.github_org_id=${githubUser.id}) OR
            (o.github_account_type='Organization' AND o.github_org_id IN (SELECT value::bigint FROM jsonb_array_elements_text(${jsonParameter(db, githubOrganizationIds)}::jsonb)))
          )`;
        if (rows[0].setupCompletedAt && !administrator && organizations.length === 0) throw new Error("account_not_authorized");
        const users = await tx<Array<{ id: string }>>`insert into users (github_user_id, login) values (${githubUser.id}, ${githubUser.login}) on conflict (github_user_id) do update set login=excluded.login returning id`;
        const user = users[0]; if (!user) throw new Error("setup_authenticate_failed");
        if (rows[0].setupCompletedAt) {
          const organizationIds = organizations.map((organization) => organization.id);
          await tx`DELETE FROM memberships WHERE user_id=${user.id} AND organization_id NOT IN (SELECT value::uuid FROM jsonb_array_elements_text(${jsonParameter(db, organizationIds)}::jsonb))`;
          for (const organizationId of organizationIds) await tx`INSERT INTO memberships (organization_id,user_id,role) VALUES (${organizationId},${user.id},'member') ON CONFLICT (organization_id,user_id) DO NOTHING`;
          return { userId: user.id, firstAdmin: false };
        }
        const existing = await tx<Array<{ adminUserId: string | null }>>`select admin_user_id as "adminUserId" from system_onboarding where singleton=true for update`;
        if (existing[0]?.adminUserId && existing[0].adminUserId !== user.id) throw new Error("setup_admin_conflict");
        await tx`update users set is_global_admin=true where id=${user.id}`;
        await tx`update system_onboarding set admin_user_id=${user.id} where singleton=true and (admin_user_id is null or admin_user_id=${user.id})`;
        await tx`update control_plane_config set setup_completed_at=now(), updated_at=now() where singleton=true`;
        return { userId: user.id, firstAdmin: true };
      });
      config = { ...config!, setupCompletedAt: result.firstAdmin ? new Date() : config?.setupCompletedAt ?? null };
      return result;
    },
  };
  return { setup, masterKey };
}
