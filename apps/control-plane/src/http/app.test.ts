import { describe, expect, test } from "bun:test";
import { createControlPlaneApp } from "./app.ts";
import { fakeHttpDeps } from "./test-deps.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const app = createControlPlaneApp(fakeHttpDeps());

describe("control-plane HTTP boundary", () => {
  test("serves build and discovery health only below /api", async () => {
    const response = await app.request("/api/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      buildId: "test-build",
      startedAt: "2026-08-13T00:00:00.000Z",
      discovery: {
        lastAttemptAt: "2026-08-13T00:00:30.000Z",
        lastSuccessAt: "2026-08-13T00:00:31.000Z",
        stale: false,
        staleAfterMs: 60_000,
      },
    });
    expect((await app.request("/healthz")).status).toBe(404);
  });
  test("returns ordered approved worker connection origins to global admins", async () => {
    const member = { id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true };
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => member,
      workerConnectionOrigins: () => ["https://control.example", "https://adapter.example"],
    })).request("/api/workers/control-plane-urls");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["https://control.example", "https://adapter.example"]);
  });

  test("exposes the synchronized public origin and managed flag in onboarding status", async () => {
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ").toLowerCase();
      if (query.includes("from system_onboarding")) return [{ adminUserId: null, workerId: null, organizationId: null, completedAt: null, publicBaseUrl: "https://control.example.com", originConfigured: true, githubAppConfigured: false }];
      return [];
    }) as never;
    const response = await createControlPlaneApp(fakeHttpDeps({
      db,
      setup: { publicOrigin: () => "https://control.example.com", publicOriginManaged: () => true, configure: async origin => origin, authenticate: async () => ({ userId: "admin", firstAdmin: true }) },
    })).request("/api/onboarding/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ publicBaseUrl: "https://control.example.com", publicBaseUrlManaged: true, step: "setup" });
  });
  test("returns the authenticated operator for the dashboard session probe", async () => {
    const member = { id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true };
    const response = await createControlPlaneApp(fakeHttpDeps({ currentUser: async () => member })).request("/api/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(member);
  });
  test("reports stale discovery as unhealthy", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      health: () => ({
        buildId: "test-build",
        startedAt: "2026-08-13T00:00:00.000Z",
        discovery: {
          lastAttemptAt: "2026-08-13T00:01:00.000Z",
          lastSuccessAt: "2026-08-13T00:00:00.000Z",
          stale: true,
          staleAfterMs: 60_000,
        },
      }),
    })).request("/api/healthz");

    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
  });

  test("never serves the SPA for an unknown API route", async () => {
    const response = await app.request("/api/not-a-route");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
  test("protects bootstrap rotation behind global-admin authentication", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/workers/bootstrap/rotate", { method: "POST", headers: { "Idempotency-Key": "test" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).not.toBe("public");
  });
  test("registers bootstrap initialization behind global-admin authentication", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/workers/bootstrap/initialize", { method: "POST", headers: { "Idempotency-Key": "test" } });
    expect(response.status).toBe(401);
  });
  test("requires a configured worker connection origin for installers", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/workers/installer?audience=linux-x64");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_worker_origin", message: "Choose a configured worker connection origin" });
  });
  test("injects the selected adapter origin into the Linux installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-installers-"));
    try {
      await Bun.write(join(root, "install-worker.sh"), '#!/usr/bin/env bash\n: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"\n');
      await Bun.write(join(root, "linux-broker-compose.yaml"), "compose");
      await Bun.write(join(root, "worker-domain.xml"), "domain");
      const response = await createControlPlaneApp(fakeHttpDeps({
        baseUrl: "https://control.test",
        workerInstallerRoot: pathToFileURL(`${root}/`),
        workerConnectionOrigins: () => ["https://control.test", "https://worker.test"],
      })).request("/api/workers/installer?audience=linux-x64&connectOrigin=https%3A%2F%2Fworker.test");
      const installer = await response.text();

      expect(response.status).toBe(200);
      expect(installer).toContain("PUBLIC_BASE_URL='https://worker.test'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("rejects an unconfigured worker connection origin", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      workerConnectionOrigins: () => ["https://control.test"],
    })).request("/api/workers/installer?audience=linux-x64&connectOrigin=https%3A%2F%2Fevil.test");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_worker_origin", message: "Choose a configured worker connection origin" });
  });
  test("injects the control-plane origin into the Linux installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-installers-"));
    try {
      await Bun.write(join(root, "install-worker.sh"), '#!/usr/bin/env bash\n: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"\n');
      await Bun.write(join(root, "linux-broker-compose.yaml"), "compose");
      await Bun.write(join(root, "worker-domain.xml"), "domain");
      const response = await createControlPlaneApp(fakeHttpDeps({
        baseUrl: "http://localhost:3000",
        browserBaseUrl: "http://localhost:5173",
        workerInstallerRoot: pathToFileURL(`${root}/`),
      })).request("/api/workers/installer?audience=linux-x64&connectOrigin=http%3A%2F%2Flocalhost%3A3000");
      const installer = await response.text();

      expect(response.status).toBe(200);
      expect(installer).toStartWith("#!/usr/bin/env bash\n");
      expect(installer).toContain("PUBLIC_BASE_URL='http://localhost:3000'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serves container-mode Windows installer without local image build inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-windows-installers-"));
    try {
      await Bun.write(join(root, "install-worker.ps1"), "[CmdletBinding()]\r\nparam(\r\n  [string]$WindowsContainerImage = 'mars/windows-job:local',\r\n  [int]$WindowsContainerReadyTimeoutMs = 15000\r\n)\r\n$ErrorActionPreference = 'Stop'\r\n");
      await Bun.write(join(root, "windows-orchestrator"), "orchestrator");
      await Bun.write(join(root, "service-host.exe"), "service-host");
      const deps = { baseUrl: "https://control.test", workerInstallerRoot: pathToFileURL(`${root}/`), windowsContainerBuild: undefined, windowsContainerArtifacts: undefined, workerOrchestratorExecutables: { "windows-x64": pathToFileURL(join(root, "windows-orchestrator")) }, workerServiceHostExecutable: pathToFileURL(join(root, "service-host.exe")) };
      const response = await createControlPlaneApp(fakeHttpDeps(deps)).request("/api/workers/installer?audience=windows-x64&runtime=container&connectOrigin=https%3A%2F%2Fcontrol.test");
      const installer = await response.text();
      expect(response.status).toBe(200);
      expect(installer).toContain("$ControlPlaneUrl = 'https://control.test'");
      expect(installer).not.toContain("windows-container-builder");
      expect(installer).not.toContain("__PLACEHOLDER__");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("rejects Windows VM installer requests in v1", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/workers/installer?audience=windows-x64&runtime=vm&connectOrigin=https%3A%2F%2Fcontrol-plane.test");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "unsupported_runtime", message: "Only the container runtime is supported in worker v1" });
  });
  test("injects split Tart runtime identity into the macOS installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-macos-installers-"));
    try {
      await Bun.write(join(root, "macos-orchestrator"), "orchestrator");
      await Bun.write(join(root, "install-worker-macos.sh"), "#!/bin/zsh\nprint ready\n");
      const response = await createControlPlaneApp(fakeHttpDeps({
        baseUrl: "http://localhost:3000",
        workerInstallerRoot: pathToFileURL(`${root}/`),
        workerOrchestratorExecutable: pathToFileURL(join(root, "macos-orchestrator")),
      })).request("/api/workers/installer?audience=macos-arm64&connectOrigin=http%3A%2F%2Flocalhost%3A3000");
      const installer = await response.text();
      expect(response.status).toBe(200);
      expect(installer).toContain(`TART_IMAGE='ghcr.io/mars/macos@sha256:${"a".repeat(64)}'`);
      expect(installer).toContain(`MARS_ORCHESTRATOR_SHA256='${"a".repeat(64)}'`);
      expect(installer).toContain(`TART_IMAGE_DIGEST='${"a".repeat(64)}'`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serves the configured macOS orchestrator executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-orchestrator-"));
    try {
      const executable = join(root, "mars-orchestrator");
      await Bun.write(executable, "macos-arm64-binary");
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerOrchestratorExecutable: pathToFileURL(executable),
      })).request("/api/workers/orchestrator?audience=macos-arm64");

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("macos-arm64-binary");
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serves the configured Windows service host executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-service-host-"));
    try {
      const executable = join(root, "mars-service-host.exe");
      await Bun.write(executable, "windows-service-host-binary");
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerServiceHostExecutable: pathToFileURL(executable),
      })).request("/api/workers/service-host?audience=windows-x64");

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("windows-service-host-binary");
      expect(response.headers.get("content-disposition")).toContain("mars-service-host.exe");
      expect(response.headers.get("X-Content-SHA256")).toBe("a".repeat(64));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("reports a missing Windows service host artifact", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      workerServiceHostExecutable: pathToFileURL(join(tmpdir(), crypto.randomUUID(), "missing.exe")),
    })).request("/api/workers/service-host?audience=windows-x64");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test("sets Content-Length for large Windows job-agent downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-windows-job-agent-"));
    try {
      const payload = "windows-container-job-agent-fixture";
      const jobAgentPath = join(root, "mars-job-agent.exe");
      await Bun.write(jobAgentPath, payload);
      const response = await createControlPlaneApp(fakeHttpDeps({
        windowsContainerArtifacts: {
          builderPath: jobAgentPath,
          verifierPath: jobAgentPath,
          containerfilePath: jobAgentPath,
          entrypointPath: jobAgentPath,
          jobAgentPath,
        },
      })).request("/api/workers/windows-container-job-agent");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(await Bun.file(jobAgentPath).size));
      expect(await response.text()).toBe(payload);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("redirects browser OAuth starts to onboarding when setup origin is unavailable", async () => {
    const defaults = fakeHttpDeps();
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      setup: { ...defaults.setup, publicOrigin: () => null },
    })).request("/api/auth/github", { headers: { Accept: "text/html" } });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/onboarding");
  });
  test("redirects browser OAuth starts to onboarding when OAuth credentials are unavailable", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      githubApp: undefined,
    })).request("/api/auth/github", { headers: { Accept: "text/html" } });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/onboarding");
  });

  test("keeps setup-required JSON for API OAuth starts", async () => {
    const defaults = fakeHttpDeps();
    const depsList = [
      fakeHttpDeps({ setup: { ...defaults.setup, publicOrigin: () => null } }),
      fakeHttpDeps({ githubApp: undefined }),
    ];
    for (const deps of depsList) {
      const response = await createControlPlaneApp(deps).request("/api/auth/github", {
        headers: { Accept: "application/json" },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "setup_required", message: "Complete first-run setup" });
    }
  });





  test("preserves the dashboard return path when refreshing GitHub organizations", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({ baseUrl: "http://localhost:3000" })).request("/api/auth/github?returnTo=%2Frepositories");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("oauth_return_to=%2Frepositories");
  });
  test("does not persist unsafe OAuth return paths", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({ baseUrl: "http://localhost:3000" })).request("/api/auth/github?returnTo=%2F%5Cevil.com");
    expect(response.headers.get("set-cookie")).not.toContain("oauth_return_to=");
  });
  test("uses the public callback and browser origin for OAuth returns", async () => {
    const secretBox = fakeHttpDeps().secretBox;
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("update github_setup_states")) return [{ encrypted_pkce_verifier: secretBox.encrypt("verifier") }];
      if (query.includes("insert into users")) return [{ id: "user-1", is_global_admin: true }];
      if (query.includes("insert into organizations")) return [{ id: "personal-org" }];
      if (query.includes("SELECT completed_at FROM system_onboarding")) return [{ completed_at: null }];
      return [];
    }) as unknown as ReturnType<typeof fakeHttpDeps>["db"];
    Object.assign(sql, { begin: async (callback: (transaction: typeof sql) => Promise<unknown>) => callback(sql) });
    const deps = fakeHttpDeps({
      db: sql,
      baseUrl: "http://localhost:3000",
      browserBaseUrl: "http://localhost:5173",
    });
    const oauthStart = await createControlPlaneApp(deps).request("/api/auth/github");
    expect(new URL(oauthStart.headers.get("location") ?? "").searchParams.get("redirect_uri"))
      .toBe("http://localhost:3000/api/auth/github/callback");

    const previousFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) return Response.json({ access_token: "github-token" });
      if (url.includes("/user/orgs")) return Response.json([]);
      if (url.endsWith("/user")) return Response.json({ id: 7, login: "bootstrap" });
      return new Response(null, { status: 404 });
    }, { preconnect: previousFetch.preconnect });
    try {
      const callback = await createControlPlaneApp(deps).request("/api/auth/github/callback?state=state&code=code", {
        headers: { Cookie: "oauth_state=state" },
      });
      expect(callback.headers.get("location")).toBe("http://localhost:5173/onboarding");
      expect(callback.headers.get("set-cookie")).toContain("mars_session=");

      const repositoryCallback = await createControlPlaneApp(deps).request("/api/auth/github/callback?state=state&code=code", {
        headers: { Cookie: "oauth_state=state; oauth_return_to=%2Frepositories" },
      });
      expect(repositoryCallback.headers.get("location")).toBe("http://localhost:5173/repositories");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });


  test("serves run list and detail deep links", async () => {
    expect((await app.request("/runs")).status).toBe(200);
    expect((await app.request("/runs/123")).status).toBe(200);
  });

  test("serves all dashboard and onboarding client routes", async () => {
    for (const path of ["/settings", "/workers", "/pools", "/repositories", "/runs", "/onboarding"]) {
      expect((await app.request(path)).status).toBe(200);
    }
  });
});
  test("requires authentication for GitHub App manifest launch", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/github/app/manifest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(401);
  });

  test("launches GitHub App manifest for a global admin", async () => {
    const calls: Array<{ userId: string; organizationId: string; idempotencyKey: string }> = [];
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 7, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        createManifestLaunch: async (userId: string, organizationId: string, idempotencyKey: string) => {
          calls.push({ userId, organizationId, idempotencyKey });
          return { action: "https://github.com/settings/apps/new?state=test", manifest: "{\"name\":\"mars\"}" };
        },
      } as never,
    })).request("/api/github/app/manifest", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "manifest-test" },
      body: JSON.stringify({ organizationId: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "https://github.com/settings/apps/new?state=test", manifest: "{\"name\":\"mars\"}" });
    expect(calls).toEqual([{ userId: "admin", organizationId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "manifest-test" }]);
  });
  test("rejects malformed setup origins before launching a manifest", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      setup: {
        ...fakeHttpDeps().setup,
        configure: async () => { throw new Error("PUBLIC_BASE_URL must be an absolute HTTP(S) origin"); },
      },
      githubApp: { createManifestLaunch: async () => ({ action: "unused", manifest: "{}" }) } as never,
    })).request("/api/setup/github-app", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "setup-test" },
      body: JSON.stringify({ publicBaseUrl: "ftp://unsafe.example" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_origin" });
  });

  test("maps a completed setup race to setup_state_expired", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      setup: {
        ...fakeHttpDeps().setup,
        configure: async () => { throw new Error("setup_state_expired"); },
      },
      githubApp: { createManifestLaunch: async () => ({ action: "unused", manifest: "{}" }) } as never,
    })).request("/api/setup/github-app", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "setup-race" },
      body: JSON.stringify({ publicBaseUrl: "https://control-plane.test" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "setup_state_expired" });
  });

  test("maps an environment-managed origin mismatch to a bad request", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      setup: {
        ...fakeHttpDeps().setup,
        configure: async () => { throw new Error("configured_origin_mismatch"); },
      },
      githubApp: { createManifestLaunch: async () => ({ action: "unused", manifest: "{}" }) } as never,
    })).request("/api/setup/github-app", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "setup-mismatch" },
      body: JSON.stringify({ publicBaseUrl: "https://other.example" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "configured_origin_mismatch" });
  });

  test("requires an idempotency key for GitHub App installation launch", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/github/app/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(401);
  });
  test("starts an unbound GitHub installation from onboarding", async () => {
    let requestedUser = "";
    let requestedKey = "";
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        beginUnboundInstallation: async (userId: string, key: string) => {
          requestedUser = userId;
          requestedKey = key;
          return { location: "https://github.com/apps/mars/installations/new", installCookie: "state-cookie" };
        },
      } as never,
    })).request("/api/onboarding/github/install", {
      method: "POST",
      headers: { "Idempotency-Key": "unbound-install" },
    });
    expect(response.status).toBe(200);
    expect(requestedUser).toBe("admin");
    expect(requestedKey).toBe("unbound-install");
    expect(await response.json()).toEqual({ location: "https://github.com/apps/mars/installations/new" });
    expect(response.headers.get("set-cookie")).toContain("github_install_state=state-cookie");
  });

  test("protects unbound GitHub installation launch", async () => {
    const missingAuth = await createControlPlaneApp(fakeHttpDeps()).request("/api/onboarding/github/install", { method: "POST", headers: { "Idempotency-Key": "key" } });
    expect(missingAuth.status).toBe(401);
    const forbidden = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "member", githubUserId: 2, login: "member", isGlobalAdmin: false }),
    })).request("/api/onboarding/github/install", { method: "POST", headers: { "Idempotency-Key": "key" } });
    expect(forbidden.status).toBe(403);
    const missingKey = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    })).request("/api/onboarding/github/install", { method: "POST" });
    expect(missingKey.status).toBe(400);

    const unavailable = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: undefined,
    })).request("/api/onboarding/github/install", { method: "POST", headers: { "Idempotency-Key": "key" } });
    expect(unavailable.status).toBe(503);
  });
  test("preserves the install cookie when a bound callback rejects the GitHub account", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => { throw new Error("wrong_organization"); } } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=bound-state" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "wrong_organization" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });


  test("rejects GitHub setup callbacks for missing or replayed install state", async () => {
    const first = await createControlPlaneApp(fakeHttpDeps()).request(
      "/api/github/app/setup?installation_id=42&setup_action=install",
    );
    const replay = await createControlPlaneApp(fakeHttpDeps()).request(
      "/api/github/app/setup?installation_id=42&setup_action=install",
      { headers: { cookie: "github_install_state=consumed" } },
    );
    expect(first.status).toBe(401);
    expect(replay.status).toBe(401);
  });
  test("maps replayed GitHub setup callbacks to a conflict response", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => { throw new Error("setup_state_expired"); } } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=expired" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "setup_state_expired" });
  });
  test("returns completed GitHub setup to the browser onboarding origin", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => true } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=onboarding" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/onboarding");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  test("returns repository selection failures to resumable onboarding", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => { throw new Error("repository_selection_required"); } } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=selected" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/onboarding?github=repository-selection-required");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  test("returns dashboard after a non-onboarding organization install", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => false } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=organization-install" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/");
  });
test("repository GitHub removal route requires an existing installation", async () => {
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/repositories/repo-1/github/settings");
  expect(response.status).toBe(404);
});

test("organization GitHub uninstall route requires an existing installation", async () => {
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/github/settings");
  expect(response.status).toBe(404);
});
test("returns the organization GitHub settings URL", async () => {
  const db = ((strings: TemplateStringsArray) => strings.join("?").includes("dashboard_installations") ? [{ login: "acme", githubInstallationId: 42 }] : []) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/github/settings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ location: "https://github.com/organizations/acme/settings/installations/42" });
});

test("returns the repository GitHub settings URL", async () => {
  const db = ((strings: TemplateStringsArray) => strings.join("?").includes("dashboard_repositories") ? [{ login: "acme", githubInstallationId: 42 }] : []) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/repositories/repo-1/github/settings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ location: "https://github.com/organizations/acme/settings/installations/42" });
});

test("returns the user-account GitHub settings URL", async () => {
  const db = ((strings: TemplateStringsArray) => strings.join("?").includes("dashboard_installations")
    ? [{ login: "Snazzie", githubInstallationId: 153311365, githubAccountType: "User" }]
    : []) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/github/settings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ location: "https://github.com/settings/installations/153311365" });
});

test("does not return GitHub settings for unavailable repositories", async () => {
  const db = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (!query.includes("dashboard_repositories")) return [];
    return query.includes("r.available=true") && query.includes("i.state <> 'suspended'")
      ? []
      : [{ login: "acme", githubInstallationId: 42, available: false, state: "suspended" }];
  }) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/repositories/repo-1/github/settings");
  expect(response.status).toBe(404);
});
test("uninstalls an organization through the authenticated GitHub route", async () => {
  let organization = "";
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    githubApp: { uninstallOrganization: async (organizationId: string) => { organization = organizationId; } } as never,
  })).request("/api/organizations/org-2/github/uninstall", {
    method: "POST",
    headers: { "Idempotency-Key": "uninstall-1" },
  });
  expect(response.status).toBe(200);
  expect(organization).toBe("org-2");
  expect(await response.json()).toEqual({ ok: true });
});


  test("webhook validation uses the configured app secret and never accepts a static fallback", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({ githubWebhookSecret: "database-secret" })).request(
      "/api/github/webhooks",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-hub-signature-256": "sha256=not-valid",
          "x-github-delivery": "delivery-1",
        },
        body: JSON.stringify({ action: "suspend", installation: { id: 7 } }),
      },
    );
    expect(response.status).toBe(401);
  });

  test("repository approval endpoints are retired", async () => {
    const retired = createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    }));
    for (const action of ["approve", "reject"]) {
      const response = await retired.request(`/api/organizations/org-1/repositories/repo-1/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": `repository-${action}` },
      });
      expect(response.status).toBe(404);
    }
  });

  test("repository workflow listing uses scoped availability and stable missing-repository errors", async () => {
    let listed: unknown;
    const success = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        listRepositoryRunnerWorkflows: async (input: unknown) => {
          listed = input;
          return { defaultBranch: "main", files: [] };
        },
      } as never,
    })).request("/api/organizations/org-1/repositories/repo-1/runner-workflows");
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual([]);
    expect(listed).toEqual({ organizationId: "org-1", repositoryId: "repo-1" });

    const unavailable = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        listRepositoryRunnerWorkflows: async () => { throw new Error("github_repository_unavailable"); },
      } as never,
    })).request("/api/organizations/org-1/repositories/repo-1/runner-workflows");
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toMatchObject({ code: "repository_unavailable" });

    const missingPermissions = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        listRepositoryRunnerWorkflows: async () => { throw new Error("github_403"); },
      } as never,
    })).request("/api/organizations/org-1/repositories/repo-1/runner-workflows");
    expect(missingPermissions.status).toBe(409);
    expect(await missingPermissions.json()).toMatchObject({
      code: "github_app_permissions_missing",
      message: "GitHub App needs Contents and Pull requests write permissions. Update and approve the app permissions, then refresh.",
    });
  });

  test("refreshes repositories from an existing GitHub installation", async () => {
    let refreshedOrganization = "";
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        refreshInstallationRepositories: async (organizationId: string) => { refreshedOrganization = organizationId; },
      } as never,
    })).request("/api/organizations/org-1/github/refresh", {
      method: "POST",
      headers: { "Idempotency-Key": "github-refresh-1" },
    });

    expect(response.status).toBe(200);
    expect(refreshedOrganization).toBe("org-1");
    expect(await response.json()).toEqual({ ok: true });
  });
test("starts GitHub installation for a non-onboarding organization", async () => {
  let requestedOrganization = "";
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    githubApp: {
      beginOrganizationInstallation: async (_userId: string, organizationId: string) => {
        requestedOrganization = organizationId;
        return { location: "https://github.com/apps/mars/installations/new" };
      },
    } as never,
  })).request("/api/organizations/org-2/github/install", {
    method: "POST",
    headers: { "Idempotency-Key": "org-2-install", "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(requestedOrganization).toBe("org-2");
  expect(await response.json()).toEqual({ location: "https://github.com/apps/mars/installations/new" });
});
test("generates complete platform installers from the immutable release manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-release-installers-"));
  const hash = "a".repeat(64);
  try {
    for (const file of ["install-worker.sh", "install-worker.ps1", "install-worker-macos.sh", "linux-broker-compose.yaml", "worker-domain.xml"]) {
      await Bun.write(join(root, file), file.endsWith(".ps1") ? "'__PUBLIC_BASE_URL__' '__WINDOWS_RUNTIME__' '__WINDOWS_CONTAINER_BASE_IMAGE__' '__WINDOWS_CONTAINER_RUNNER_URL__' '__WINDOWS_CONTAINER_RUNNER_SHA256__' '__WINDOWS_TEMPLATE_PATH__' '__WINDOWS_TEMPLATE_DIGEST__'" : "#!/bin/sh\n$PUBLIC_BASE_URL");
    }
    const manifest = {
      schemaVersion: 2 as const,
      buildId: "build-1",
      contractVersion: "0.1.0",
      platforms: {
        "linux-x64": { orchestratorSha256: hash, brokerImage: `ghcr.io/mars/broker@sha256:${hash}`, goldenImageUrl: "https://release.test/worker.qcow2", goldenImageSha256: hash, composeSha256: hash, domainTemplateSha256: hash },
        "windows-x64": { orchestratorSha256: hash, serviceHostSha256: hash, vmTemplateUrl: "https://release.test/worker.vhdx", vmTemplateSha256: hash, container: { baseImage: `mcr.microsoft.com/windows@sha256:${hash}`, runner: { url: "https://release.test/runner.zip", sha256: hash }, git: { url: "https://release.test/git.zip", sha256: hash }, vcRuntime: { url: "https://release.test/vc.exe", sha256: hash } } },
        "macos-arm64": { orchestratorSha256: hash, tartImage: `ghcr.io/mars/macos@sha256:${hash}`, tartImageDigest: hash },
      },
    };
    const response = await createControlPlaneApp(fakeHttpDeps({
      workerInstallerRoot: pathToFileURL(`${root}/`),
      workerReleaseManifest: manifest,
      workerConnectionOrigins: () => ["https://adapter.test"],
      workerOrchestratorExecutables: { "linux-x64": pathToFileURL(join(root, "linux-orchestrator")), "windows-x64": pathToFileURL(join(root, "windows-orchestrator")), "macos-arm64": pathToFileURL(join(root, "macos-orchestrator")) },
    })).request("/api/workers/installer?audience=linux-x64&connectOrigin=https%3A%2F%2Fadapter.test");
    expect(response.status).toBe(200);
    const installer = await response.text();
    expect(installer).toContain("PUBLIC_BASE_URL='https://adapter.test'");
    expect(installer).not.toContain("__");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
