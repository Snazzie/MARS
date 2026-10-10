import { createHash, createPrivateKey, createSign, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import type { SecretBox } from "./auth.ts";
import { applyWorkflowMutation, discoverWorkflowFiles, previewWorkflowMutation, resolveWorkflowJob, type WorkflowMutation } from "./workflow-pr.ts";
import { browserLocation } from "./http-origin.ts";
type SetupState = { purpose: "oauth" | "manifest" | "install" | "organization_install"; userId: string | null; organizationId: string | null; idempotencyKey: string | null; encryptedState?: string; encryptedPkceVerifier?: string; expiresAt: number; consumedAt?: number };
type Installation = { organizationId: string; githubInstallationId: number; state: "pending" | "approved" | "suspended"; repositorySelection: "all" | "selected" | null; githubAccountId?: number };
type Repository = { id: string; installationId: number; organizationId?: string; fullName: string; visibility: "private" | "internal" | "public"; available: boolean };
type AppConfig = { id: number; slug: string; clientId?: string; pem: string; clientSecret: string; webhookSecret: string };
type Organization = { githubOrgId: number; githubAccountType?: "User" | "Organization"; login?: string };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SqlDatabase = DatabaseClient;
type MemoryMembership = { organizationId: string; userId: string; role: "owner" | "member" };
type MemoryDatabase = { setupStates: Map<string, SetupState>; installations: Map<number, Installation>; repositories: Map<string, Repository>; appConfig?: AppConfig; organizations?: Map<string, Organization>; memberships?: Map<string, MemoryMembership> };
type Database = SqlDatabase | MemoryDatabase;

const API = "https://api.github.com";
const isSql = (db: Database): db is SqlDatabase => typeof db === "object" && db !== null && "select" in db;
const nowMs = (value: Date | string | number) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
const visibilityOf = (repo: { private?: unknown; visibility?: unknown }): Repository["visibility"] => repo.visibility === "private" || repo.visibility === "internal" || repo.visibility === "public" ? repo.visibility : repo.private === true ? "private" : "public";

const stateFields = { purpose: schema.githubSetupStates.purpose, userId: schema.githubSetupStates.userId, organizationId: schema.githubSetupStates.organizationId, idempotencyKey: schema.githubSetupStates.idempotencyKey, encryptedState: schema.githubSetupStates.encryptedState, encryptedPkceVerifier: schema.githubSetupStates.encryptedPkceVerifier, expiresAt: schema.githubSetupStates.expiresAt, consumedAt: schema.githubSetupStates.consumedAt };
const queries = defineQueries((db) => ({
  findState: db.select(stateFields).from(schema.githubSetupStates).where(eq(schema.githubSetupStates.stateHash, sql`decode(${sql.placeholder("stateHash")},'hex')`)).prepare("github_app_state_find"),
  saveState: db.insert(schema.githubSetupStates).values({ stateHash: sql`decode(${sql.placeholder("stateHash")},'hex')`, purpose: sql.placeholder("purpose"), userId: sql.placeholder("userId"), organizationId: sql.placeholder("organizationId"), idempotencyKey: sql.placeholder("idempotencyKey"), encryptedState: sql.placeholder("encryptedState"), encryptedPkceVerifier: sql.placeholder("encryptedPkceVerifier"), expiresAt: sql`to_timestamp(${sql.placeholder("expiresAt")} / 1000.0)` }).onConflictDoUpdate({ target: schema.githubSetupStates.stateHash, set: { purpose: sql`${sql.placeholder("purpose")}`, userId: sql`${sql.placeholder("userId")}`, organizationId: sql`${sql.placeholder("organizationId")}`, idempotencyKey: sql`${sql.placeholder("idempotencyKey")}`, encryptedState: sql`${sql.placeholder("encryptedState")}`, encryptedPkceVerifier: sql`${sql.placeholder("encryptedPkceVerifier")}`, expiresAt: sql`to_timestamp(${sql.placeholder("expiresAt")} / 1000.0)` } }).prepare("github_app_state_save"),
  consumeSetup: db.update(schema.githubSetupStates).set({ consumedAt: sql`now()` }).where(and(eq(schema.githubSetupStates.stateHash, sql`decode(${sql.placeholder("stateHash")},'hex')`), eq(schema.githubSetupStates.purpose, sql.placeholder("purpose")), sql`${schema.githubSetupStates.expiresAt}>now()`, isNull(schema.githubSetupStates.consumedAt), or(eq(schema.githubSetupStates.userId, sql.placeholder("userId")), sql`${sql.placeholder("allowSetup")}::boolean`))).returning(stateFields).prepare("github_app_state_consume"),
  manifestState: db.select(stateFields).from(schema.githubSetupStates).where(and(eq(schema.githubSetupStates.purpose, "manifest"), eq(schema.githubSetupStates.idempotencyKey, sql.placeholder("idempotencyKey")), isNull(schema.githubSetupStates.consumedAt), sql`${schema.githubSetupStates.expiresAt}>now()`, or(eq(schema.githubSetupStates.userId, sql.placeholder("userId")), sql`${sql.placeholder("allowSetup")}::boolean`), or(eq(schema.githubSetupStates.organizationId, sql.placeholder("organizationId")), sql`${sql.placeholder("allowSetup")}::boolean`))).prepare("github_app_manifest_state"),
  unboundState: db.select(stateFields).from(schema.githubSetupStates).where(and(eq(schema.githubSetupStates.purpose, "organization_install"), eq(schema.githubSetupStates.userId, sql.placeholder("userId")), isNull(schema.githubSetupStates.organizationId), eq(schema.githubSetupStates.idempotencyKey, sql.placeholder("idempotencyKey")), isNull(schema.githubSetupStates.consumedAt), sql`${schema.githubSetupStates.expiresAt}>now()`)).prepare("github_app_unbound_state"),
  installState: db.select(stateFields).from(schema.githubSetupStates).where(and(eq(schema.githubSetupStates.purpose, sql.placeholder("purpose")), eq(schema.githubSetupStates.userId, sql.placeholder("userId")), eq(schema.githubSetupStates.organizationId, sql.placeholder("organizationId")), eq(schema.githubSetupStates.idempotencyKey, sql.placeholder("idempotencyKey")), isNull(schema.githubSetupStates.consumedAt), sql`${schema.githubSetupStates.expiresAt}>now()`)).prepare("github_app_install_state"),
  getConfig: db.select({ appId: schema.githubAppConfig.appId, slug: schema.githubAppConfig.slug, clientId: schema.githubAppConfig.clientId, pem: schema.githubAppConfig.encryptedPem, clientSecret: schema.githubAppConfig.encryptedClientSecret, webhookSecret: schema.githubAppConfig.encryptedWebhookSecret }).from(schema.githubAppConfig).where(eq(schema.githubAppConfig.singleton, true)).prepare("github_app_config_get"),
  saveConfig: db.insert(schema.githubAppConfig).values({ singleton: true, appId: sql.placeholder("appId"), slug: sql.placeholder("slug"), clientId: sql.placeholder("clientId"), encryptedPem: sql.placeholder("pem"), encryptedClientSecret: sql.placeholder("clientSecret"), encryptedWebhookSecret: sql.placeholder("webhookSecret") }).onConflictDoUpdate({ target: schema.githubAppConfig.singleton, set: { appId: sql`${sql.placeholder("appId")}`, slug: sql`${sql.placeholder("slug")}`, clientId: sql`${sql.placeholder("clientId")}`, encryptedPem: sql`${sql.placeholder("pem")}`, encryptedClientSecret: sql`${sql.placeholder("clientSecret")}`, encryptedWebhookSecret: sql`${sql.placeholder("webhookSecret")}`, updatedAt: sql`now()` } }).prepare("github_app_config_save"),
  latestInstallation: db.select({ githubInstallationId: schema.dashboardInstallations.githubInstallationId }).from(schema.dashboardInstallations).where(and(eq(schema.dashboardInstallations.organizationId, sql.placeholder("organizationId")), ne(schema.dashboardInstallations.state, "suspended"))).orderBy(desc(schema.dashboardInstallations.createdAt)).limit(1).prepare("github_app_latest_installation"),
  usableInstallation: db.select({ id: schema.dashboardInstallations.id }).from(schema.dashboardInstallations).where(and(eq(schema.dashboardInstallations.organizationId, sql.placeholder("organizationId")), inArray(schema.dashboardInstallations.repositorySelection, ["all", "selected"]), sql`exists (select 1 from dashboard_repositories r where r.installation_id=${schema.dashboardInstallations.id} and r.available=true)`)).orderBy(desc(schema.dashboardInstallations.createdAt)).limit(1).prepare("github_app_usable_installation"),
  linkOnboarding: db.update(schema.systemOnboarding).set({ organizationId: sql`${sql.placeholder("organizationId")}` }).where(and(eq(schema.systemOnboarding.singleton, true), eq(schema.systemOnboarding.adminUserId, sql.placeholder("userId")))).returning({ organizationId: schema.systemOnboarding.organizationId }).prepare("github_app_link_onboarding"),
  organizationAccount: db.select({ id: schema.organizations.githubOrgId, type: schema.organizations.githubAccountType }).from(schema.organizations).where(eq(schema.organizations.id, sql.placeholder("organizationId"))).prepare("github_app_organization_account"),
  findGithubAccount: db.select({ id: schema.organizations.id, login: schema.organizations.login }).from(schema.organizations).where(and(eq(schema.organizations.githubOrgId, sql.placeholder("githubAccountId")), eq(schema.organizations.githubAccountType, sql.placeholder("accountType")))).limit(1).prepare("github_app_find_account"),
  createOrganization: db.insert(schema.organizations).values({ githubOrgId: sql.placeholder("githubAccountId"), login: sql.placeholder("login"), githubAccountType: sql.placeholder("accountType") }).onConflictDoUpdate({ target: schema.organizations.githubOrgId, set: { login: sql`${sql.placeholder("login")}` }, setWhere: eq(schema.organizations.githubAccountType, sql.placeholder("accountType")) }).returning({ id: schema.organizations.id }).prepare("github_app_create_organization"),
  createMembership: db.insert(schema.memberships).values({ organizationId: sql.placeholder("organizationId"), userId: sql.placeholder("userId"), role: "owner" }).onConflictDoUpdate({ target: [schema.memberships.organizationId, schema.memberships.userId], set: { role: "owner" } }).prepare("github_app_create_membership"),
  saveInstallation: db.insert(schema.dashboardInstallations).values({ organizationId: sql.placeholder("organizationId"), githubInstallationId: sql.placeholder("installationId"), state: sql.placeholder("state"), repositorySelection: sql.placeholder("repositorySelection"), githubAccountId: sql.placeholder("githubAccountId") }).onConflictDoUpdate({ target: [schema.dashboardInstallations.organizationId, schema.dashboardInstallations.githubInstallationId], set: { state: sql`${sql.placeholder("state")}`, repositorySelection: sql`${sql.placeholder("repositorySelection")}`, githubAccountId: sql`${sql.placeholder("githubAccountId")}` } }).returning({ id: schema.dashboardInstallations.id }).prepare("github_app_save_installation"),
  saveRepository: db.insert(schema.dashboardRepositories).values({ organizationId: sql.placeholder("organizationId"), installationId: sql.placeholder("installationId"), githubRepositoryId: sql.placeholder("repositoryId"), name: sql.placeholder("name"), fullName: sql.placeholder("fullName"), visibility: sql.placeholder("visibility"), available: sql.placeholder("available") }).onConflictDoUpdate({ target: [schema.dashboardRepositories.organizationId, schema.dashboardRepositories.githubRepositoryId], set: { installationId: sql`${sql.placeholder("installationId")}`, visibility: sql`${sql.placeholder("visibility")}`, available: sql`${sql.placeholder("available")}`, fullName: sql`${sql.placeholder("fullName")}`, name: sql`${sql.placeholder("name")}` } }).prepare("github_app_save_repository"),
  completeOnboarding: db.update(schema.systemOnboarding).set({ organizationId: sql`${sql.placeholder("organizationId")}` }).where(and(eq(schema.systemOnboarding.singleton, true), eq(schema.systemOnboarding.adminUserId, sql.placeholder("userId")))).prepare("github_app_complete_onboarding"),
  refreshInstallation: db.select({ githubInstallationId: schema.dashboardInstallations.githubInstallationId }).from(schema.dashboardInstallations).where(and(eq(schema.dashboardInstallations.organizationId, sql.placeholder("organizationId")), ne(schema.dashboardInstallations.state, "suspended"))).orderBy(desc(schema.dashboardInstallations.createdAt)).limit(1).prepare("github_app_refresh_installation"),
  reconcileLookup: db.select({ id: schema.dashboardInstallations.id, organizationId: schema.dashboardInstallations.organizationId, state: schema.dashboardInstallations.state, repositorySelection: schema.dashboardInstallations.repositorySelection }).from(schema.dashboardInstallations).where(eq(schema.dashboardInstallations.githubInstallationId, sql.placeholder("installationId"))).prepare("github_app_reconcile_lookup"),
  snapshotRepositories: db.update(schema.dashboardRepositories).set({ available: false }).where(and(eq(schema.dashboardRepositories.installationId, sql.placeholder("installationId")), sql`${schema.dashboardRepositories.githubRepositoryId} NOT IN (SELECT value::bigint FROM jsonb_array_elements_text(${sql.placeholder("repositoryIds")}::jsonb))`)).prepare("github_app_snapshot_repositories"),
  suspendInstallation: db.update(schema.dashboardInstallations).set({ state: "suspended" }).where(eq(schema.dashboardInstallations.id, sql.placeholder("installationId"))).prepare("github_app_suspend_installation"),
  disableInstallationRepos: db.update(schema.dashboardRepositories).set({ available: false }).where(eq(schema.dashboardRepositories.installationId, sql.placeholder("installationId"))).prepare("github_app_disable_installation_repositories"),
  setRepositorySelection: db.update(schema.dashboardInstallations).set({ repositorySelection: sql`${sql.placeholder("repositorySelection")}` }).where(eq(schema.dashboardInstallations.id, sql.placeholder("installationId"))).prepare("github_app_set_repository_selection"),
  removeRepository: db.update(schema.dashboardRepositories).set({ available: false }).where(and(eq(schema.dashboardRepositories.installationId, sql.placeholder("installationId")), eq(schema.dashboardRepositories.githubRepositoryId, sql.placeholder("repositoryId")))).prepare("github_app_remove_repository"),
  updateInstallationState: db.update(schema.dashboardInstallations).set({ state: sql`case when ${schema.dashboardInstallations.state}='suspended' then ${schema.dashboardInstallations.state} when ${schema.dashboardInstallations.repositorySelection} in ('all','selected') and exists (select 1 from dashboard_repositories r where r.installation_id=${schema.dashboardInstallations.id} and r.available=true) then 'approved' else 'pending' end` }).where(eq(schema.dashboardInstallations.id, sql.placeholder("installationId"))).prepare("github_app_update_installation_state"),
  workflowRepository: db.select({ installationId: schema.dashboardInstallations.githubInstallationId, fullName: schema.dashboardRepositories.fullName, labels: sql`(select p.labels from runner_pools p where p.organization_id is null and p.enabled=true order by p.name limit 1)` }).from(schema.dashboardRepositories).innerJoin(schema.dashboardInstallations, eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId)).where(and(eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRepositories.id, sql.placeholder("repositoryId")), eq(schema.dashboardRepositories.available, true), eq(schema.dashboardInstallations.state, "approved"))).limit(1).prepare("github_app_workflow_repository"),
  markRepositoryUnavailable: db.update(schema.dashboardRepositories).set({ available: false }).where(and(eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRepositories.id, sql.placeholder("repositoryId")))).prepare("github_app_mark_repository_unavailable"),
}));
type WorkflowRepo = { installationId: number; fullName: string; defaultBranch: string; headSha: string; labels: string[] };
type InstallationToken = { token: string; expiresAt: number };
export class GitHubAppService {
  private readonly db: Database;
  private readonly fetcher: Fetcher;
  private readonly box: SecretBox;
  private readonly publicOrigin: () => string | null;
  private readonly webhookOrigin: () => string | null;
  private readonly installationTokens = new Map<number, InstallationToken>();
  private readonly installationTokenRequests = new Map<number, Promise<string>>();

  constructor(opts: { db: Database; fetch?: Fetcher; secretBox: SecretBox; publicOrigin: () => string | null; webhookOrigin?: () => string | null }) {
    this.db = opts.db;
    this.fetcher = opts.fetch ?? fetch;
    this.box = opts.secretBox;
    this.publicOrigin = opts.publicOrigin;
    this.webhookOrigin = opts.webhookOrigin ?? (() => null);
  }

  async getOAuthCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
    const config = await this.getConfig();
    if (!config?.clientId || !config.clientSecret) return null;
    return { clientId: config.clientId, clientSecret: this.box.decrypt(config.clientSecret) };
  }

  private stateKey(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }

  private async findState(raw: string): Promise<SetupState | null> {
    if (!isSql(this.db)) return this.db.setupStates.get(this.stateKey(raw)) ?? this.db.setupStates.get(raw) ?? null;
    const rows = await queries(this.db).findState.execute({ stateHash: this.stateKey(raw) });
    const row = rows[0];
    return row ? { purpose: row.purpose as SetupState["purpose"], userId: row.userId, organizationId: row.organizationId, idempotencyKey: row.idempotencyKey, encryptedState: row.encryptedState ?? undefined, encryptedPkceVerifier: row.encryptedPkceVerifier ?? undefined, expiresAt: nowMs(row.expiresAt), consumedAt: row.consumedAt ? nowMs(row.consumedAt) : undefined } : null;
  }

  private async saveState(raw: string, value: SetupState): Promise<void> {
    if (!isSql(this.db)) { this.db.setupStates.set(this.stateKey(raw), value); return; }
    await queries(this.db).saveState.execute({ stateHash: this.stateKey(raw), purpose: value.purpose, userId: value.userId === "setup" ? null : value.userId, organizationId: value.organizationId === "setup" ? null : value.organizationId, idempotencyKey: value.idempotencyKey, encryptedState: value.encryptedState ?? null, encryptedPkceVerifier: value.encryptedPkceVerifier ?? null, expiresAt: value.expiresAt });
  }

  private async consume(raw: string, userId: string, purpose: SetupState["purpose"]): Promise<SetupState> {
    if (!isSql(this.db)) {
      const state = this.db.setupStates.get(this.stateKey(raw)) ?? this.db.setupStates.get(raw);
      if (!state || state.purpose !== purpose || (userId !== "setup" && state.userId !== userId) || state.consumedAt || state.expiresAt < Date.now()) throw new Error("setup_state_expired");
      state.consumedAt = Date.now();
      return state;
    }
    const rows = await queries(this.db).consumeSetup.execute({ stateHash: this.stateKey(raw), purpose, userId: userId === "setup" ? null : userId, allowSetup: userId === "setup" });
    const row = rows[0];
    if (!row) throw new Error("setup_state_expired");
    return { purpose: row.purpose as SetupState["purpose"], userId: row.userId, organizationId: row.organizationId, idempotencyKey: row.idempotencyKey, encryptedState: row.encryptedState ?? undefined, encryptedPkceVerifier: row.encryptedPkceVerifier ?? undefined, expiresAt: nowMs(row.expiresAt), consumedAt: nowMs(row.consumedAt as string) };
  }

  private async getConfig(): Promise<AppConfig | null> {
    if (!isSql(this.db)) return this.db.appConfig ?? null;
    const rows = await queries(this.db).getConfig.execute();
    const row = rows[0];
    return row ? { id: Number(row.appId), slug: row.slug, clientId: row.clientId ?? undefined, pem: row.pem, clientSecret: row.clientSecret, webhookSecret: row.webhookSecret } : null;
  }

  private async saveConfig(config: AppConfig): Promise<void> {
    if (!isSql(this.db)) { this.db.appConfig = config; return; }
    await queries(this.db).saveConfig.execute({ appId: config.id, slug: config.slug, clientId: config.clientId ?? null, pem: config.pem, clientSecret: config.clientSecret, webhookSecret: config.webhookSecret });
  }

  private async githubResponse(path: string, init: RequestInit = {}, jwt?: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    headers.set("x-github-api-version", "2026-03-10");
    if (jwt) headers.set("authorization", `Bearer ${jwt}`);
    const response = await this.fetcher(`${API}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`github_${response.status}`);
    return response;
  }
  private async gh(path: string, init: RequestInit = {}, jwt?: string): Promise<Record<string, unknown>> {
    const response = await this.githubResponse(path, init, jwt);
    if (response.status === 204) return {};
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }
  async createManifestLaunch(userId: string, organizationId: string, idempotencyKey: string): Promise<{ action: string; manifest: string }> {
    if (!isSql(this.db)) {
      for (const state of this.db.setupStates.values()) if (state.purpose === "manifest" && (userId === "setup" || state.userId === userId) && (organizationId === "setup" || state.organizationId === organizationId) && state.idempotencyKey === idempotencyKey && !state.consumedAt && state.expiresAt > Date.now()) return { action: `https://github.com/settings/apps/new?state=${this.box.decrypt(state.encryptedState!)}`, manifest: this.box.decrypt(state.encryptedPkceVerifier!) };
    } else {
      const rows = await queries(this.db).manifestState.execute({ idempotencyKey, userId, organizationId, allowSetup: userId === "setup" });
      const state = rows[0];
      if (state?.encryptedState && state.encryptedPkceVerifier) return { action: `https://github.com/settings/apps/new?state=${this.box.decrypt(state.encryptedState)}`, manifest: this.box.decrypt(state.encryptedPkceVerifier) };
    }
    const origin = this.publicOrigin();
    if (!origin) throw new Error("setup_required");
    const webhookOrigin = this.webhookOrigin();
    if (!webhookOrigin) throw new Error("GITHUB_WEBHOOK_URL is required");
    const rawState = randomBytes(32).toString("base64url");
    const manifest = JSON.stringify({ name: "mars", public: true, url: origin, redirect_url: `${origin}/api/github/app/manifest/callback`, setup_url: `${origin}/api/github/app/setup`, hook_attributes: { url: `${webhookOrigin}/api/github/webhooks`, active: true }, description: "Mars self-hosted GitHub Actions runners", callback_urls: [`${origin}/api/auth/github/callback`], default_permissions: { actions: "write", contents: "write", members: "read", organization_self_hosted_runners: "write", pull_requests: "write", metadata: "read" }, default_events: ["workflow_job", "membership", "pull_request", "issue_comment"], request_oauth_on_install: false });
    await this.saveState(rawState, { purpose: "manifest", userId, organizationId, idempotencyKey, encryptedState: this.box.encrypt(rawState), encryptedPkceVerifier: this.box.encrypt(manifest), expiresAt: Date.now() + 3_600_000 });
    return { action: `https://github.com/settings/apps/new?state=${rawState}`, manifest };
  }

  async beginOrganizationInstallation(userId: string, organizationId: string, idempotencyKey: string): Promise<{ location: string; installCookie?: string }> {
    return this.beginInstallation(userId, organizationId, idempotencyKey, false, "organization_install");
  }
  async uninstallOrganization(organizationId: string): Promise<void> {
    let installationId: number | null = null;
    if (isSql(this.db)) {
      const rows = await queries(this.db).latestInstallation.execute({ organizationId });
      installationId = rows[0] ? Number(rows[0].githubInstallationId) : null;
    } else {
      const installation = [...this.db.installations.values()].find((value) => value.organizationId === organizationId && value.state !== "suspended");
      installationId = installation?.githubInstallationId ?? null;
    }
    if (!installationId) throw new Error("github_installation_not_found");
    try {
      await this.gh(`/app/installations/${installationId}`, { method: "DELETE" }, await this.appJwt());
    } catch (cause) {
      if (!(cause instanceof Error) || cause.message !== "github_404") throw cause;
    }
    await this.reconcileInstallationRepositories({ installation: { id: installationId }, action: "uninstalled" });
  }

  async beginUnboundInstallation(userId: string, idempotencyKey: string): Promise<{ location: string; installCookie?: string }> {
    const config = await this.getConfig();
    if (!config) throw new Error("github_app_unconfigured");
    if (isSql(this.db)) {
      const rows = await queries(this.db).unboundState.execute({ userId, idempotencyKey });
      const state = rows[0];
      if (state?.encryptedState) return { location: `https://github.com/apps/${config.slug}/installations/new`, installCookie: this.box.decrypt(state.encryptedState) };
    } else {
      for (const state of this.db.setupStates.values()) {
        if (state.purpose === "organization_install" && state.userId === userId && state.organizationId === null && state.idempotencyKey === idempotencyKey && !state.consumedAt && state.expiresAt > Date.now()) {
          return { location: `https://github.com/apps/${config.slug}/installations/new`, installCookie: this.box.decrypt(state.encryptedState!) };
        }
      }
    }
    const cookie = randomBytes(32).toString("base64url");
    await this.saveState(cookie, { purpose: "organization_install", userId, organizationId: null, idempotencyKey, encryptedState: this.box.encrypt(cookie), expiresAt: Date.now() + 600_000 });
    return { location: `https://github.com/apps/${config.slug}/installations/new`, installCookie: cookie };
  }

  async beginInstallation(userId: string, organizationId: string, idempotencyKey: string, bindOnboarding = true, purpose: SetupState["purpose"] = "install"): Promise<{ location: string; installCookie?: string }> {
    const config = await this.getConfig();
    if (!config) throw new Error("github_app_unconfigured");
    const slug = config.slug;
    if (isSql(this.db)) {
      const installations = await queries(this.db).usableInstallation.execute({ organizationId });
      if (installations[0]) {
        if (!bindOnboarding) throw new Error("github_organization_already_connected");
        const linked = await queries(this.db).linkOnboarding.execute({ organizationId, userId });
        const origin = this.publicOrigin();
        if (linked[0] && origin) return { location: browserLocation(origin, "/onboarding") };
      }
      const rows = await queries(this.db).installState.execute({ purpose, userId, organizationId, idempotencyKey });
      const state = rows[0];
      if (state?.encryptedState) return { location: `https://github.com/apps/${slug}/installations/new`, installCookie: this.box.decrypt(state.encryptedState) };
    } else {
      for (const state of this.db.setupStates.values()) if (state.purpose === purpose && state.userId === userId && state.organizationId === organizationId && state.idempotencyKey === idempotencyKey && !state.consumedAt && state.expiresAt > Date.now()) return { location: `https://github.com/apps/${slug}/installations/new`, installCookie: this.box.decrypt(state.encryptedState!) };
    }
    const cookie = randomBytes(32).toString("base64url");
    await this.saveState(cookie, { purpose, userId, organizationId, idempotencyKey, encryptedState: this.box.encrypt(cookie), expiresAt: Date.now() + 600_000 });
    return { location: `https://github.com/apps/${slug}/installations/new`, installCookie: cookie };
  }
  async completeManifestRegistration(userId: string, state: string, code: string): Promise<{ location: string; installCookie?: string }> {
    const setup = await this.consume(state, userId, "manifest");
    const result = await this.gh(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
    const id = typeof result.id === "number" ? result.id : 0;
    const slug = typeof result.slug === "string" ? result.slug : "mars";
    const pem = typeof result.pem === "string" ? result.pem : "";
    const clientId = typeof result.client_id === "string" ? result.client_id : undefined;
    const clientSecret = typeof result.client_secret === "string" ? result.client_secret : "";
    const webhookSecret = typeof result.webhook_secret === "string" ? result.webhook_secret : "";
    if (!id || !slug || !pem || !clientId || !clientSecret || !webhookSecret) throw new Error("github_manifest_invalid");
    await this.saveConfig({ id, slug, clientId, pem: this.box.encrypt(pem), clientSecret: this.box.encrypt(clientSecret), webhookSecret: this.box.encrypt(webhookSecret) });
    const origin = this.publicOrigin();
    if (!origin) throw new Error("setup_required");
    return { location: `${origin}/api/auth/github` };
  }

  private async appJwt(): Promise<string> {
    const config = await this.getConfig();
    const pem = config?.pem ? this.box.decrypt(config.pem) : "";
    if (!pem || !config) throw new Error("github_app_unconfigured");
    const key = createPrivateKey(pem);
    const now = Math.floor(Date.now() / 1000);
    const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: config.id })}`;
    const sign = createSign("RSA-SHA256");
    sign.update(input);
    return `${input}.${sign.sign(key).toString("base64url")}`;
  }
  private async installationRepositories(accessToken: string): Promise<{ repositorySelection: "all" | "selected"; repositories: Array<{ id: number; full_name: string; private?: boolean; visibility?: string }> }> {
    const repositories: Array<{ id: number; full_name: string; private?: boolean; visibility?: string }> = [];
    let repositorySelection: "all" | "selected" = "selected";
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.gh(`/installation/repositories?per_page=100&page=${page}`, {}, accessToken);
      if (response.repository_selection === "all") repositorySelection = "all";
      const rows = Array.isArray(response.repositories) ? response.repositories : [];
      for (const raw of rows) {
        if (!raw || typeof raw !== "object") continue;
        const value = raw as { id?: unknown; full_name?: unknown; private?: unknown; visibility?: unknown };
        if (typeof value.id === "number" && typeof value.full_name === "string") {
          repositories.push({
            id: value.id,
            full_name: value.full_name,
            private: typeof value.private === "boolean" ? value.private : undefined,
            visibility: typeof value.visibility === "string" ? value.visibility : undefined,
          });
        }
      }
      if (rows.length < 100) break;
    }
    return { repositorySelection, repositories };
  }

  private async organizationGithubAccount(organizationId: string): Promise<{ id: number; type: "User" | "Organization" } | null> {
    if (!isSql(this.db)) {
      const organization = this.db.organizations?.get(organizationId);
      return organization ? { id: organization.githubOrgId, type: organization.githubAccountType ?? "Organization" } : null;
    }
    const rows = await queries(this.db).organizationAccount.execute({ organizationId });
    return rows[0] ? { id: Number(rows[0].id), type: rows[0].type as "User" | "Organization" } : null;
  }
  private async findGithubAccount(githubAccountId: number, accountType: "User" | "Organization"): Promise<{ id: string; login: string } | null> {
    if (!isSql(this.db)) {
      for (const [id, organization] of this.db.organizations ?? []) {
        if (organization.githubOrgId === githubAccountId && (organization.githubAccountType ?? "Organization") === accountType) {
          return { id, login: organization.login ?? "" };
        }
      }
      return null;
    }
    const rows = await queries(this.db).findGithubAccount.execute({ githubAccountId, accountType });
    return rows[0] ? { id: rows[0].id, login: rows[0].login } : null;
  }

  private async createGithubOrganization(userId: string, accountId: number, accountType: "User" | "Organization", login: string): Promise<string> {
    if (!login.trim()) throw new Error("wrong_github_account");
    if (!isSql(this.db)) {
      const organizationId = randomUUID();
      if (!this.db.organizations) this.db.organizations = new Map();
      this.db.organizations.set(organizationId, { githubOrgId: accountId, githubAccountType: accountType, login });
      if (!this.db.memberships) this.db.memberships = new Map();
      this.db.memberships.set(`${organizationId}:${userId}`, { organizationId, userId, role: "owner" });
      return organizationId;
    }
    const rows = await queries(this.db).createOrganization.execute({ githubAccountId: accountId, login, accountType });
    const organizationId = rows[0]?.id;
    if (!organizationId) throw new Error("github_installation_persist_failed");
    await queries(this.db).createMembership.execute({ organizationId, userId });
    return organizationId;
  }

  private async persistInstallation(organizationId: string, installationId: number, state: Installation["state"], repositorySelection: Installation["repositorySelection"], githubAccountId: number, repos: Repository[]): Promise<string> {
    if (!isSql(this.db)) {
      this.db.installations.set(installationId, { organizationId, githubInstallationId: installationId, state, repositorySelection, githubAccountId });
      for (const repo of repos) this.db.repositories.set(repo.id, { ...repo, organizationId });
      return String(installationId);
    }
    return this.db.transaction(async (tx) => {
      const rows = await queries(tx).saveInstallation.execute({ organizationId, installationId, state, repositorySelection, githubAccountId });
      const installationRow = rows[0];
      if (!installationRow) throw new Error("github_installation_persist_failed");
      for (const repo of repos) await queries(tx).saveRepository.execute({ organizationId, installationId: installationRow.id, repositoryId: Number(repo.id), name: repo.fullName.split("/").at(-1) ?? repo.fullName, fullName: repo.fullName, visibility: repo.visibility, available: repo.available });
      return installationRow.id;
    });
  }

  async completeInstallation(userId: string, installCookie: string, installationId: number): Promise<boolean> {
    const pending = await this.findState(installCookie);
    if (!pending || !["install", "organization_install"].includes(pending.purpose) || pending.userId !== userId || pending.consumedAt || pending.expiresAt < Date.now()) throw new Error("setup_state_expired");
    const accountInfo = await this.gh(`/app/installations/${installationId}`, {}, await this.appJwt());
    const account = accountInfo.account && typeof accountInfo.account === "object" ? accountInfo.account as { type?: unknown; id?: unknown; login?: unknown } : {};
    const accountId = typeof account.id === "number" ? account.id : Number(account.id);
    const accountType = account.type === "User" || account.type === "Organization" ? account.type : null;
    const mismatchCode = accountType === "User" ? "wrong_github_account" : "wrong_organization";
    let organizationId: string;
    if (pending.organizationId !== null) {
      const expected = await this.organizationGithubAccount(pending.organizationId);
      if (!expected || !Number.isSafeInteger(accountId) || accountId <= 0 || !accountType || accountType !== expected.type || accountId !== expected.id) throw new Error(mismatchCode);
      organizationId = pending.organizationId;
    } else {
      if (!Number.isSafeInteger(accountId) || accountId <= 0 || !accountType) throw new Error("wrong_github_account");
      const existing = await this.findGithubAccount(accountId, accountType);
      organizationId = existing?.id ?? await this.createGithubOrganization(userId, accountId, accountType, typeof account.login === "string" ? account.login : "");
    }
    const token = await this.gh(`/app/installations/${installationId}/access_tokens`, { method: "POST" }, await this.appJwt());
    const accessToken = typeof token.token === "string" ? token.token : "";
    if (!accessToken) throw new Error("github_token_missing");
 
    const reposResponse = await this.installationRepositories(accessToken);
    const repositorySelection = accountInfo.repository_selection === "all" || reposResponse.repositorySelection === "all" ? "all" : "selected";
    const repos = reposResponse.repositories.map((value) => ({ id: String(value.id), installationId, fullName: value.full_name, visibility: visibilityOf(value), available: true } satisfies Repository));
    const hasAllowed = repos.length > 0;
    await this.persistInstallation(organizationId, installationId, hasAllowed ? "approved" : "pending", repositorySelection, accountId, repos);
    const setup = await this.consume(installCookie, userId, pending.purpose);
    const onboarding = setup.purpose === "install" || setup.organizationId === null;
    if (onboarding && isSql(this.db)) await queries(this.db).completeOnboarding.execute({ organizationId, userId });
    if (hasAllowed) return onboarding;
    throw new Error("repository_selection_required");
  }

  async refreshInstallationRepositories(organizationId: string): Promise<void> {
    let installationId: number | null = null;
    if (isSql(this.db)) {
      const rows = await queries(this.db).refreshInstallation.execute({ organizationId });
      installationId = rows[0] ? Number(rows[0].githubInstallationId) : null;
    } else {
      const row = [...this.db.installations.entries()].find(([, installation]) => installation.organizationId === organizationId && installation.state !== "suspended");
      installationId = row?.[0] ?? null;
    }
    if (!installationId) throw new Error("github_installation_not_found");
    const tokenResponse = await this.gh(`/app/installations/${installationId}/access_tokens`, { method: "POST" }, await this.appJwt());
    const token = typeof tokenResponse.token === "string" ? tokenResponse.token : "";
    if (!token) throw new Error("github_token_missing");
    const reposResponse = await this.installationRepositories(token);
    await this.reconcileInstallationRepositories({
      installation: { id: installationId },
      repository_selection: reposResponse.repositorySelection,
      repositories: reposResponse.repositories,
    });
  }

  async reconcileInstallationRepositories(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const data = payload as { installation?: { id?: number }; repository_selection?: "all" | "selected"; action?: string; repositories_removed?: Array<{ id: number }>; repositories_added?: Array<{ id: number; full_name: string; private?: boolean; visibility?: string }>; repositories?: Array<{ id: number; full_name: string; private?: boolean; visibility?: string }> };
    const id = Number(data.installation?.id);
    if (!isSql(this.db)) {
      const installation = this.db.installations.get(id);
      for (const repo of data.repositories_removed ?? []) {
        const existing = this.db.repositories.get(String(repo.id));
        if (existing) existing.available = false;
      }
      if (!installation) return;
      if (["suspend", "suspended", "deleted", "uninstalled"].includes(data.action ?? "")) {
        installation.state = "suspended";
        if (["deleted", "uninstalled"].includes(data.action ?? "")) {
          for (const repo of this.db.repositories.values()) if (repo.installationId === id) repo.available = false;
        }
      }
      if (data.repository_selection) installation.repositorySelection = data.repository_selection;
      const effectiveSelection = installation.repositorySelection;
      const fullSnapshot = data.repositories !== undefined;
      if (fullSnapshot) {
        const snapshotIds = new Set(data.repositories!.map((repo) => String(repo.id)));
        for (const repo of this.db.repositories.values()) if (repo.installationId === id && !snapshotIds.has(repo.id)) repo.available = false;
      }
      for (const raw of data.repositories_added ?? data.repositories ?? []) {
        const visibility = visibilityOf(raw);
        const existing = this.db.repositories.get(String(raw.id));
        const value = { id: String(raw.id), installationId: id, fullName: raw.full_name, visibility, available: true };
        this.db.repositories.set(String(raw.id), existing ? { ...existing, ...value } : value);
      }
      if (installation.state !== "suspended") {
        installation.state = effectiveSelection === "selected" || effectiveSelection === "all" ? "approved" : "pending";
      }
      return;
    }
    const installations = await queries(this.db).reconcileLookup.execute({ installationId: id });
    const installation = installations[0];
    if (!installation) return;
    const fullSnapshot = data.repositories !== undefined;
    if (fullSnapshot) await queries(this.db).snapshotRepositories.execute({ installationId: installation.id, repositoryIds: JSON.stringify(data.repositories!.map((repo) => repo.id)) });
    if (["suspend", "suspended", "deleted", "uninstalled"].includes(data.action ?? "")) {
      await queries(this.db).suspendInstallation.execute({ installationId: installation.id });
      if (["deleted", "uninstalled"].includes(data.action ?? "")) await queries(this.db).disableInstallationRepos.execute({ installationId: installation.id });
    }
    if (data.repository_selection) await queries(this.db).setRepositorySelection.execute({ installationId: installation.id, repositorySelection: data.repository_selection });
    for (const repo of data.repositories_removed ?? []) await queries(this.db).removeRepository.execute({ installationId: installation.id, repositoryId: repo.id });
    for (const raw of data.repositories_added ?? data.repositories ?? []) await queries(this.db).saveRepository.execute({ organizationId: installation.organizationId, installationId: installation.id, repositoryId: raw.id, name: raw.full_name.split("/").at(-1) ?? raw.full_name, fullName: raw.full_name, visibility: visibilityOf(raw), available: true });
    await queries(this.db).updateInstallationState.execute({ installationId: installation.id });
  }
  private async fetchInstallationToken(installationId: number): Promise<string> {
    const response = await this.gh(`/app/installations/${installationId}/access_tokens`, { method: "POST" }, await this.appJwt());
    const token = typeof response.token === "string" && response.token.trim() ? response.token : "";
    if (!token) throw new Error("github_token_missing");
    const expiresAt = typeof response.expires_at === "string" ? Date.parse(response.expires_at) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("github_token_expiry_invalid");
    this.installationTokens.set(installationId, { token, expiresAt });
    return token;
  }
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
    const inFlight = this.installationTokenRequests.get(installationId);
    if (inFlight) return inFlight;
    const request = this.fetchInstallationToken(installationId);
    this.installationTokenRequests.set(installationId, request);
    try {
      return await request;
    } finally {
      if (this.installationTokenRequests.get(installationId) === request) this.installationTokenRequests.delete(installationId);
    }
  }
  async getInstallationRateLimit(installationId: number): Promise<{ limit: number; remaining: number; used: number; resetAt: string }> {
    const token = await this.getInstallationToken(installationId);
    const headers = new Headers({ accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", authorization: `Bearer ${token}` });
    const response = await this.fetcher(`${API}/installation/repositories?per_page=1`, { headers });
    if (!response.ok && response.status !== 403 && response.status !== 429) throw new Error(`github_${response.status}`);
    const header = (name: string): number => {
      const raw = response.headers.get(name)?.trim() ?? "";
      if (!/^\d+$/.test(raw)) throw new Error("github_rate_limit_invalid");
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) throw new Error("github_rate_limit_invalid");
      return value;
    };
    const reset = header("x-ratelimit-reset");
    const resetMs = reset * 1000;
    const resetDate = new Date(resetMs);
    if (!Number.isFinite(resetMs) || resetMs > 8_640_000_000_000_000 || Number.isNaN(resetDate.getTime())) throw new Error("github_rate_limit_invalid");
    return {
      limit: header("x-ratelimit-limit"),
      remaining: header("x-ratelimit-remaining"),
      used: header("x-ratelimit-used"),
      resetAt: resetDate.toISOString(),
    };
  }

  async getWebhookSecret(): Promise<string | null> {
    const config = await this.getConfig();
    return config?.webhookSecret ? this.box.decrypt(config.webhookSecret) : null;
  }
  private async workflowRepo(organizationId: string, repositoryId: string): Promise<WorkflowRepo> {
    if (!isSql(this.db)) {
      const repo = this.db.repositories.get(repositoryId);
      const installation = repo && this.db.installations.get(repo.installationId);
      if (!repo || !installation || repo.organizationId !== organizationId || !repo.available || installation.state !== "approved") throw new Error("github_repository_unavailable");
      return { installationId: installation.githubInstallationId, fullName: repo.fullName, defaultBranch: "main", headSha: "", labels: [] };
    }
    const rows = await queries(this.db).workflowRepository.execute({ organizationId, repositoryId });
    const row = rows[0];
    if (!row) throw new Error("github_repository_unavailable");
    const labels = Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === "string") : typeof row.labels === "string" ? (JSON.parse(row.labels) as unknown[]).filter((label): label is string => typeof label === "string") : [];
    if (!labels.length) throw new Error("github_runner_pool_missing");
    return { installationId: Number(row.installationId), fullName: row.fullName, defaultBranch: "", headSha: "", labels };
  }

  private async listRepositoryWorkflowsWithToken(owner: string, repo: string, token: string): Promise<{ defaultBranch: string; files: Array<{ path: string; sha: string; content: string }> }> {
    const metadata = await this.gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {}, token);
    const defaultBranch = typeof metadata.default_branch === "string" ? metadata.default_branch : "";
    if (!defaultBranch) throw new Error("github_default_branch_missing");
    const tree = await this.gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`, {}, token);
    const entries = Array.isArray(tree.tree) ? tree.tree : [];
    const files: Array<{ path: string; sha: string; content: string }> = [];
    for (const entry of entries) {
      const value = entry as { path?: unknown; type?: unknown; sha?: unknown; url?: unknown };
      if (value.type !== "blob" || typeof value.path !== "string" || !/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/.test(value.path) || typeof value.sha !== "string") continue;
      const blob = await this.gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${value.sha}`, {}, token);
      const encoded = typeof blob.content === "string" ? blob.content.replace(/\s/g, "") : "";
      files.push({ path: value.path, sha: value.sha, content: Buffer.from(encoded, "base64").toString("utf8") });
    }
    return { defaultBranch, files };
  }

  async listRepositoryWorkflows(owner: string, repo: string, installationId: number): Promise<{ defaultBranch: string; files: Array<{ path: string; sha: string; content: string }> }> {
    return this.listRepositoryWorkflowsWithToken(owner, repo, await this.getInstallationToken(installationId));
  }

  private async workflowContext(organizationId: string, repositoryId: string): Promise<{ repo: WorkflowRepo; owner: string; name: string; token: string }> {
    const repo = await this.workflowRepo(organizationId, repositoryId);
    const [owner, name] = repo.fullName.split("/", 2);
    if (!owner || !name) throw new Error("github_repository_invalid");
    const token = await this.getInstallationToken(repo.installationId);
    return { repo, owner, name, token };
  }

  private async markRepositoryUnavailable(organizationId: string, repositoryId: string): Promise<void> {
    if (isSql(this.db)) {
      await queries(this.db).markRepositoryUnavailable.execute({ organizationId, repositoryId });
      return;
    }
    const repository = this.db.repositories.get(repositoryId);
    if (repository?.organizationId === organizationId) repository.available = false;
  }

  private async repositoryOperation<T>(organizationId: string, repositoryId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "github_404") throw error;
      await this.markRepositoryUnavailable(organizationId, repositoryId);
      throw new Error("github_repository_unavailable");
    }
  }

  async listRepositoryRunnerWorkflows(input: { organizationId: string; repositoryId: string }): Promise<{ defaultBranch: string; files: Array<{ path: string; sha: string; content: string }> }> {
    const ctx = await this.workflowContext(input.organizationId, input.repositoryId);
    return this.repositoryOperation(input.organizationId, input.repositoryId, () => this.listRepositoryWorkflowsWithToken(ctx.owner, ctx.name, ctx.token));
  }

  async resolveWorkflowJob(input: { organizationId: string; repositoryId: string; workflowName: string; jobName: string }): Promise<{ path: string; jobId: string; currentRunsOn: string | readonly string[] }> {
    const ctx = await this.workflowContext(input.organizationId, input.repositoryId);
    return this.repositoryOperation(input.organizationId, input.repositoryId, async () => {
      const listing = await this.listRepositoryWorkflowsWithToken(ctx.owner, ctx.name, ctx.token);
      return resolveWorkflowJob(listing.files, input.workflowName, input.jobName);
    });
  }
  async dispatchRepositoryWorkflow(input: { organizationId: string; repositoryId: string; workflowPath: string }): Promise<{ githubRunId: number }> {
    const ctx = await this.workflowContext(input.organizationId, input.repositoryId);
    return this.repositoryOperation(input.organizationId, input.repositoryId, async () => {
      const listing = await this.listRepositoryWorkflowsWithToken(ctx.owner, ctx.name, ctx.token);
      if (!listing.files.some((file) => file.path === input.workflowPath)) throw new Error("github_workflow_not_found");
      const workflow = encodeURIComponent(input.workflowPath);
      const runsPath = `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.name)}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`;
      const before = await this.gh(runsPath, {}, ctx.token);
      const priorIds = new Set((Array.isArray(before.workflow_runs) ? before.workflow_runs : []).map((run) => Number((run as { id?: unknown }).id)).filter(Number.isSafeInteger));
      await this.gh(`/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.name)}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: listing.defaultBranch }),
      }, ctx.token);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await this.gh(runsPath, {}, ctx.token);
        const run = (Array.isArray(response.workflow_runs) ? response.workflow_runs : []).find((candidate) => {
          const value = candidate as { id?: unknown; event?: unknown };
          const id = Number(value.id);
          return Number.isSafeInteger(id) && id > 0 && value.event === "workflow_dispatch" && !priorIds.has(id);
        }) as { id?: unknown } | undefined;
        const githubRunId = Number(run?.id);
        if (Number.isSafeInteger(githubRunId) && githubRunId > 0) return { githubRunId };
        if (attempt < 5) await Bun.sleep(500);
      }
      throw new Error("github_workflow_run_not_observed");
    });
  }
  async previewRepositoryRunnerPr(input: { organizationId: string; repositoryId: string; selectedPaths?: string[]; selectedPath?: string; selectedJobId?: string; labels?: string[] }): Promise<WorkflowMutation & { defaultBranch: string; headSha: string; labels: string[] }> {
    const ctx = await this.workflowContext(input.organizationId, input.repositoryId);
    return this.repositoryOperation(input.organizationId, input.repositoryId, async () => {
      const listing = await this.listRepositoryWorkflowsWithToken(ctx.owner, ctx.name, ctx.token);
      const files = discoverWorkflowFiles(listing.files);
      const focused = input.selectedPath !== undefined || input.selectedJobId !== undefined;
      const labels = focused ? input.labels : ctx.repo.labels;
      if (focused && !labels) throw new Error("Focused workflow selection requires editable labels");
      const mutation = previewWorkflowMutation({
        files,
        selectedPaths: input.selectedPaths ?? [],
        selectedPath: input.selectedPath,
        selectedJobId: input.selectedJobId,
        labels: labels ?? [],
      });
      const ref = await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/ref/heads/${encodeURIComponent(listing.defaultBranch)}`, {}, ctx.token);
      const headSha = ref.object && typeof ref.object === "object" && typeof (ref.object as { sha?: unknown }).sha === "string" ? (ref.object as { sha: string }).sha : "";
      const firstProposedLabels = mutation.jobs[0]?.proposedRunsOn;
      const resultLabels = firstProposedLabels ? [...firstProposedLabels] : labels ?? [];
      return { ...mutation, defaultBranch: listing.defaultBranch, headSha, labels: resultLabels };
    });
  }

  async createRepositoryRunnerPr(input: { organizationId: string; repositoryId: string; selectedPaths?: string[]; selectedPath?: string; selectedJobId?: string; labels?: string[]; p95CpuPeakPercent?: number; p95MemoryPeakBytes?: number; successfulRunCount?: number; expectedHeadSha: string; title?: string; body?: string }): Promise<{ url: string; number: number; branch: string; changedFiles: string[]; replacementCount: number }> {
    const ctx = await this.workflowContext(input.organizationId, input.repositoryId);
    return this.repositoryOperation(input.organizationId, input.repositoryId, async () => {
      const listing = await this.listRepositoryWorkflowsWithToken(ctx.owner, ctx.name, ctx.token);
      const ref = await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/ref/heads/${encodeURIComponent(listing.defaultBranch)}`, {}, ctx.token);
      const headSha = ref.object && typeof ref.object === "object" && typeof (ref.object as { sha?: unknown }).sha === "string" ? (ref.object as { sha: string }).sha : "";
      if (headSha !== input.expectedHeadSha) throw new Error("github_workflow_head_stale");
      const files = discoverWorkflowFiles(listing.files);
      const focused = input.selectedPath !== undefined || input.selectedJobId !== undefined;
      const labels = focused ? input.labels : ctx.repo.labels;
      if (focused && !labels) throw new Error("Focused workflow selection requires editable labels");
      const mutation = previewWorkflowMutation({
        files,
        selectedPaths: input.selectedPaths ?? [],
        selectedPath: input.selectedPath,
        selectedJobId: input.selectedJobId,
        labels: labels ?? [],
      });
      if (focused && mutation.noOp) throw new Error("Workflow mutation would be a no-op");
      const changed = listing.files.filter((file) => mutation.changedFiles.includes(file.path)).map((file) => ({
        ...file,
        content: applyWorkflowMutation(file.content, labels ?? [], input.selectedJobId, focused),
      }));
      const branch = `mars/use-runners-${randomBytes(6).toString("hex")}`;
      const blobs = await Promise.all(changed.map(async (file) => ({ path: file.path, mode: "100644", type: "blob", sha: (await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/blobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: file.content, encoding: "utf-8" }) }, ctx.token)).sha as string })));
      const tree = await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/trees`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_tree: headSha, tree: blobs }) }, ctx.token);
      const commit = await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/commits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Configure Mars runners", tree: tree.sha, parents: [headSha] }) }, ctx.token);
      await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/refs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) }, ctx.token);
      const resultLabels = mutation.jobs[0]?.proposedRunsOn ? [...mutation.jobs[0].proposedRunsOn] : labels ?? [];
      const generatedBody = focused
        ? [
          "Configure GitHub Actions workflows to use Mars runners.",
          `P95 CPU peak: ${input.p95CpuPeakPercent === undefined ? "unknown" : `${input.p95CpuPeakPercent}%`}`,
          `P95 memory peak: ${input.p95MemoryPeakBytes === undefined ? "unknown" : `${input.p95MemoryPeakBytes} bytes`}`,
          `Successful sample count: ${input.successfulRunCount ?? "unknown"}`,
          `Labels: ${resultLabels.join(", ")}`,
        ].join("\n")
        : "Configure GitHub Actions workflows to use Mars runners.";
      const pr = await this.gh(`/repos/${ctx.owner}/${ctx.name}/pulls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: input.title?.trim() || "Use Mars runners", body: input.body?.trim() || generatedBody, head: branch, base: listing.defaultBranch }) }, ctx.token);
      return { url: String(pr.html_url ?? ""), number: Number(pr.number ?? 0), branch, changedFiles: mutation.changedFiles, replacementCount: mutation.replacementCount };
    });
  }
}
