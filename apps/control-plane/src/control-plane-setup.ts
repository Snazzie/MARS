import { mkdir, chmod, readFile, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import { httpOrigin } from "./http-origin.ts";
import { listGithubOrganizations, type OAuthUser } from "./github.ts";
const SETUP_LOCK = "mars:control-plane-setup";
const masterPath = (root: string) => join(root, "app_master_key");
const setupQueries = defineQueries((db) => ({
  readConfig: db.select({ publicBaseUrl: schema.controlPlaneConfig.publicBaseUrl, setupCompletedAt: schema.controlPlaneConfig.setupCompletedAt }).from(schema.controlPlaneConfig).where(eq(schema.controlPlaneConfig.singleton, true)).prepare("setup_read_config"),
  insertConfig: db.insert(schema.controlPlaneConfig).values({ singleton: true }).onConflictDoNothing({ target: schema.controlPlaneConfig.singleton }).prepare("setup_insert_config"),
  insertOnboarding: db.insert(schema.systemOnboarding).values({ singleton: true }).onConflictDoNothing({ target: schema.systemOnboarding.singleton }).prepare("setup_insert_onboarding"),
  environmentOrigin: db.insert(schema.controlPlaneConfig).values({ singleton: true, publicBaseUrl: sql.placeholder("origin") }).onConflictDoUpdate({ target: schema.controlPlaneConfig.singleton, set: { publicBaseUrl: sql`${sql.placeholder("origin")}`, updatedAt: sql`now()` } }).prepare("setup_environment_origin"),
  configureOrigin: db.update(schema.controlPlaneConfig).set({ publicBaseUrl: sql`${sql.placeholder("origin")}`, updatedAt: sql`now()` }).where(and(eq(schema.controlPlaneConfig.singleton, true), isNull(schema.controlPlaneConfig.setupCompletedAt))).returning({ publicBaseUrl: schema.controlPlaneConfig.publicBaseUrl }).prepare("setup_configure_origin"),
  knownUser: db.select({ isGlobalAdmin: schema.users.isGlobalAdmin }).from(schema.users).where(eq(schema.users.githubUserId, sql.placeholder("githubId"))).prepare("setup_known_user"),
  installedOrganization: db.select({ id: schema.organizations.id }).from(schema.organizations).innerJoin(schema.dashboardInstallations, eq(schema.dashboardInstallations.organizationId, schema.organizations.id)).where(and(eq(schema.organizations.githubAccountType, "Organization"), inArray(schema.dashboardInstallations.state, ["pending", "approved"]))).limit(1).prepare("setup_installed_org"),
  setupLock: db.select({ locked: sql`pg_advisory_xact_lock(hashtext(${SETUP_LOCK}))` }).from(sql`(SELECT 1) AS singleton`).prepare("setup_lock"),
  lockConfig: db.select({ setupCompletedAt: schema.controlPlaneConfig.setupCompletedAt }).from(schema.controlPlaneConfig).where(eq(schema.controlPlaneConfig.singleton, true)).for("update").prepare("setup_lock_config"),
  administrator: db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.githubUserId, sql.placeholder("githubId")), eq(schema.users.isGlobalAdmin, true))).prepare("setup_administrator"),
  authorizedOrganizations: db.selectDistinct({ id: schema.organizations.id }).from(schema.organizations).innerJoin(schema.dashboardInstallations, eq(schema.dashboardInstallations.organizationId, schema.organizations.id))
    .where(and(inArray(schema.dashboardInstallations.state, ["pending", "approved"]), or(sql`${sql.placeholder("isAdministrator")}`, and(eq(schema.organizations.githubAccountType, "User"), eq(schema.organizations.githubOrgId, sql.placeholder("githubId"))), and(eq(schema.organizations.githubAccountType, "Organization"), sql`${schema.organizations.githubOrgId} IN (SELECT value::bigint FROM jsonb_array_elements_text(${sql.placeholder("organizationIds")}::jsonb))`)))).prepare("setup_authorized_organizations"),
  upsertUser: db.insert(schema.users).values({ githubUserId: sql.placeholder("githubId"), login: sql.placeholder("login") }).onConflictDoUpdate({ target: schema.users.githubUserId, set: { login: sql`${sql.placeholder("login")}` } }).returning({ id: schema.users.id }).prepare("setup_upsert_user"),
  deleteUnauthorizedMemberships: db.delete(schema.memberships).where(and(eq(schema.memberships.userId, sql.placeholder("userId")), sql`${schema.memberships.organizationId} NOT IN (SELECT value::uuid FROM jsonb_array_elements_text(${sql.placeholder("organizationIds")}::jsonb))`)).prepare("setup_delete_memberships"),
  addMembership: db.insert(schema.memberships).values({ organizationId: sql.placeholder("organizationId"), userId: sql.placeholder("userId"), role: "member" }).onConflictDoNothing({ target: [schema.memberships.organizationId, schema.memberships.userId] }).prepare("setup_add_membership"),
  lockOnboarding: db.select({ adminUserId: schema.systemOnboarding.adminUserId }).from(schema.systemOnboarding).where(eq(schema.systemOnboarding.singleton, true)).for("update").prepare("setup_lock_onboarding"),
  grantAdmin: db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, sql.placeholder("userId"))).prepare("setup_grant_admin"),
  setOnboardingAdmin: db.update(schema.systemOnboarding).set({ adminUserId: sql`${sql.placeholder("userId")}` }).where(and(eq(schema.systemOnboarding.singleton, true), or(isNull(schema.systemOnboarding.adminUserId), eq(schema.systemOnboarding.adminUserId, sql.placeholder("userId"))))).prepare("setup_set_onboarding_admin"),
  completeSetup: db.update(schema.controlPlaneConfig).set({ setupCompletedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(schema.controlPlaneConfig.singleton, true)).prepare("setup_complete"),
}));


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

type ConfigRow = { publicBaseUrl: string | null; setupCompletedAt: Date | string | null };
export type ControlPlaneSetup = {
  publicOrigin(): string | null;
  publicOriginManaged(): boolean;
  configure(candidateOrigin: string): Promise<string>;
  authenticate(githubUser: OAuthUser): Promise<{ userId: string; firstAdmin: boolean }>;
};
async function readConfig(db: DatabaseClient): Promise<ConfigRow | null> {
  const rows = await setupQueries(db).readConfig.execute();
  return rows[0] ?? null;
}
export async function initializeControlPlaneSetup(db: DatabaseClient, dataRoot: string, configuredOrigin?: string): Promise<{ setup: ControlPlaneSetup; masterKey: string }> {
  const environmentOrigin = configuredOrigin?.trim() ? httpOrigin("PUBLIC_BASE_URL", configuredOrigin) : undefined;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 }); await chmod(dataRoot, 0o700);
  const masterKey = Bun.env.APP_MASTER_KEY?.trim() ?? await loadOrCreateMasterKey(dataRoot);
  if (!validKey(masterKey)) throw new Error("APP_MASTER_KEY must be base64-encoded 32 bytes");
  let config = await readConfig(db);
  if (!config) { await setupQueries(db).insertConfig.execute(); config = await readConfig(db); }
  await setupQueries(db).insertOnboarding.execute();
  config ??= { publicBaseUrl: null, setupCompletedAt: null };
  if (environmentOrigin) {
    await setupQueries(db).environmentOrigin.execute({ origin: environmentOrigin });
    config = { ...config, publicBaseUrl: environmentOrigin };
  }
  const setup: ControlPlaneSetup = {
    publicOrigin: () => config?.publicBaseUrl ?? null,
    publicOriginManaged: () => Boolean(environmentOrigin),
    configure: async candidateOrigin => {
      const origin = httpOrigin("PUBLIC_BASE_URL", candidateOrigin);
      if (environmentOrigin && origin !== environmentOrigin) throw new Error("configured_origin_mismatch");
      const updated = await setupQueries(db).configureOrigin.execute({ origin });
      const persisted = updated[0]?.publicBaseUrl ?? null;
      if (!updated[0]) throw new Error("setup_state_expired");
      config = { ...config!, publicBaseUrl: persisted ?? origin };
      return persisted ?? origin;
    },
    authenticate: async githubUser => {
      const [knownUser] = await setupQueries(db).knownUser.execute({ githubId: githubUser.id });
      const [installedOrganization] = await setupQueries(db).installedOrganization.execute();
      const githubOrganizationIds = installedOrganization && !knownUser?.isGlobalAdmin
        ? (await listGithubOrganizations(githubUser.accessToken)).map((organization) => organization.id)
        : [];
      const result = await db.transaction(async tx => {
        const queries = setupQueries(tx);
        await queries.setupLock.execute();
        const rows = await queries.lockConfig.execute();
        if (!rows[0]) throw new Error("setup_state_expired");
        const [administrator] = await queries.administrator.execute({ githubId: githubUser.id });
        const organizations = await queries.authorizedOrganizations.execute({
          isAdministrator: Boolean(administrator), githubId: githubUser.id,
          organizationIds: JSON.stringify(githubOrganizationIds),
        });
        if (rows[0].setupCompletedAt && !administrator && organizations.length === 0) throw new Error("account_not_authorized");
        const users = await queries.upsertUser.execute({ githubId: githubUser.id, login: githubUser.login });
        const user = users[0]; if (!user) throw new Error("setup_authenticate_failed");
        if (rows[0].setupCompletedAt) {
          const organizationIds = organizations.map((organization) => organization.id);
          await queries.deleteUnauthorizedMemberships.execute({ userId: user.id, organizationIds: JSON.stringify(organizationIds) });
          for (const organizationId of organizationIds) await queries.addMembership.execute({ organizationId, userId: user.id });
          return { userId: user.id, firstAdmin: false };
        }
        const existing = await queries.lockOnboarding.execute();
        if (existing[0]?.adminUserId && existing[0].adminUserId !== user.id) throw new Error("setup_admin_conflict");
        await queries.grantAdmin.execute({ userId: user.id });
        await queries.setOnboardingAdmin.execute({ userId: user.id });
        await queries.completeSetup.execute();
        return { userId: user.id, firstAdmin: true };
      });
      config = { ...config!, setupCompletedAt: result.firstAdmin ? new Date() : config?.setupCompletedAt ?? null };
      return result;
    },
  };
  return { setup, masterKey };
}
