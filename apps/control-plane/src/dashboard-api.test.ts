import { describe, expect, test } from "bun:test";
import { createControlPlaneApp } from "./http/app.ts";
function fakeDb(rows: unknown[] = [], memberAllowed = true) {
  return Object.assign(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("FROM memberships")) return memberAllowed ? [{ ok: true }] : [];
    if (query.includes("FROM organizations")) return rows;
    if (query.includes("dashboard_mutations")) return [{ idempotency_key: "key" }];
    if (query.includes("organization_settings")) return [{ organizationId: "org", maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }];
    if (query.includes("FROM workers")) return [];
    if (query.includes("insert into worker_bootstrap_credentials")) return [{ generation: 1, createdAt: new Date().toISOString(), rotatedAt: null }];
  }, {}) as never;
}
function statefulDb() {
  const state = { keys: new Set<string>(), updates: 0, values: undefined as unknown };
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    if (query.includes("FROM memberships")) return [{ ok: true }];
    if (query.includes("dashboard_mutations")) { const key = String(values[1]); if (state.keys.has(key)) return []; state.keys.add(key); return [{ idempotency_key: key }]; }
    if (query.includes("organization_settings")) { if (query.includes("max_vcpu_per_pod")) { state.updates++; state.values = values; } return [{ organizationId: "org", maxVcpuPerPod: 2, maxMemoryBytesPerPod: 3, maxStorageBytesPerPod: 4, maxConcurrentPods: 5 }]; }
    return [];
  }, {}) as never;
  return { db, state };
}
const member = { id: "u1", githubUserId: 1, login: "member", isGlobalAdmin: false };
const admin = { id: "u2", githubUserId: 2, login: "admin", isGlobalAdmin: true };
function appFor(user = member, db = fakeDb()) { return createControlPlaneApp({ db, baseUrl: "https://x", githubClientId: "id", githubClientSecret: "secret", bootstrapGithubLogin: "admin", githubWebhookSecret: "webhook", requestId: () => "req", requestSource: () => "test", webRoot: new URL("file:///tmp/"), workerInstallerRoot: new URL("file:///tmp/"), onWorkerAdopted: () => {}, currentUser: async () => user }); }
const sessionHeaders = { Cookie: "whitesmith_session=test" };

  test("returns canonical installer URL when enrolling a worker", async () => {
    const response = await appFor(admin).request("/api/workers/enroll", { method: "POST", headers: { ...sessionHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ audience: "macos-arm64", profile: {} }) });
    expect(response.status).toBe(201);
    expect((await response.json()).installer).toBe("https://x/api/workers/installer?audience=macos-arm64");
  });
test("settings idempotency validates presence before malformed body", async () => {
  const setup = statefulDb();
  const missing = await appFor(admin, setup.db).request("/api/organizations/org/settings", { method: "PUT", headers: { ...sessionHeaders, "Content-Type": "application/json" }, body: "{}" });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ code: "missing_idempotency_key" });
  const malformed = await appFor(admin, setup.db).request("/api/organizations/org/settings", { method: "PUT", headers: { ...sessionHeaders, "Content-Type": "application/json", "Idempotency-Key": "key" }, body: "{}" });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ code: "invalid_request" });
  expect(setup.state.keys.size).toBe(0);
  const corrected = await appFor(admin, setup.db).request("/api/organizations/org/settings", { method: "PUT", headers: { ...sessionHeaders, "Content-Type": "application/json", "Idempotency-Key": "key" }, body: JSON.stringify({ maxVcpuPerPod: 2, maxMemoryBytesPerPod: 3, maxStorageBytesPerPod: 4, maxConcurrentPods: 5 }) });
  expect(corrected.status).toBe(200);
  expect(setup.state.keys).toEqual(new Set(["key"]));
  expect(setup.state.updates).toBe(1);
  expect(setup.state.values).toEqual(["org", 2, 3, 4, 5]);
});
describe("dashboard API", () => {
  test("returns the authenticated operator for the dashboard session probe", async () => {
    const response = await appFor().request("/api/me", { headers: sessionHeaders });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(member);
  });
  test("denies foreign organization as not found", async () => {
    const response = await appFor(member, fakeDb([], false)).request("/api/organizations/foreign/overview", { headers: sessionHeaders });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
  test("rejects malformed cursors", async () => {
    const response = await appFor().request("/api/organizations/org/runs?cursor=bad.cursor", { headers: sessionHeaders });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_query" });
  });
  test("uses typed errors and requires idempotency key", async () => {
    const response = await appFor().request("/api/organizations/org/workers/w1/drain", { method: "POST", headers: sessionHeaders });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "missing_idempotency_key", requestId: expect.any(String) });
  });
  test("restricts worker adopt to global administrators", async () => {
    const response = await appFor().request("/api/organizations/org/workers/w1/adopt", { method: "POST", headers: { ...sessionHeaders, "Idempotency-Key": "one" } });
    expect(response.status).toBe(404);
    const adminResponse = await appFor(admin).request("/api/organizations/org/workers/w1/adopt", { method: "POST", headers: { ...sessionHeaders, "Idempotency-Key": "two" } });
    expect(adminResponse.status).toBe(404);
  });
});
