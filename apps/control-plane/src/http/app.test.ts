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



  test("preserves the dashboard return path when refreshing GitHub organizations", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({ baseUrl: "http://localhost:3000" })).request("/api/auth/github?returnTo=%2Frepositories");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("oauth_return_to=%2Frepositories");
  });
  test("does not persist unsafe OAuth return paths", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({ baseUrl: "http://localhost:3000" })).request("/api/auth/github?returnTo=%2F%5Cevil.com");
    expect(response.headers.get("set-cookie")).not.toContain("oauth_return_to=");
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
  test("returns dashboard after a non-onboarding organization install", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => false } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=organization-install" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
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

  test("repository approval changes one repository without changing installation trust", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request(
      `/api/organizations/${crypto.randomUUID()}/repositories/${crypto.randomUUID()}/approve`,
      { method: "POST", headers: { "Idempotency-Key": "approval-1" } },
    );
    expect(response.status).toBe(401);
  });

  test("approves an eligible repository and persists the approval", async () => {
    let approved = false;
    const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("UPDATE dashboard_repositories SET approved=")) {
        approved = values[0] === true;
        return [{ id: "repo-1" }];
      }
      return [];
    }) as never;
    const response = await createControlPlaneApp(fakeHttpDeps({
      db,
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    })).request("/api/organizations/org-1/repositories/repo-1/approve", {
      method: "POST",
      headers: { "Idempotency-Key": "approval-eligible-1" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(approved).toBe(true);
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
        return { location: "https://github.com/apps/whitesmith/installations/new" };
      },
    } as never,
  })).request("/api/organizations/org-2/github/install", {
    method: "POST",
    headers: { "Idempotency-Key": "org-2-install", "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(requestedOrganization).toBe("org-2");
  expect(await response.json()).toEqual({ location: "https://github.com/apps/whitesmith/installations/new" });
});
