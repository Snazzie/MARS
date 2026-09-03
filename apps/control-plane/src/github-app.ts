import { createHash, createPrivateKey, createSign, randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "@mars/db";
import type { SecretBox } from "./auth.ts";
import { applyWorkflowMutation, discoverWorkflowFiles, previewWorkflowMutation, type WorkflowFilePreview, type WorkflowMutation } from "./workflow-pr.ts";
import { browserLocation } from "./http-origin.ts";
type SetupState = { purpose: "oauth" | "manifest" | "install" | "organization_install"; userId: string | null; organizationId: string | null; idempotencyKey: string | null; encryptedState?: string; encryptedPkceVerifier?: string; expiresAt: number; consumedAt?: number };
type Installation = { organizationId: string; githubInstallationId: number; state: "pending" | "approved" | "suspended"; repositorySelection: "all" | "selected" | null; githubAccountId?: number };
type Repository = { id: string; installationId: number; organizationId?: string; fullName: string; visibility: "private" | "internal" | "public"; available: boolean };
type AppConfig = { id: number; slug: string; clientId?: string; pem: string; clientSecret: string; webhookSecret: string };
type Organization = { githubOrgId: number; githubAccountType?: "User" | "Organization"; login?: string };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SqlDatabase = Sql<{}>;
type MemoryMembership = { organizationId: string; userId: string; role: "owner" | "member" };
type MemoryDatabase = { setupStates: Map<string, SetupState>; installations: Map<number, Installation>; repositories: Map<string, Repository>; appConfig?: AppConfig; organizations?: Map<string, Organization>; memberships?: Map<string, MemoryMembership> };
type Database = SqlDatabase | MemoryDatabase;

type SetupRow = { purpose: SetupState["purpose"]; user_id: string | null; organization_id: string | null; idempotency_key: string | null; encrypted_state: string | null; encrypted_pkce_verifier: string | null; expires_at: Date | string; consumed_at: Date | string | null };
const API = "https://api.github.com";
const isSql = (db: Database): db is SqlDatabase => typeof db === "function";
const nowMs = (value: Date | string | number) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
const visibilityOf = (repo: { private?: unknown; visibility?: unknown }): Repository["visibility"] => repo.visibility === "private" || repo.visibility === "internal" || repo.visibility === "public" ? repo.visibility : repo.private === true ? "private" : "public";

type WorkflowRepo = { installationId: number; fullName: string; defaultBranch: string; headSha: string; labels: string[] };
export class GitHubAppService {
  private readonly db: Database;
  private readonly fetcher: Fetcher;
  private readonly box: SecretBox;
  private readonly publicOrigin: () => string | null;
  private readonly webhookOrigin: () => string | null;

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
    const rows = await this.db<SetupRow[]>`SELECT purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at FROM github_setup_states WHERE state_hash=decode(${this.stateKey(raw)},'hex')`;
    const row = rows[0];
    return row ? { purpose: row.purpose, userId: row.user_id, organizationId: row.organization_id, idempotencyKey: row.idempotency_key, encryptedState: row.encrypted_state ?? undefined, encryptedPkceVerifier: row.encrypted_pkce_verifier ?? undefined, expiresAt: nowMs(row.expires_at), consumedAt: row.consumed_at ? nowMs(row.consumed_at) : undefined } : null;
  }

  private async saveState(raw: string, value: SetupState): Promise<void> {
    if (!isSql(this.db)) { this.db.setupStates.set(this.stateKey(raw), value); return; }
    await this.db`INSERT INTO github_setup_states (state_hash,purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at) VALUES (decode(${this.stateKey(raw)},'hex'),${value.purpose},${value.userId === "setup" ? null : value.userId},${value.organizationId === "setup" ? null : value.organizationId},${value.idempotencyKey},${value.encryptedState ?? null},${value.encryptedPkceVerifier ?? null},to_timestamp(${value.expiresAt / 1000})) ON CONFLICT (state_hash) DO UPDATE SET purpose=excluded.purpose,user_id=excluded.user_id,organization_id=excluded.organization_id,idempotency_key=excluded.idempotency_key,encrypted_state=excluded.encrypted_state,encrypted_pkce_verifier=excluded.encrypted_pkce_verifier,expires_at=excluded.expires_at,consumed_at=NULL`;
  }

  private async consume(raw: string, userId: string, purpose: SetupState["purpose"]): Promise<SetupState> {
    if (!isSql(this.db)) {
      const state = this.db.setupStates.get(this.stateKey(raw)) ?? this.db.setupStates.get(raw);
      if (!state || state.purpose !== purpose || (userId !== "setup" && state.userId !== userId) || state.consumedAt || state.expiresAt < Date.now()) throw new Error("setup_state_expired");
      state.consumedAt = Date.now();
      return state;
    }
    const rows = userId === "setup"
      ? await this.db<SetupRow[]>`UPDATE github_setup_states SET consumed_at=now() WHERE state_hash=decode(${this.stateKey(raw)},'hex') AND purpose=${purpose} AND consumed_at IS NULL AND expires_at>now() RETURNING purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at`
      : await this.db<SetupRow[]>`UPDATE github_setup_states SET consumed_at=now() WHERE state_hash=decode(${this.stateKey(raw)},'hex') AND purpose=${purpose} AND user_id=${userId} AND consumed_at IS NULL AND expires_at>now() RETURNING purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at`;
    const row = rows[0];
    if (!row) throw new Error("setup_state_expired");
    return { purpose: row.purpose, userId: row.user_id, organizationId: row.organization_id, idempotencyKey: row.idempotency_key, encryptedState: row.encrypted_state ?? undefined, encryptedPkceVerifier: row.encrypted_pkce_verifier ?? undefined, expiresAt: nowMs(row.expires_at), consumedAt: nowMs(row.consumed_at as Date | string) };
  }

  private async getConfig(): Promise<AppConfig | null> {
    if (!isSql(this.db)) return this.db.appConfig ?? null;
    const rows = await this.db<Array<{ app_id: number; slug: string; client_id: string | null; encrypted_pem: string; encrypted_client_secret: string; encrypted_webhook_secret: string }>>`SELECT app_id,slug,client_id,encrypted_pem,encrypted_client_secret,encrypted_webhook_secret FROM github_app_config WHERE singleton=true`;
    const row = rows[0];
    return row ? { id: Number(row.app_id), slug: row.slug, clientId: row.client_id ?? undefined, pem: row.encrypted_pem, clientSecret: row.encrypted_client_secret, webhookSecret: row.encrypted_webhook_secret } : null;
  }

  private async saveConfig(config: AppConfig): Promise<void> {
    if (!isSql(this.db)) { this.db.appConfig = config; return; }
    await this.db`INSERT INTO github_app_config (singleton,app_id,slug,client_id,encrypted_pem,encrypted_client_secret,encrypted_webhook_secret) VALUES (true,${config.id},${config.slug},${config.clientId ?? null},${config.pem},${config.clientSecret},${config.webhookSecret}) ON CONFLICT (singleton) DO UPDATE SET app_id=excluded.app_id,slug=excluded.slug,client_id=excluded.client_id,encrypted_pem=excluded.encrypted_pem,encrypted_client_secret=excluded.encrypted_client_secret,encrypted_webhook_secret=excluded.encrypted_webhook_secret,updated_at=now()`;
  }

  private async gh(path: string, init: RequestInit = {}, jwt?: string): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    headers.set("x-github-api-version", "2026-03-10");
    if (jwt) headers.set("authorization", `Bearer ${jwt}`);
    const response = await this.fetcher(`${API}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`github_${response.status}`);
    if (response.status === 204) return {};
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }
  async createManifestLaunch(userId: string, organizationId: string, idempotencyKey: string): Promise<{ action: string; manifest: string }> {
    if (!isSql(this.db)) {
      for (const state of this.db.setupStates.values()) if (state.purpose === "manifest" && (userId === "setup" || state.userId === userId) && (organizationId === "setup" || state.organizationId === organizationId) && state.idempotencyKey === idempotencyKey && !state.consumedAt && state.expiresAt > Date.now()) return { action: `https://github.com/settings/apps/new?state=${this.box.decrypt(state.encryptedState!)}`, manifest: this.box.decrypt(state.encryptedPkceVerifier!) };
    } else {
      const rows = userId === "setup"
        ? await this.db<SetupRow[]>`SELECT purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at FROM github_setup_states WHERE purpose='manifest' AND idempotency_key=${idempotencyKey} AND consumed_at IS NULL AND expires_at>now()`
        : await this.db<SetupRow[]>`SELECT purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at FROM github_setup_states WHERE purpose='manifest' AND user_id=${userId} AND organization_id=${organizationId} AND idempotency_key=${idempotencyKey} AND consumed_at IS NULL AND expires_at>now()`;
      const state = rows[0];
      if (state?.encrypted_state && state.encrypted_pkce_verifier) return { action: `https://github.com/settings/apps/new?state=${this.box.decrypt(state.encrypted_state)}`, manifest: this.box.decrypt(state.encrypted_pkce_verifier) };
    }
    const origin = this.publicOrigin();
    if (!origin) throw new Error("setup_required");
    const webhookOrigin = this.webhookOrigin();
    if (!webhookOrigin) throw new Error("GITHUB_WEBHOOK_URL is required");
    const rawState = randomBytes(32).toString("base64url");
    const manifest = JSON.stringify({ name: "mars", public: true, url: origin, redirect_url: `${origin}/api/github/app/manifest/callback`, setup_url: `${origin}/api/github/app/setup`, hook_attributes: { url: `${webhookOrigin}/api/github/webhooks`, active: true }, description: "Mars self-hosted GitHub Actions runners", callback_urls: [`${origin}/api/auth/github/callback`], default_permissions: { actions: "read", contents: "write", members: "read", organization_self_hosted_runners: "write", pull_requests: "write", administration: "write" }, default_events: ["workflow_job", "membership"] });
    await this.saveState(rawState, { purpose: "manifest", userId, organizationId, idempotencyKey, encryptedState: this.box.encrypt(rawState), encryptedPkceVerifier: this.box.encrypt(manifest), expiresAt: Date.now() + 3_600_000 });
    return { action: `https://github.com/settings/apps/new?state=${rawState}`, manifest };
  }

  async beginOrganizationInstallation(userId: string, organizationId: string, idempotencyKey: string): Promise<{ location: string; installCookie?: string }> {
    return this.beginInstallation(userId, organizationId, idempotencyKey, false, "organization_install");
  }
  async uninstallOrganization(organizationId: string): Promise<void> {
    let installationId: number | null = null;
    if (isSql(this.db)) {
      const rows = await this.db<Array<{ github_installation_id: number }>>`SELECT github_installation_id FROM dashboard_installations WHERE organization_id=${organizationId} AND state <> 'suspended' ORDER BY created_at DESC LIMIT 1`;
      installationId = rows[0] ? Number(rows[0].github_installation_id) : null;
    } else {
      const installation = [...this.db.installations.values()].find((value) => value.organizationId === organizationId && value.state !== "suspended");
      installationId = installation?.githubInstallationId ?? null;
    }
    if (!installationId) throw new Error("github_installation_not_found");
    await this.gh(`/app/installations/${installationId}`, { method: "DELETE" }, await this.appJwt());
    await this.reconcileInstallationRepositories({ installation: { id: installationId }, action: "uninstalled" });
  }

  async beginUnboundInstallation(userId: string, idempotencyKey: string): Promise<{ location: string; installCookie?: string }> {
    const config = await this.getConfig();
    if (!config) throw new Error("github_app_unconfigured");
    if (isSql(this.db)) {
      const rows = await this.db<SetupRow[]>`SELECT purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at FROM github_setup_states WHERE purpose='organization_install' AND user_id=${userId} AND organization_id IS NULL AND idempotency_key=${idempotencyKey} AND consumed_at IS NULL AND expires_at>now()`;
      const state = rows[0];
      if (state?.encrypted_state) return { location: `https://github.com/apps/${config.slug}/installations/new`, installCookie: this.box.decrypt(state.encrypted_state) };
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
      const installations = await this.db<Array<{ id: string }>>`
        SELECT i.id
        FROM dashboard_installations i
        WHERE i.organization_id=${organizationId}
          AND i.repository_selection IN ('all','selected')
          AND EXISTS (
            SELECT 1 FROM dashboard_repositories r
            WHERE r.installation_id=i.id AND r.available=true
          )
        ORDER BY i.created_at DESC
        LIMIT 1
      `;
      if (installations[0]) {
        if (!bindOnboarding) throw new Error("github_organization_already_connected");
        const linked = await this.db`UPDATE system_onboarding SET organization_id=${organizationId} WHERE singleton=true AND admin_user_id=${userId} RETURNING organization_id`;
        const origin = this.publicOrigin();
        if (linked[0] && origin) return { location: browserLocation(origin, "/onboarding") };
      }
      const rows = await this.db<SetupRow[]>`SELECT purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at FROM github_setup_states WHERE purpose=${purpose} AND user_id=${userId} AND organization_id=${organizationId} AND idempotency_key=${idempotencyKey} AND consumed_at IS NULL AND expires_at>now()`;
      const state = rows[0];
      if (state?.encrypted_state) return { location: `https://github.com/apps/${slug}/installations/new`, installCookie: this.box.decrypt(state.encrypted_state) };
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
    const rows = await this.db<Array<{ github_org_id: number; github_account_type?: "User" | "Organization" }>>`SELECT github_org_id, github_account_type FROM organizations WHERE id=${organizationId}`;
    return rows[0] ? { id: Number(rows[0].github_org_id), type: rows[0].github_account_type ?? "Organization" } : null;
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
    const rows = await this.db<Array<{ id: string; login: string }>>`SELECT id, login FROM organizations WHERE github_org_id=${githubAccountId} AND github_account_type=${accountType} LIMIT 1`;
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
    const rows = await this.db<Array<{ id: string }>>`INSERT INTO organizations (github_org_id,login,github_account_type) VALUES (${accountId},${login},${accountType}) ON CONFLICT (github_org_id) DO UPDATE SET login=excluded.login WHERE organizations.github_account_type=excluded.github_account_type RETURNING id`;
    const organizationId = rows[0]?.id;
    if (!organizationId) throw new Error("github_installation_persist_failed");
    await this.db`INSERT INTO memberships (organization_id,user_id,role) VALUES (${organizationId},${userId},'owner') ON CONFLICT (organization_id,user_id) DO UPDATE SET role='owner'`;
    return organizationId;
  }

  private async persistInstallation(organizationId: string, installationId: number, state: Installation["state"], repositorySelection: Installation["repositorySelection"], githubAccountId: number, repos: Repository[]): Promise<string> {
    if (!isSql(this.db)) {
      this.db.installations.set(installationId, { organizationId, githubInstallationId: installationId, state, repositorySelection, githubAccountId });
      for (const repo of repos) this.db.repositories.set(repo.id, { ...repo, organizationId });
      return String(installationId);
    }
    const rows = await this.db<Array<{ id: string }>>`INSERT INTO dashboard_installations (organization_id,github_installation_id,state,repository_selection,github_account_id) VALUES (${organizationId},${installationId},${state},${repositorySelection},${githubAccountId}) ON CONFLICT (organization_id,github_installation_id) DO UPDATE SET state=excluded.state,repository_selection=excluded.repository_selection,github_account_id=excluded.github_account_id RETURNING id`;
    const installationRow = rows[0];
    if (!installationRow) throw new Error("github_installation_persist_failed");
    for (const repo of repos) await this.db`INSERT INTO dashboard_repositories (organization_id,installation_id,github_repository_id,name,full_name,visibility,available) VALUES (${organizationId},${installationRow.id},${Number(repo.id)},${repo.fullName.split("/").at(-1) ?? repo.fullName},${repo.fullName},${repo.visibility},${repo.available}) ON CONFLICT (organization_id,github_repository_id) DO UPDATE SET installation_id=excluded.installation_id,visibility=excluded.visibility,available=excluded.available,full_name=excluded.full_name,name=excluded.name`;
    return installationRow.id;
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
    if (onboarding && isSql(this.db)) await this.db`UPDATE system_onboarding SET organization_id=${organizationId} WHERE singleton=true AND admin_user_id=${userId}`;
    if (hasAllowed) return onboarding;
    throw new Error("repository_selection_required");
  }

  async refreshInstallationRepositories(organizationId: string): Promise<void> {
    let installationId: number | null = null;
    if (isSql(this.db)) {
      const rows = await this.db<Array<{ github_installation_id: number }>>`
        SELECT github_installation_id
        FROM dashboard_installations
        WHERE organization_id=${organizationId} AND state <> 'suspended'
        ORDER BY created_at DESC
        LIMIT 1
      `;
      installationId = rows[0] ? Number(rows[0].github_installation_id) : null;
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
    const installations = await this.db<Array<{ id: string; organization_id: string; state: string; repository_selection: "all" | "selected" | null }>>`SELECT id,organization_id,state,repository_selection FROM dashboard_installations WHERE github_installation_id=${id}`;
    const installation = installations[0];
    if (!installation) return;
    const fullSnapshot = data.repositories !== undefined;
    if (fullSnapshot) {
      const snapshotIds = data.repositories!.map((repo) => repo.id);
      await this.db`UPDATE dashboard_repositories SET available=false WHERE installation_id=${installation.id} AND github_repository_id != ALL(${snapshotIds})`;
    }
    if (["suspend", "suspended", "deleted", "uninstalled"].includes(data.action ?? "")) {
      await this.db`UPDATE dashboard_installations SET state='suspended' WHERE id=${installation.id}`;
      if (["deleted", "uninstalled"].includes(data.action ?? "")) await this.db`UPDATE dashboard_repositories SET available=false WHERE installation_id=${installation.id}`;
    }
    if (data.repository_selection) await this.db`UPDATE dashboard_installations SET repository_selection=${data.repository_selection} WHERE id=${installation.id}`;
    for (const repo of data.repositories_removed ?? []) await this.db`UPDATE dashboard_repositories SET available=false WHERE installation_id=${installation.id} AND github_repository_id=${repo.id}`;
    for (const raw of data.repositories_added ?? data.repositories ?? []) {
      await this.db`INSERT INTO dashboard_repositories (organization_id,installation_id,github_repository_id,name,full_name,visibility,available) VALUES (${installation.organization_id},${installation.id},${raw.id},${raw.full_name.split("/").at(-1) ?? raw.full_name},${raw.full_name},${visibilityOf(raw)},true) ON CONFLICT (organization_id,github_repository_id) DO UPDATE SET installation_id=excluded.installation_id,available=true,visibility=excluded.visibility,full_name=excluded.full_name,name=excluded.name`;
    }
    await this.db`UPDATE dashboard_installations i SET state=CASE
      WHEN i.state='suspended' THEN i.state
      WHEN i.repository_selection IN ('all','selected') AND EXISTS (
        SELECT 1 FROM dashboard_repositories r
        WHERE r.installation_id=i.id AND r.available=true
      ) THEN 'approved'
      ELSE 'pending'
    END WHERE i.id=${installation.id}`;
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const response = await this.gh(`/app/installations/${installationId}/access_tokens`, { method: "POST" }, await this.appJwt());
    const token = typeof response.token === "string" ? response.token : "";
    if (!token) throw new Error("github_token_missing");
    return token;
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
    const rows = await this.db<Array<{ installation_id: number; full_name: string; labels: unknown; default_branch?: string; head_sha?: string }>>`
      SELECT i.github_installation_id AS installation_id, r.full_name,
        (SELECT p.labels FROM runner_pools p WHERE p.organization_id IS NULL AND p.enabled=true ORDER BY p.name LIMIT 1) AS labels
      FROM dashboard_repositories r JOIN dashboard_installations i ON i.id=r.installation_id
      WHERE r.organization_id=${organizationId} AND r.id=${repositoryId} AND r.available=true AND i.state='approved' LIMIT 1`;
    const row = rows[0];
    if (!row) throw new Error("github_repository_unavailable");
    const labels = Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === "string") : typeof row.labels === "string" ? (JSON.parse(row.labels) as unknown[]).filter((label): label is string => typeof label === "string") : [];
    if (!labels.length) throw new Error("github_runner_pool_missing");
    return { installationId: Number(row.installation_id), fullName: row.full_name, defaultBranch: row.default_branch ?? "", headSha: row.head_sha ?? "", labels };
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
      await this.db`UPDATE dashboard_repositories SET available=false WHERE organization_id=${organizationId} AND id=${repositoryId}`;
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
      const labels = input.labels ?? ctx.repo.labels;
      const focused = Boolean(input.selectedPath || input.selectedJobId);
      const mutation = previewWorkflowMutation({
        files,
        selectedPaths: input.selectedPaths ?? [],
        selectedPath: input.selectedPath,
        selectedJobId: input.selectedJobId,
        labels,
      });
      const ref = await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/ref/heads/${encodeURIComponent(listing.defaultBranch)}`, {}, ctx.token);
      const headSha = ref.object && typeof ref.object === "object" && typeof (ref.object as { sha?: unknown }).sha === "string" ? (ref.object as { sha: string }).sha : "";
      const firstProposedLabels = mutation.jobs[0]?.proposedRunsOn;
      const resultLabels = firstProposedLabels ? [...firstProposedLabels] : labels;
      return { ...mutation, defaultBranch: listing.defaultBranch, headSha, labels: resultLabels };
    });
  }

  async createRepositoryRunnerPr(input: { organizationId: string; repositoryId: string; selectedPaths?: string[]; selectedPath?: string; selectedJobId?: string; labels?: string[]; expectedHeadSha: string; title?: string; body?: string }): Promise<{ url: string; number: number; branch: string; changedFiles: string[]; replacementCount: number }> {
    const ctx = await this.workflowContext(input.organizationId, input.repositoryId);
    return this.repositoryOperation(input.organizationId, input.repositoryId, async () => {
      const listing = await this.listRepositoryWorkflowsWithToken(ctx.owner, ctx.name, ctx.token);
      const ref = await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/ref/heads/${encodeURIComponent(listing.defaultBranch)}`, {}, ctx.token);
      const headSha = ref.object && typeof ref.object === "object" && typeof (ref.object as { sha?: unknown }).sha === "string" ? (ref.object as { sha: string }).sha : "";
      if (headSha !== input.expectedHeadSha) throw new Error("github_workflow_head_stale");
      const files = discoverWorkflowFiles(listing.files);
      const labels = input.labels ?? ctx.repo.labels;
      const focused = Boolean(input.selectedPath || input.selectedJobId);
      const mutation = previewWorkflowMutation({
        files,
        selectedPaths: input.selectedPaths ?? [],
        selectedPath: input.selectedPath,
        selectedJobId: input.selectedJobId,
        labels,
      });
      if (mutation.noOp) throw new Error("Workflow mutation would be a no-op");
      const changed = listing.files.filter((file) => mutation.changedFiles.includes(file.path)).map((file) => ({
        ...file,
        content: applyWorkflowMutation(file.content, labels, input.selectedJobId, focused),
      }));
      const branch = `mars/use-runners-${randomBytes(6).toString("hex")}`;
      const blobs = await Promise.all(changed.map(async (file) => ({ path: file.path, mode: "100644", type: "blob", sha: (await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/blobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: file.content, encoding: "utf-8" }) }, ctx.token)).sha as string })));
      const tree = await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/trees`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_tree: headSha, tree: blobs }) }, ctx.token);
      const commit = await this.gh(`/repos/${ctx.owner}/${ctx.name}/git/commits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Configure Mars runners", tree: tree.sha, parents: [headSha] }) }, ctx.token);
      const resultLabels = mutation.jobs[0]?.proposedRunsOn ? [...mutation.jobs[0].proposedRunsOn] : labels;
      const generatedBody = focused
        ? `Configure GitHub Actions workflows to use Mars runners with labels: ${resultLabels.join(", ")}.`
        : "Configure GitHub Actions workflows to use Mars runners.";
      const pr = await this.gh(`/repos/${ctx.owner}/${ctx.name}/pulls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: input.title?.trim() || "Use Mars runners", body: input.body?.trim() || generatedBody, head: branch, base: listing.defaultBranch }) }, ctx.token);
      return { url: String(pr.html_url ?? ""), number: Number(pr.number ?? 0), branch, changedFiles: mutation.changedFiles, replacementCount: mutation.replacementCount };
    });
  }
}
