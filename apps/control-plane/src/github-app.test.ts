import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SecretBox } from "./auth.ts";
import { GitHubAppService } from "./github-app.ts";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const organizationId = "11111111-1111-4111-8111-111111111111";
const testPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const fakeDb: { setupStates: Map<string, unknown>; installations: Map<number, unknown>; repositories: Map<string, unknown>; appConfig?: { id: number; slug: string; pem: string; clientSecret: string; webhookSecret: string } } = {
  setupStates: new Map(),
  installations: new Map(),
  repositories: new Map(),
};

function resetDb() {
  fakeDb.setupStates.clear();
  fakeDb.installations.clear();
  fakeDb.repositories.clear();
  delete fakeDb.appConfig;
}

function service(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  resetDb();
  return new GitHubAppService({
    db: fakeDb,
    fetch: fetchImpl,
    secretBox: new SecretBox(masterKey),
    baseUrl: "https://control-plane.test",
  } as never);
}

describe("GitHub App onboarding", () => {
  test("manifest and install setup states are one-use and idempotent", async () => {
    const calls: Request[] = [];
    const github = service(async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ slug: "whitesmith", id: 9 });
    });
    const launch = await github.createManifestLaunch("admin-1", organizationId, "manifest-key");
    expect(launch.action).toContain("state=");
    expect(launch.manifest).toContain('"public":true');
    expect(launch.manifest).not.toContain("installation_repositories");
    const manifest = JSON.parse(launch.manifest);
    expect(manifest.default_events).toEqual(["workflow_job", "membership"]);
    expect(manifest.hook_attributes.url).toBe("https://control-plane.test/api/github/webhooks");
    const replay = await github.createManifestLaunch("admin-1", organizationId, "manifest-key");
    expect(replay).toEqual(launch);
    await expect(github.completeManifestRegistration("wrong-user", "missing", "code")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("uses a public webhook tunnel without changing browser callback URLs", async () => {
    const github = new GitHubAppService({
      db: fakeDb,
      fetch: async () => Response.json({}),
      secretBox: new SecretBox(masterKey),
      baseUrl: "http://localhost:3000",
      webhookUrl: "https://whitesmith-dev.example/api/github/webhooks",
    } as never);
    const launch = await github.createManifestLaunch("admin-1", organizationId, "tunnel-key");
    const manifest = JSON.parse(launch.manifest);
    expect(manifest.hook_attributes.url).toBe("https://whitesmith-dev.example/api/github/webhooks");
    expect(manifest.redirect_url).toBe("http://localhost:3000/api/github/app/manifest/callback");
    expect(manifest.setup_url).toBe("http://localhost:3000/api/github/app/setup");
  });

  test("converts a manifest and persists only encrypted returned secrets", async () => {
    const requests: Request[] = [];
    const github = service(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/conversions")) return Response.json({ id: 42, slug: "whitesmith", pem: "PRIVATE PEM", client_secret: "client-secret", webhook_secret: "webhook-secret" });
      return Response.json({});
    });
    const launch = await github.createManifestLaunch("admin-1", organizationId, "manifest-key-2");
    const state = new URL(launch.action).searchParams.get("state")!;
    const result = await github.completeManifestRegistration("admin-1", state, "conversion-code");
    expect(result.location).toContain("github.com/apps/");
    expect(requests[0].headers.get("accept")).toBe("application/vnd.github+json");
    expect(requests[0].headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(requests[0].url).toContain("/app-manifests/conversion-code/conversions");
    expect(fakeDb.appConfig).toBeDefined();
    expect(fakeDb.appConfig?.pem).not.toContain("PRIVATE PEM");
    expect(fakeDb.appConfig?.webhookSecret).not.toContain("webhook-secret");
  });

  test("rejects expired, replayed, wrong-user, wrong-organization, all, and public-only installation callbacks", async () => {
    const github = service(async () => Response.json({ account: { type: "User", login: "someone" } }));
    await expect(github.completeInstallation("missing-cookie", "not-a-cookie", 1)).rejects.toThrow();
    await expect(github.completeInstallation("admin-1", "expired-cookie", 1)).rejects.toThrow();
    await expect(github.completeInstallation("admin-1", "wrong-org-cookie", 1)).rejects.toThrow();
    await expect(github.completeInstallation("admin-1", "all-public-cookie", 1)).rejects.toThrow();
    await expect(github.completeInstallation("admin-1", "public-only-cookie", 1)).rejects.toThrow();
  });

  test("persists the installation organization before reporting repository selection remediation", async () => {
    const calls: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      calls.push(query);
      if (query.includes("UPDATE github_setup_states")) return [{ purpose: "install", user_id: "admin-1", organization_id: organizationId, idempotency_key: "key", encrypted_state: null, encrypted_pkce_verifier: null, expires_at: new Date(Date.now() + 60_000), consumed_at: new Date() }];
      if (query.includes("SELECT app_id,slug")) return [{ app_id: 9, slug: "whitesmith", client_id: null, encrypted_pem: new SecretBox(masterKey).encrypt(testPem), encrypted_client_secret: "x", encrypted_webhook_secret: "y" }];
      if (query.includes("SELECT github_org_id")) return [{ github_org_id: 99 }];
      if (query.includes("INSERT INTO dashboard_installations")) return [{ id: "22222222-2222-4222-8222-222222222222" }];
      if (query.includes("UPDATE system_onboarding SET organization_id")) return [];
      return [];
    }) as never;
    const github = new GitHubAppService({ db: sql, fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/app/installations/42")) return Response.json({ account: { type: "Organization", id: 99 }, repository_selection: "all" });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/installation/repositories")) return Response.json({ repository_selection: "all", repositories: [] });
      return Response.json({});
    }, secretBox: new SecretBox(masterKey), baseUrl: "https://control-plane.test" } as never);
    await expect(github.completeInstallation("admin-1", "cookie", 42)).rejects.toThrow("repository_selection_required");
    expect(calls.some((query) => query.includes("UPDATE system_onboarding SET organization_id"))).toBe(true);
  });

  test("resumes onboarding when a signed webhook already recorded an approved installation", async () => {
    const calls: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      calls.push(query);
      if (query.includes("SELECT app_id,slug")) return [{ app_id: 9, slug: "whitesmith", client_id: null, encrypted_pem: new SecretBox(masterKey).encrypt(testPem), encrypted_client_secret: "x", encrypted_webhook_secret: "y" }];
      if (query.includes("FROM dashboard_installations i")) return [{ id: "22222222-2222-4222-8222-222222222222" }];
      if (query.includes("UPDATE system_onboarding SET organization_id")) return [{ organization_id: organizationId }];
      return [];
    }) as never;
    const github = new GitHubAppService({
      db: sql,
      fetch: async () => { throw new Error("GitHub should not be called"); },
      secretBox: new SecretBox(masterKey),
      baseUrl: "https://control-plane.test",
    } as never);

    const launch = await github.beginInstallation("admin-1", organizationId, "resume-key");

    expect(launch).toEqual({ location: "https://control-plane.test/onboarding" });
    expect(calls.some((query) => query.includes("UPDATE system_onboarding SET organization_id"))).toBe(true);
    expect(calls.some((query) => query.includes("INSERT INTO github_setup_states"))).toBe(false);
  });

  test("reconciles selected private/internal repositories, installation readiness, and removal history", async () => {
    const github = service(async () => Response.json({}));
    fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "pending", repositorySelection: "all", githubAccountId: 99 });
    fakeDb.repositories.set("4", { id: "4", installationId: 42, fullName: "acme/stale", visibility: "private", available: true, approved: false });
    await github.reconcileInstallationRepositories({
      installation: { id: 42 },
      repository_selection: "selected",
      repositories_added: [
        { id: 1, full_name: "acme/private", private: true, visibility: "private" },
        { id: 2, full_name: "acme/internal", private: true, visibility: "internal" },
        { id: 3, full_name: "acme/public", private: false, visibility: "public" },
      ],
    });
    expect(fakeDb.installations.get(42)).toMatchObject({ state: "approved", repositorySelection: "selected" });
    expect(fakeDb.repositories.get("4")).toMatchObject({ available: false });
    await github.reconcileInstallationRepositories({ installation: { id: 42 }, repositories_removed: [{ id: 1 }, { id: 2 }] });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: false });
    expect(fakeDb.repositories.has("1")).toBe(true);
    expect(fakeDb.installations.get(42)).toMatchObject({ state: "pending" });
  });

  test("validates each webhook against the current decrypted secret and dispatches installation removal", async () => {
    const github = service(async () => Response.json({}));
    fakeDb.repositories.set("1", { id: "1", installationId: 42, fullName: "acme/private", visibility: "private", available: true, approved: true });
    expect(await github.getWebhookSecret()).toBeNull();
    await github.reconcileInstallationRepositories({ installation: { id: 42 }, action: "removed", repositories_removed: [{ id: 1 }] });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: false });
  });
});
