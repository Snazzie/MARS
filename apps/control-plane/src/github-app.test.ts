import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SecretBox } from "./auth.ts";
import { GitHubAppService } from "./github-app.ts";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const organizationId = "11111111-1111-4111-8111-111111111111";
const testPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const fakeDb: { setupStates: Map<string, unknown>; installations: Map<number, unknown>; repositories: Map<string, unknown>; organizations?: Map<string, { githubOrgId: number }>; appConfig?: { id: number; slug: string; pem: string; clientSecret: string; webhookSecret: string } } = {
  setupStates: new Map(),
  installations: new Map(),
  repositories: new Map(),
  organizations: new Map(),
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
    publicOrigin: () => "https://control-plane.test",
  } as never);
}

describe("GitHub App onboarding", () => {
  test("manifest and install setup states are one-use and idempotent", async () => {
    const calls: Request[] = [];
    const github = service(async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ slug: "mars", id: 9 });
    });
    const launch = await github.createManifestLaunch("admin-1", organizationId, "manifest-key");
    expect(launch.action).toContain("state=");
    expect(launch.manifest).toContain('"public":true');
    expect(launch.manifest).not.toContain("installation_repositories");
    const manifest = JSON.parse(launch.manifest);
    expect(manifest.default_events).toEqual(["workflow_job", "membership"]);
    expect(manifest.default_permissions.contents).toBe("write");
    expect(manifest.default_permissions.pull_requests).toBe("write");
    expect(manifest.hook_attributes.url).toBe("https://control-plane.test/api/github/webhooks");
    const replay = await github.createManifestLaunch("admin-1", organizationId, "manifest-key");
    expect(replay).toEqual(launch);
    await expect(github.completeManifestRegistration("wrong-user", "missing", "code")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  test("refuses installation until this control plane has registered its GitHub App", async () => {
    const github = service(async () => Response.json({}));
    await expect(github.beginInstallation("admin-1", organizationId, "install-key")).rejects.toThrow("github_app_unconfigured");
  });


  test("uses a public webhook tunnel without changing browser callback URLs", async () => {
    const github = new GitHubAppService({
      db: fakeDb,
      fetch: async () => Response.json({}),
      secretBox: new SecretBox(masterKey),
      publicOrigin: () => "https://control-plane.test",
    } as never);
    const launch = await github.createManifestLaunch("admin-1", organizationId, "tunnel-key");
    const manifest = JSON.parse(launch.manifest);
    expect(manifest.hook_attributes.url).toBe("https://control-plane.test/api/github/webhooks");
    expect(manifest.redirect_url).toBe("https://control-plane.test/api/github/app/manifest/callback");
    expect(manifest.setup_url).toBe("https://control-plane.test/api/github/app/setup");
  });

  test("converts a manifest and persists only encrypted returned secrets", async () => {
    const requests: Request[] = [];
    const github = service(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/conversions")) return Response.json({ id: 42, slug: "mars", pem: "PRIVATE PEM", client_id: "client-id", client_secret: "client-secret", webhook_secret: "webhook-secret" });
      return Response.json({});
    });
    const launch = await github.createManifestLaunch("admin-1", organizationId, "manifest-key-2");
    const state = new URL(launch.action).searchParams.get("state")!;
    const result = await github.completeManifestRegistration("admin-1", state, "conversion-code");
    expect(result.location).toBe("https://control-plane.test/api/auth/github");
    expect(requests[0].headers.get("accept")).toBe("application/vnd.github+json");
    expect(requests[0].headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(requests[0].url).toContain("/app-manifests/conversion-code/conversions");
    expect(fakeDb.appConfig).toBeDefined();
    expect(fakeDb.appConfig?.pem).not.toContain("PRIVATE PEM");
    expect(fakeDb.appConfig?.webhookSecret).not.toContain("webhook-secret");
  });

  test("accepts all-repository installations with available repositories", async () => {
    const github = service(async (input) => {
      const url = String(input);
      if (url.endsWith("/app/installations/42")) return Response.json({ account: { type: "Organization", id: 99 }, repository_selection: "all" });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/installation/repositories")) return Response.json({ repository_selection: "all", repositories: [{ id: 7, full_name: "acme/private", visibility: "private" }, { id: 8, full_name: "acme/public", visibility: "public" }] });
      return Response.json({});
    });
    fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "y" };
    fakeDb.organizations = new Map([[organizationId, { githubOrgId: 99 }]]);
    const launch = await github.beginInstallation("admin-1", organizationId, "key");
    await expect(github.completeInstallation("admin-1", launch.installCookie!, 42)).resolves.toBe(true);
    expect(fakeDb.installations.get(42)).toMatchObject({ state: "approved", repositorySelection: "all" });
    expect(fakeDb.repositories.get("8")).toMatchObject({ available: true, visibility: "public" });
    expect(fakeDb.repositories.get("8")).not.toHaveProperty("approved");
  });

  test("accepts public-only all-repository installations", async () => {
    const github = service(async (input) => {
      const url = String(input);
      if (url.endsWith("/app/installations/42")) return Response.json({ account: { type: "Organization", id: 99 }, repository_selection: "all" });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/installation/repositories")) return Response.json({ repository_selection: "all", repositories: [{ id: 8, full_name: "acme/public", visibility: "public" }] });
      return Response.json({});
    });
    fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "y" };
    fakeDb.organizations = new Map([[organizationId, { githubOrgId: 99 }]]);
    fakeDb.setupStates.set("cookie", { purpose: "install", userId: "admin-1", organizationId, idempotencyKey: "key", encryptedState: new SecretBox(masterKey).encrypt("cookie"), expiresAt: Date.now() + 60_000 });
    await expect(github.completeInstallation("admin-1", "cookie", 42)).resolves.toBe(true);
    expect(fakeDb.installations.get(42)).toMatchObject({ state: "approved", repositorySelection: "all" });
  });

  test("fetches every repository page during installation refresh", async () => {
    const pages: number[] = [];
    const github = service(async (input) => {
      const url = String(input);
      if (url.endsWith("/app/installations/42")) return Response.json({ account: { type: "Organization", id: 99 }, repository_selection: "all" });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/installation/repositories")) {
        const page = Number(new URL(url).searchParams.get("page"));
        pages.push(page);
        const repositories = page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, full_name: `acme/repo-${index + 1}`, visibility: "private" }))
          : [{ id: 101, full_name: "acme/mars", visibility: "public" }];
        return Response.json({ repository_selection: "all", repositories });
      }
      return Response.json({});
    });
    fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "y" };
    fakeDb.organizations = new Map([[organizationId, { githubOrgId: 99 }]]);
    fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "approved", repositorySelection: "all", githubAccountId: 99 });

    await github.refreshInstallationRepositories(organizationId);

    expect(pages).toEqual([1, 2]);
    expect(fakeDb.repositories.get("101")).toMatchObject({ fullName: "acme/mars", available: true });
  });


  test("wrong-organization callback leaves install state unconsumed", async () => {
    const github = service(async (input) => {
      const url = String(input);
      if (url.endsWith("/app/installations/42")) return Response.json({ account: { type: "Organization", id: 100 }, repository_selection: "selected" });
      return Response.json({});
    });
    fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "y" };
    fakeDb.organizations = new Map([[organizationId, { githubOrgId: 99 }]]);
    const launch = await github.beginInstallation("admin-1", organizationId, "wrong-org-key");
    await expect(github.completeInstallation("admin-1", launch.installCookie!, 42)).rejects.toThrow("wrong_organization");
    const states = [...fakeDb.setupStates.values()] as Array<{ consumedAt?: number }>;
    expect(states).toHaveLength(1);
    expect(states[0]?.consumedAt).toBeUndefined();
    expect(fakeDb.installations.size).toBe(0);
  });
  test("preserves durable rows across full repository snapshots", async () => {
    const github = service(async () => Response.json({}));
    fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "approved", repositorySelection: "selected", githubAccountId: 99 });
    fakeDb.repositories.set("1", { id: "1", installationId: 42, fullName: "acme/private", visibility: "private", available: true });
    fakeDb.repositories.set("2", { id: "2", installationId: 42, fullName: "acme/removed", visibility: "private", available: true });
    await github.reconcileInstallationRepositories({ installation: { id: 42 }, repository_selection: "selected", repositories: [{ id: 1, full_name: "acme/private", visibility: "private" }, { id: 3, full_name: "acme/new", visibility: "internal" }] });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: true });
    expect(fakeDb.repositories.get("2")).toMatchObject({ available: false });
    expect(fakeDb.repositories.get("3")).toMatchObject({ available: true });
    expect(fakeDb.repositories.get("3")).not.toHaveProperty("approved");
  });
  test("binds an installed GitHub account before repository remediation", async () => {
    const calls: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      calls.push(query);
      if (query.includes("SELECT purpose,user_id")) return [{ purpose: "install", user_id: "admin-1", organization_id: organizationId, idempotency_key: "key", encrypted_state: null, encrypted_pkce_verifier: null, expires_at: new Date(Date.now() + 60_000), consumed_at: null }];
      if (query.includes("SELECT app_id,slug")) return [{ app_id: 9, slug: "mars", client_id: null, encrypted_pem: new SecretBox(masterKey).encrypt(testPem), encrypted_client_secret: "x", encrypted_webhook_secret: "y" }];
      if (query.includes("UPDATE github_setup_states")) return [{ purpose: "install", user_id: "admin-1", organization_id: organizationId, idempotency_key: "key", encrypted_state: null, encrypted_pkce_verifier: null, expires_at: new Date(Date.now() + 60_000), consumed_at: new Date() }];
      if (query.includes("SELECT github_org_id")) return [{ github_org_id: 99 }];
      if (query.includes("INSERT INTO dashboard_installations")) return [{ id: "22222222-2222-4222-8222-222222222222" }];
      if (query.includes("UPDATE system_onboarding SET organization_id")) return [];
      return [];
    }) as never;
    const github = new GitHubAppService({ db: sql, fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/app/installations/42")) return Response.json({ account: { type: "Organization", id: 99 }, repository_selection: "all" });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/installation/repositories")) return Response.json({ repository_selection: "all", repositories: [] });
      return Response.json({});
    }, secretBox: new SecretBox(masterKey), publicOrigin: () => "https://control-plane.test" } as never);
    await expect(github.completeInstallation("admin-1", "cookie", 42)).rejects.toThrow("repository_selection_required");
    expect(calls.some((query) => query.includes("UPDATE system_onboarding SET organization_id"))).toBe(true);
  });

  test("resumes onboarding when a signed webhook already recorded an approved installation", async () => {
    const calls: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      calls.push(query);
      if (query.includes("SELECT app_id,slug")) return [{ app_id: 9, slug: "mars", client_id: null, encrypted_pem: new SecretBox(masterKey).encrypt(testPem), encrypted_client_secret: "x", encrypted_webhook_secret: "y" }];
      if (query.includes("FROM dashboard_installations i")) return [{ id: "22222222-2222-4222-8222-222222222222" }];
      if (query.includes("UPDATE system_onboarding SET organization_id")) return [{ organization_id: organizationId }];
      return [];
    }) as never;
    const github = new GitHubAppService({
      db: sql,
      fetch: async () => { throw new Error("GitHub should not be called"); },
      secretBox: new SecretBox(masterKey),
      publicOrigin: () => "https://control-plane.test",
    } as never);

    const launch = await github.beginInstallation("admin-1", organizationId, "resume-key");

    expect(launch).toEqual({ location: "https://control-plane.test/onboarding" });
    expect(calls.some((query) => query.includes("UPDATE system_onboarding SET organization_id"))).toBe(true);
    expect(calls.some((query) => query.includes("INSERT INTO github_setup_states"))).toBe(false);
    expect(calls.every((query) => !query.includes("r.approved"))).toBe(true);
  });

  test("reconciles every granted visibility and restores re-added repositories", async () => {
    const github = service(async () => Response.json({}));
    fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "pending", repositorySelection: "all", githubAccountId: 99 });
    fakeDb.repositories.set("4", { id: "4", installationId: 42, fullName: "acme/stale", visibility: "private", available: true });
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
    expect(fakeDb.repositories.get("4")).toMatchObject({ available: true });
    expect(fakeDb.repositories.get("3")).toMatchObject({ available: true, visibility: "public" });
    await github.reconcileInstallationRepositories({ installation: { id: 42 }, repositories_removed: [{ id: 1 }, { id: 2 }] });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: false });
    expect(fakeDb.repositories.has("1")).toBe(true);
    await github.reconcileInstallationRepositories({ installation: { id: 42 }, repositories_added: [{ id: 1, full_name: "acme/private", visibility: "private" }] });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: true });
    expect(fakeDb.installations.get(42)).toMatchObject({ state: "approved" });
  });
  test("uninstall suspends installation and disables every historical repository", async () => {
    const github = service(async () => Response.json({}));
    fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "approved", repositorySelection: "selected", githubAccountId: 99 });
    fakeDb.repositories.set("1", { id: "1", installationId: 42, fullName: "acme/private", visibility: "private", available: true });
    fakeDb.repositories.set("2", { id: "2", installationId: 42, fullName: "acme/internal", visibility: "internal", available: true });

    await github.reconcileInstallationRepositories({ installation: { id: 42 }, action: "uninstalled" });

    expect(fakeDb.installations.get(42)).toMatchObject({ state: "suspended" });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: false });
    expect(fakeDb.repositories.get("2")).toMatchObject({ available: false });
  });
  test("uninstalls an organization through the GitHub App API", async () => {
    const requests: Request[] = [];
    const github = service(async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 204 });
    });
    fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "y" };
    fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "approved", repositorySelection: "selected", githubAccountId: 99 });
    fakeDb.repositories.set("1", { id: "1", installationId: 42, fullName: "acme/private", visibility: "private", available: true });

    await github.uninstallOrganization(organizationId);

    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.url).toContain("/app/installations/42");
    expect(fakeDb.installations.get(42)).toMatchObject({ state: "suspended" });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: false });
  });

  test("starts a second organization installation without rebinding onboarding", async () => {
    const github = service(async () => Response.json({}));
    fakeDb.appConfig = { id: 9, slug: "mars-test", pem: "encrypted", clientSecret: "encrypted", webhookSecret: "encrypted" };
    fakeDb.organizations = new Map([
      [organizationId, { githubOrgId: 99 }],
      ["22222222-2222-4222-8222-222222222222", { githubOrgId: 100 }],
    ]);

    const launch = await github.beginOrganizationInstallation("admin-1", "22222222-2222-4222-8222-222222222222", "org-2-key");

    expect(launch.location).toContain("github.com/apps/");
    expect(launch.installCookie).toBeDefined();
    expect([...fakeDb.setupStates.values()]).toHaveLength(1);
  });

  test("validates each webhook against the current decrypted secret and dispatches installation removal", async () => {
    const github = service(async () => Response.json({}));
    fakeDb.repositories.set("1", { id: "1", installationId: 42, fullName: "acme/private", visibility: "private", available: true });
    expect(await github.getWebhookSecret()).toBeNull();
    await github.reconcileInstallationRepositories({ installation: { id: 42 }, action: "removed", repositories_removed: [{ id: 1 }] });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: false });
  });
  test("accepts a matching personal GitHub installation", async () => {
    const github = service(async (input) => {
      const url = String(input);
      if (url.endsWith("/app/installations/42")) return Response.json({ account: { type: "User", id: 77 }, repository_selection: "selected" });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/installation/repositories")) return Response.json({ repository_selection: "selected", repositories: [{ id: 8, full_name: "snazzie/private", visibility: "private" }] });
      return Response.json({});
    });
    fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "y" };
    fakeDb.organizations = new Map([[organizationId, { githubOrgId: 77, githubAccountType: "User" }]] as never);
    const launch = await github.beginInstallation("admin-1", organizationId, "personal-key");
    await expect(github.completeInstallation("admin-1", launch.installCookie!, 42)).resolves.toBe(true);
    expect(fakeDb.installations.get(42)).toMatchObject({ githubAccountId: 77, state: "approved" });
  });

});
test("workflow discovery authenticates every private repository read", async () => {
  const calls: Request[] = [];
  const github = service(async (input, init) => {
    const request = new Request(input, init); calls.push(request);
    const url = String(input);
    if (url.endsWith("/access_tokens")) return Response.json({ token: "secret-installation-token" });
    if (url.includes("/git/trees/")) return Response.json({ tree: [{ type: "blob", path: ".github/workflows/ci.yml", sha: "blob-sha" }] });
    if (url.includes("/git/blobs/")) return Response.json({ content: Buffer.from("jobs:\n  test:\n    runs-on: ubuntu-latest\n").toString("base64") });
    return Response.json({ default_branch: "main" });
  });
  fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "approved", repositorySelection: "all" });
  fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "x" };
  const result = await github.listRepositoryWorkflows("acme", "private", 42);
  expect(result.files).toHaveLength(1);
  expect(calls.filter((request) => !String(request.url).endsWith("/access_tokens")).every((request) => request.headers.get("authorization") === "Bearer secret-installation-token")).toBe(true);
});
test("workflow dispatch returns the new GitHub workflow run identity", async () => {
  const calls: Request[] = [];
  let runsRead = 0;
  const github = service(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const url = request.url;
    if (url.endsWith("/access_tokens")) return Response.json({ token: "secret-installation-token" });
    if (url.endsWith("/repos/acme/private")) return Response.json({ default_branch: "main" });
    if (url.includes("/git/trees/")) return Response.json({ tree: [{ type: "blob", path: ".github/workflows/smoke.yml", sha: "blob-sha" }] });
    if (url.includes("/git/blobs/")) return Response.json({ content: Buffer.from("on: workflow_dispatch\njobs:\n  smoke:\n    runs-on: mars-windows-x64\n").toString("base64") });
    if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
    if (url.includes("/actions/workflows/") && url.includes("/runs?")) {
      runsRead += 1;
      return Response.json({ workflow_runs: runsRead === 1 ? [{ id: 40, event: "workflow_dispatch" }] : [{ id: 41, event: "workflow_dispatch" }, { id: 40, event: "workflow_dispatch" }] });
    }
    return Response.json({});
  });
  fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "approved", repositorySelection: "all" });
  fakeDb.repositories.set("repo-1", { id: "repo-1", installationId: 42, organizationId, fullName: "acme/private", available: true });
  fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "x" };

  await expect(github.dispatchRepositoryWorkflow({ organizationId, repositoryId: "repo-1", workflowPath: ".github/workflows/smoke.yml" })).resolves.toEqual({ githubRunId: 41 });
  const dispatch = calls.find((request) => request.url.endsWith("/dispatches"));
  expect(dispatch?.method).toBe("POST");
  expect(await dispatch?.json()).toEqual({ ref: "main" });
});

test("workflow preview uses the current runner pool schema", async () => {
  const box = new SecretBox(masterKey);
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("p.created_at")) throw new Error('column "created_at" does not exist');
    if (query.includes("FROM github_app_config")) {
      return [{ app_id: 9, slug: "mars", client_id: null, encrypted_pem: box.encrypt(testPem), encrypted_client_secret: "x", encrypted_webhook_secret: "x" }];
    }
    if (query.includes("FROM dashboard_repositories r")) {
      return [{ installation_id: 42, full_name: "acme/private", labels: ["self-hosted", "macos"] }];
    }
    return [];
  }) as never;
  const github = new GitHubAppService({
    db: sql,
    secretBox: box,
    publicOrigin: () => "https://control-plane.test",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.includes("/git/trees/")) return Response.json({ tree: [{ type: "blob", path: ".github/workflows/ci.yml", sha: "blob-sha" }] });
      if (url.includes("/git/blobs/")) return Response.json({ content: Buffer.from("jobs:\n  test:\n    runs-on: ubuntu-latest\n").toString("base64") });
      if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "head-sha" } });
      return Response.json({ default_branch: "main" });
    },
  } as never);

  const preview = await github.previewRepositoryRunnerPr({ organizationId, repositoryId: "repo-1", selectedPaths: [".github/workflows/ci.yml"] });

  expect(preview.replacementCount).toBe(1);
  expect(preview.labels).toEqual(["self-hosted", "macos"]);
});

test("repository workflow setup retires a repository after GitHub 404", async () => {
  const github = service(async (input) => {
    const url = String(input);
    if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
    if (url.includes("/repos/acme/repo")) return new Response(null, { status: 404 });
    return Response.json({});
  });
  fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "approved", repositorySelection: "all" });
  fakeDb.repositories.set("repo-1", { id: "repo-1", installationId: 42, organizationId, fullName: "acme/repo", visibility: "private", available: true });
  fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "x" };

  await expect(github.previewRepositoryRunnerPr({ organizationId, repositoryId: "repo-1", selectedPaths: [] })).rejects.toThrow("github_repository_unavailable");
  expect(fakeDb.repositories.get("repo-1")).toMatchObject({ available: false });
});

test.each([403, 429, 500])("repository workflow setup preserves availability after GitHub %i", async (status) => {
  const github = service(async (input) => {
    const url = String(input);
    if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
    if (url.includes("/repos/acme/repo")) return new Response(null, { status });
    return Response.json({});
  });
  fakeDb.installations.set(42, { organizationId, githubInstallationId: 42, state: "approved", repositorySelection: "all" });
  fakeDb.repositories.set("repo-1", { id: "repo-1", installationId: 42, organizationId, fullName: "acme/repo", visibility: "private", available: true });
  fakeDb.appConfig = { id: 9, slug: "mars", pem: new SecretBox(masterKey).encrypt(testPem), clientSecret: "x", webhookSecret: "x" };

  await expect(github.previewRepositoryRunnerPr({ organizationId, repositoryId: "repo-1", selectedPaths: [] })).rejects.toThrow(`github_${status}`);
  expect(fakeDb.repositories.get("repo-1")).toMatchObject({ available: true });
});