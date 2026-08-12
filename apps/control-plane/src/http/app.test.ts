import { describe, expect, test } from "bun:test";
import { createControlPlaneApp } from "./app.ts";
import { fakeHttpDeps } from "./test-deps.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const app = createControlPlaneApp(fakeHttpDeps());

describe("control-plane HTTP boundary", () => {
  test("serves health only below /api", async () => {
    expect((await app.request("/api/healthz")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(404);
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
  test("injects the download origin into the Linux installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitesmith-installers-"));
    try {
      await Bun.write(join(root, "install-worker.sh"), '#!/usr/bin/env bash\n: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"\n');
      const response = await createControlPlaneApp(fakeHttpDeps({
        baseUrl: "http://localhost:3000",
        workerInstallerRoot: pathToFileURL(`${root}/`),
      })).request("/api/workers/installer?audience=linux-x64");
      const installer = await response.text();

      expect(response.status).toBe(200);
      expect(installer).toStartWith("#!/usr/bin/env bash\n");
      expect(installer).toContain("PUBLIC_BASE_URL='http://localhost:3000'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serves the configured macOS orchestrator executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitesmith-orchestrator-"));
    try {
      const executable = join(root, "whitesmith-orchestrator");
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



  test("allows OAuth cookies on local HTTP but secures them on HTTPS", async () => {
    const local = await createControlPlaneApp(fakeHttpDeps({ baseUrl: "http://localhost:3000" })).request("/api/auth/github");
    expect(local.headers.get("set-cookie")).toContain("oauth_state=");
    expect(local.headers.get("set-cookie")).not.toContain("Secure");

    const production = await createControlPlaneApp(fakeHttpDeps({ baseUrl: "https://control-plane.test" })).request("/api/auth/github");
    expect(production.headers.get("set-cookie")).toContain("Secure");
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
  test("requires an idempotency key for GitHub App manifest launch", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/github/app/manifest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(401);
  });

  test("requires an idempotency key for GitHub App installation launch", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/github/app/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(401);
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
  test("returns repository selection failures to resumable onboarding", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => { throw new Error("repository_selection_required"); } } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=selected" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/onboarding?github=repository-selection-required");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
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

  test("repository approval changes one repository without changing installation trust", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request(
      `/api/organizations/${crypto.randomUUID()}/repositories/${crypto.randomUUID()}/approve`,
      { method: "POST", headers: { "Idempotency-Key": "approval-1" } },
    );
    expect(response.status).toBe(401);
  });
