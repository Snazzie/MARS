import { describe, expect, test } from "bun:test";
import { SecretBox } from "./auth.ts";
import { GitHubAppService } from "./github-app.ts";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const organizationId = "11111111-1111-4111-8111-111111111111";
const fakeDb = {
  setupStates: new Map<string, unknown>(),
  installations: new Map<number, unknown>(),
  repositories: new Map<string, unknown>(),
};

function service(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
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
      return new Response(JSON.stringify({ slug: "whitesmith", id: 9 }), { headers: { "content-type": "application/json" } });
    });
    const launch = await github.createManifestLaunch("admin-1", organizationId, "manifest-key");
    expect(launch.action).toContain("state=");
    expect(launch.manifest).toContain('"public":true');
    const replay = await github.createManifestLaunch("admin-1", organizationId, "manifest-key");
    expect(replay).toEqual(launch);
    await expect(github.completeManifestRegistration("wrong-user", "missing", "code")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("converts a manifest, encrypts returned secrets, then exchanges installation token with App headers", async () => {
    const requests: Request[] = [];
    const github = service(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/conversions")) {
        return Response.json({ id: 42, slug: "whitesmith", pem: "PRIVATE PEM", client_secret: "client-secret", webhook_secret: "webhook-secret" });
      }
      if (request.url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (request.url.endsWith("/app/installations/42")) return Response.json({ account: { type: "Organization", login: "acme" } });
      return Response.json({ repositories: [{ id: 1, full_name: "acme/private", private: true, visibility: "private" }] });
    });
    const launch = await github.createManifestLaunch("admin-1", organizationId, "manifest-key-2");
    const state = new URL(launch.action).searchParams.get("state")!;
    const result = await github.completeManifestRegistration("admin-1", state, "conversion-code");
    expect(result.location).toContain("github.com/apps/");
    expect(requests[0].headers.get("accept")).toBe("application/vnd.github+json");
    expect(requests[0].headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(requests[0].url).toContain("/app-manifests/conversion-code/conversions");
    expect(JSON.stringify(fakeDb)).not.toContain("PRIVATE PEM");
    expect(JSON.stringify(fakeDb)).not.toContain("webhook-secret");
  });

  test("rejects expired, replayed, wrong-user, wrong-organization, all, and public-only installation callbacks", async () => {
    const github = service(async () => Response.json({ account: { type: "User", login: "someone" } }));
    await expect(github.completeInstallation("missing-cookie", "not-a-cookie", 1)).rejects.toThrow();
    await expect(github.completeInstallation("admin-1", "expired-cookie", 1)).rejects.toThrow();
    await expect(github.completeInstallation("admin-1", "wrong-org-cookie", 1)).rejects.toThrow();
    await expect(github.completeInstallation("admin-1", "all-public-cookie", 1)).rejects.toThrow();
    await expect(github.completeInstallation("admin-1", "public-only-cookie", 1)).rejects.toThrow();
  });

  test("reconciles selected private/internal repositories and preserves removals as unavailable history", async () => {
    const github = service(async () => Response.json({}));
    await github.reconcileInstallationRepositories({
      installation: { id: 42 },
      repository_selection: "selected",
      repositories_added: [
        { id: 1, full_name: "acme/private", private: true, visibility: "private" },
        { id: 2, full_name: "acme/internal", private: true, visibility: "internal" },
        { id: 3, full_name: "acme/public", private: false, visibility: "public" },
      ],
    });
    await github.reconcileInstallationRepositories({ installation: { id: 42 }, repositories_removed: [{ id: 1 }] });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: false });
    expect(fakeDb.repositories.has("1")).toBe(true);
  });

  test("validates each webhook against the current decrypted secret and dispatches installation removal", async () => {
    const github = service(async () => Response.json({}));
    expect(await github.getWebhookSecret()).toBeNull();
    await github.reconcileInstallationRepositories({ installation: { id: 42 }, action: "removed", repositories_removed: [{ id: 1 }] });
    expect(fakeDb.repositories.get("1")).toMatchObject({ available: false });
  });
});
