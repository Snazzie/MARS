import { createHash, createPrivateKey, createSign, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type { SecretBox } from "./auth.ts";

type SetupState = { purpose: "oauth" | "manifest" | "install"; userId: string | null; organizationId: string | null; idempotencyKey: string | null; encryptedState?: string; encryptedPkceVerifier?: string; expiresAt: number; consumedAt?: number };
type Installation = { organizationId: string; githubInstallationId: number; state: "pending" | "approved" | "suspended"; repositorySelection: "all" | "selected" | null; githubAccountId?: number };
type Repository = { id: string; installationId: number; fullName: string; visibility: "private" | "internal" | "public"; available: boolean; approved: boolean };
type AppConfig = { id: number; slug: string; clientId?: string; pem: string; clientSecret: string; webhookSecret: string };
type Organization = { githubOrgId: number };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SqlDatabase = Sql<{}>;
type MemoryDatabase = { setupStates: Map<string, SetupState>; installations: Map<number, Installation>; repositories: Map<string, Repository>; appConfig?: AppConfig; organizations?: Map<string, Organization> };
type Database = SqlDatabase | MemoryDatabase;

type SetupRow = { purpose: SetupState["purpose"]; user_id: string | null; organization_id: string | null; idempotency_key: string | null; encrypted_state: string | null; encrypted_pkce_verifier: string | null; expires_at: Date | string; consumed_at: Date | string | null };
const API = "https://api.github.com";
const isSql = (db: Database): db is SqlDatabase => typeof db === "function";
const nowMs = (value: Date | string | number) => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
const visibilityOf = (repo: { private?: unknown; visibility?: unknown }): Repository["visibility"] => repo.visibility === "private" || repo.visibility === "internal" || repo.visibility === "public" ? repo.visibility : repo.private === true ? "private" : "public";

export class GitHubAppService {
  private readonly db: Database;
  private readonly fetcher: Fetcher;
  private readonly box: SecretBox;
  private readonly baseUrl: string;
  private readonly webhookUrl: string;

  constructor(opts: { db: Database; fetch?: Fetcher; secretBox: SecretBox; baseUrl: string; webhookUrl?: string }) {
    this.db = opts.db;
    this.fetcher = opts.fetch ?? fetch;
    this.box = opts.secretBox;
    this.baseUrl = opts.baseUrl;
    this.webhookUrl = opts.webhookUrl ?? `${opts.baseUrl}/api/github/webhooks`;
  }

  private stateKey(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }

  private async findState(raw: string): Promise<SetupState | null> {
    if (!isSql(this.db)) return this.db.setupStates.get(this.stateKey(raw)) ?? null;
    const rows = await this.db<SetupRow[]>`SELECT purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at FROM github_setup_states WHERE state_hash=decode(${this.stateKey(raw)},'hex')`;
    const row = rows[0];
    return row ? { purpose: row.purpose, userId: row.user_id, organizationId: row.organization_id, idempotencyKey: row.idempotency_key, encryptedState: row.encrypted_state ?? undefined, encryptedPkceVerifier: row.encrypted_pkce_verifier ?? undefined, expiresAt: nowMs(row.expires_at), consumedAt: row.consumed_at ? nowMs(row.consumed_at) : undefined } : null;
  }

  private async saveState(raw: string, value: SetupState): Promise<void> {
    if (!isSql(this.db)) { this.db.setupStates.set(this.stateKey(raw), value); return; }
    await this.db`INSERT INTO github_setup_states (state_hash,purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at) VALUES (decode(${this.stateKey(raw)},'hex'),${value.purpose},${value.userId},${value.organizationId},${value.idempotencyKey},${value.encryptedState ?? null},${value.encryptedPkceVerifier ?? null},to_timestamp(${value.expiresAt / 1000})) ON CONFLICT (state_hash) DO UPDATE SET purpose=excluded.purpose,user_id=excluded.user_id,organization_id=excluded.organization_id,idempotency_key=excluded.idempotency_key,encrypted_state=excluded.encrypted_state,encrypted_pkce_verifier=excluded.encrypted_pkce_verifier,expires_at=excluded.expires_at,consumed_at=NULL`;
  }

  private async consume(raw: string, userId: string, purpose: SetupState["purpose"]): Promise<SetupState> {
    if (!isSql(this.db)) {
      const state = this.db.setupStates.get(this.stateKey(raw));
      if (!state || state.purpose !== purpose || state.userId !== userId || state.consumedAt || state.expiresAt < Date.now()) throw new Error("setup_state_expired");
      state.consumedAt = Date.now();
      return state;
    }
    const rows = await this.db<SetupRow[]>`UPDATE github_setup_states SET consumed_at=now() WHERE state_hash=decode(${this.stateKey(raw)},'hex') AND purpose=${purpose} AND user_id=${userId} AND consumed_at IS NULL AND expires_at>now() RETURNING purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at`;
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
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  async createManifestLaunch(userId: string, organizationId: string, idempotencyKey: string): Promise<{ action: string; manifest: string }> {
    if (!isSql(this.db)) {
      for (const state of this.db.setupStates.values()) if (state.purpose === "manifest" && state.userId === userId && state.organizationId === organizationId && state.idempotencyKey === idempotencyKey && !state.consumedAt && state.expiresAt > Date.now()) return { action: `https://github.com/settings/apps/new?state=${this.box.decrypt(state.encryptedState!)}`, manifest: this.box.decrypt(state.encryptedPkceVerifier!) };
    } else {
      const rows = await this.db<SetupRow[]>`SELECT purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at FROM github_setup_states WHERE purpose='manifest' AND user_id=${userId} AND organization_id=${organizationId} AND idempotency_key=${idempotencyKey} AND consumed_at IS NULL AND expires_at>now()`;
      const state = rows[0];
      if (state?.encrypted_state && state.encrypted_pkce_verifier) return { action: `https://github.com/settings/apps/new?state=${this.box.decrypt(state.encrypted_state)}`, manifest: this.box.decrypt(state.encrypted_pkce_verifier) };
    }
    const rawState = randomBytes(32).toString("base64url");
    const manifest = JSON.stringify({ name: "whitesmith", public: true, url: this.baseUrl, hook_attributes: { url: this.webhookUrl, active: true }, redirect_url: `${this.baseUrl}/api/github/app/manifest/callback`, setup_url: `${this.baseUrl}/api/github/app/setup`, description: "Whitesmith self-hosted GitHub Actions runners", callback_urls: [`${this.baseUrl}/api/github/app/callback`], default_permissions: { actions: "read", members: "read", organization_self_hosted_runners: "write", administration: "write" }, default_events: ["workflow_job", "membership"] });
    await this.saveState(rawState, { purpose: "manifest", userId, organizationId, idempotencyKey, encryptedState: this.box.encrypt(rawState), encryptedPkceVerifier: this.box.encrypt(manifest), expiresAt: Date.now() + 3_600_000 });
    return { action: `https://github.com/settings/apps/new?state=${rawState}`, manifest };
  }

  async beginInstallation(userId: string, organizationId: string, idempotencyKey: string): Promise<{ location: string; installCookie?: string }> {
    const config = await this.getConfig();
    const slug = config?.slug ?? "whitesmith";
    if (isSql(this.db)) {
      const installations = await this.db<Array<{ id: string }>>`
        SELECT i.id
        FROM dashboard_installations i
        WHERE i.organization_id=${organizationId}
          AND i.state='approved'
          AND i.repository_selection='selected'
          AND EXISTS (
            SELECT 1 FROM dashboard_repositories r
            WHERE r.installation_id=i.id AND r.available=true
              AND r.visibility IN ('private','internal')
          )
        ORDER BY i.created_at DESC
        LIMIT 1
      `;
      if (installations[0]) {
        const linked = await this.db`UPDATE system_onboarding SET organization_id=${organizationId} WHERE singleton=true AND admin_user_id=${userId} RETURNING organization_id`;
        if (linked[0]) return { location: `${this.baseUrl}/onboarding` };
      }
      const rows = await this.db<SetupRow[]>`SELECT purpose,user_id,organization_id,idempotency_key,encrypted_state,encrypted_pkce_verifier,expires_at,consumed_at FROM github_setup_states WHERE purpose='install' AND user_id=${userId} AND organization_id=${organizationId} AND idempotency_key=${idempotencyKey} AND consumed_at IS NULL AND expires_at>now()`;
      const state = rows[0];
      if (state?.encrypted_state) return { location: `https://github.com/apps/${slug}/installations/new`, installCookie: this.box.decrypt(state.encrypted_state) };
    } else {
      for (const state of this.db.setupStates.values()) if (state.purpose === "install" && state.userId === userId && state.organizationId === organizationId && state.idempotencyKey === idempotencyKey && !state.consumedAt && state.expiresAt > Date.now()) return { location: `https://github.com/apps/${slug}/installations/new`, installCookie: this.box.decrypt(state.encryptedState!) };
    }
    const cookie = randomBytes(32).toString("base64url");
    await this.saveState(cookie, { purpose: "install", userId, organizationId, idempotencyKey, encryptedState: this.box.encrypt(cookie), expiresAt: Date.now() + 600_000 });
    return { location: `https://github.com/apps/${slug}/installations/new`, installCookie: cookie };
  }

  async completeManifestRegistration(userId: string, state: string, code: string): Promise<{ location: string; installCookie?: string }> {
    const setup = await this.consume(state, userId, "manifest");
    const result = await this.gh(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
    const id = typeof result.id === "number" ? result.id : 0;
    const slug = typeof result.slug === "string" ? result.slug : "whitesmith";
    const pem = typeof result.pem === "string" ? result.pem : "";
    const clientId = typeof result.client_id === "string" ? result.client_id : undefined;
    const clientSecret = typeof result.client_secret === "string" ? result.client_secret : "";
    const webhookSecret = typeof result.webhook_secret === "string" ? result.webhook_secret : "";
    if (!id || !pem || !clientSecret || !webhookSecret) throw new Error("github_manifest_invalid");
    await this.saveConfig({ id, slug, clientId, pem: this.box.encrypt(pem), clientSecret: this.box.encrypt(clientSecret), webhookSecret: this.box.encrypt(webhookSecret) });
    const install = await this.beginInstallation(userId, setup.organizationId!, `${setup.idempotencyKey ?? "manifest"}:install`);
    return install;
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

  private async organizationGithubId(organizationId: string): Promise<number | null> {
    if (!isSql(this.db)) return this.db.organizations?.get(organizationId)?.githubOrgId ?? null;
    const rows = await this.db<Array<{ github_org_id: number }>>`SELECT github_org_id FROM organizations WHERE id=${organizationId}`;
    return rows[0] ? Number(rows[0].github_org_id) : null;
  }

  private async persistInstallation(organizationId: string, installationId: number, state: Installation["state"], repositorySelection: Installation["repositorySelection"], githubAccountId: number, repos: Repository[]): Promise<string> {
    if (!isSql(this.db)) {
      this.db.installations.set(installationId, { organizationId, githubInstallationId: installationId, state, repositorySelection, githubAccountId });
      for (const repo of repos) this.db.repositories.set(repo.id, repo);
      return String(installationId);
    }
    const rows = await this.db<Array<{ id: string }>>`INSERT INTO dashboard_installations (organization_id,github_installation_id,state,repository_selection,github_account_id) VALUES (${organizationId},${installationId},${state},${repositorySelection},${githubAccountId}) ON CONFLICT (organization_id,github_installation_id) DO UPDATE SET state=excluded.state,repository_selection=excluded.repository_selection,github_account_id=excluded.github_account_id RETURNING id`;
    const installationRow = rows[0];
    if (!installationRow) throw new Error("github_installation_persist_failed");
    for (const repo of repos) await this.db`INSERT INTO dashboard_repositories (organization_id,installation_id,github_repository_id,name,full_name,visibility,available,approved) VALUES (${organizationId},${installationRow.id},${Number(repo.id)},${repo.fullName.split("/").at(-1) ?? repo.fullName},${repo.fullName},${repo.visibility},${repo.available},${repo.approved}) ON CONFLICT (organization_id,github_repository_id) DO UPDATE SET installation_id=excluded.installation_id,visibility=excluded.visibility,available=excluded.available,approved=excluded.approved,full_name=excluded.full_name,name=excluded.name`;
    return installationRow.id;
  }

  async completeInstallation(userId: string, installCookie: string, installationId: number): Promise<void> {
    const setup = await this.consume(installCookie, userId, "install");
    const accountInfo = await this.gh(`/app/installations/${installationId}`, {}, await this.appJwt());
    const account = accountInfo.account && typeof accountInfo.account === "object" ? accountInfo.account as { type?: unknown; id?: unknown } : {};
    const accountId = typeof account.id === "number" ? account.id : Number(account.id);
    const expectedOrgId = await this.organizationGithubId(setup.organizationId ?? "");
    if (account.type !== "Organization" || !Number.isSafeInteger(accountId) || expectedOrgId === null || accountId !== expectedOrgId) throw new Error("wrong_organization");
    const token = await this.gh(`/app/installations/${installationId}/access_tokens`, { method: "POST" }, await this.appJwt());
    const accessToken = typeof token.token === "string" ? token.token : "";
    if (!accessToken) throw new Error("github_token_missing");
    const reposResponse = await this.gh("/installation/repositories", {}, accessToken);
    const repositoryRows = Array.isArray(reposResponse.repositories) ? reposResponse.repositories : [];
    const repositorySelection = accountInfo.repository_selection === "all" || reposResponse.repository_selection === "all" ? "all" : "selected";
    const repos = repositoryRows.flatMap((raw) => { if (!raw || typeof raw !== "object") return []; const value = raw as { id?: unknown; full_name?: unknown; private?: unknown; visibility?: unknown }; if (typeof value.id !== "number" || typeof value.full_name !== "string") return []; return [{ id: String(value.id), installationId, fullName: value.full_name, visibility: visibilityOf(value), available: true, approved: false } satisfies Repository]; });
    const hasAllowed = repos.some((repo) => repo.visibility === "private" || repo.visibility === "internal");
    const approved = repositorySelection === "selected" && hasAllowed;
    await this.persistInstallation(setup.organizationId!, installationId, approved ? "approved" : "pending", repositorySelection, accountId, repos);
    if (isSql(this.db)) await this.db`UPDATE system_onboarding SET organization_id=${setup.organizationId} WHERE singleton=true AND admin_user_id=${userId}`;
    if (!approved) throw new Error("repository_selection_required");
  }

  async reconcileInstallationRepositories(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const data = payload as { installation?: { id?: number }; repository_selection?: "all" | "selected"; action?: string; repositories_removed?: Array<{ id: number }>; repositories_added?: Array<{ id: number; full_name: string; private?: boolean; visibility?: string }>; repositories?: Array<{ id: number; full_name: string; private?: boolean; visibility?: string }> };
    const id = Number(data.installation?.id);
    if (!isSql(this.db)) {
      const installation = this.db.installations.get(id);
      if (["suspend", "suspended", "deleted", "uninstalled"].includes(data.action ?? "") && installation) installation.state = "suspended";
      if (installation?.repositorySelection === "all" && data.repository_selection === "selected") {
        for (const repo of this.db.repositories.values()) if (repo.installationId === id) { repo.available = false; repo.approved = false; }
      }
      if (data.repository_selection && installation) installation.repositorySelection = data.repository_selection;
      for (const repo of data.repositories_removed ?? []) { const existing = this.db.repositories.get(String(repo.id)); if (existing) existing.available = false; }
      for (const raw of data.repositories_added ?? data.repositories ?? []) { const existing = this.db.repositories.get(String(raw.id)); const value = { id: String(raw.id), installationId: id, fullName: raw.full_name, visibility: visibilityOf(raw), available: true, approved: false }; this.db.repositories.set(String(raw.id), existing ? { ...existing, ...value } : value); }
      if (installation && installation.state !== "suspended") {
        const hasAllowed = [...this.db.repositories.values()].some((repo) => repo.installationId === id && repo.available && (repo.visibility === "private" || repo.visibility === "internal"));
        installation.state = installation.repositorySelection === "selected" && hasAllowed ? "approved" : "pending";
      }
      return;
    }
    const installations = await this.db<Array<{ id: string; organization_id: string; state: string; repository_selection: "all" | "selected" | null }>>`SELECT id,organization_id,state,repository_selection FROM dashboard_installations WHERE github_installation_id=${id}`;
    const installation = installations[0];
    if (!installation) return;
    if (["suspend", "suspended", "deleted", "uninstalled"].includes(data.action ?? "")) await this.db`UPDATE dashboard_installations SET state='suspended' WHERE id=${installation.id}`;
    if (installation.repository_selection === "all" && data.repository_selection === "selected") await this.db`UPDATE dashboard_repositories SET available=false,approved=false WHERE installation_id=${installation.id}`;
    if (data.repository_selection) await this.db`UPDATE dashboard_installations SET repository_selection=${data.repository_selection} WHERE id=${installation.id}`;
    for (const repo of data.repositories_removed ?? []) await this.db`UPDATE dashboard_repositories SET available=false,approved=false WHERE installation_id=${installation.id} AND github_repository_id=${repo.id}`;
    for (const raw of data.repositories_added ?? data.repositories ?? []) await this.db`INSERT INTO dashboard_repositories (organization_id,installation_id,github_repository_id,name,full_name,visibility,available,approved) VALUES (${installation.organization_id},${installation.id},${raw.id},${raw.full_name.split("/").at(-1) ?? raw.full_name},${raw.full_name},${visibilityOf(raw)},true,false) ON CONFLICT (organization_id,github_repository_id) DO UPDATE SET available=true,approved=false,visibility=excluded.visibility,full_name=excluded.full_name,name=excluded.name`;
    await this.db`UPDATE dashboard_installations i SET state=CASE
      WHEN i.state='suspended' THEN i.state
      WHEN i.repository_selection='selected' AND EXISTS (
        SELECT 1 FROM dashboard_repositories r
        WHERE r.installation_id=i.id AND r.available=true AND r.visibility IN ('private','internal')
      ) THEN 'approved'
      ELSE 'pending'
    END WHERE i.id=${installation.id}`;
  }

  async getWebhookSecret(): Promise<string | null> {
    const config = await this.getConfig();
    return config?.webhookSecret ? this.box.decrypt(config.webhookSecret) : null;
  }
}
