import { describe, expect, test } from "bun:test";
import { SecretBox } from "./auth.ts";
import { createControlPlaneApp } from "./http/app.ts";
function fakeDb(rows: unknown[] = [], memberAllowed = true) {
  return Object.assign(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("FROM memberships")) return memberAllowed ? [{ ok: true }] : [];
    if (query.includes("FROM organizations")) return rows;
    if (query.includes("dashboard_mutations")) return [{ idempotency_key: "key" }];
    if (query.includes("organization_settings")) return [{ organizationId: "org", maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }];
    if (query.includes("FROM workers")) return [];
    if (query.includes("worker_bootstrap_credentials") && query.includes("select generation")) return [];
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
function appFor(user = member, db = fakeDb()) { return createControlPlaneApp({ db, baseUrl: "https://x", githubClientId: "id", githubClientSecret: "secret", bootstrapGithubLogin: "admin", secretBox: new SecretBox(Buffer.alloc(32, 7).toString("base64")), defaultJobImages: {}, githubWebhookSecret: "webhook", requestId: () => "req", requestSource: () => "test", webRoot: new URL("file:///tmp/"), workerInstallerRoot: new URL("file:///tmp/"), workerOrchestratorExecutable: new URL("file:///tmp/whitesmith-orchestrator"), onWorkerAdopted: () => {}, currentUser: async () => user }); }
const sessionHeaders = { Cookie: "whitesmith_session=test" };
test("authenticated global admins can read worker bootstrap status", async () => {
  const response = await appFor(admin).request("/api/workers/bootstrap", { headers: sessionHeaders });
  expect(await response.json()).toMatchObject({ initialized: false, generation: null, createdAt: null, rotatedAt: null });
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
  test("requires global administrator access for worker mutations", async () => {
    const response = await appFor().request("/api/organizations/org/workers/w1/drain", { method: "POST", headers: sessionHeaders });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden", requestId: expect.any(String) });
    const adminResponse = await appFor(admin).request("/api/organizations/org/workers/w1/adopt", { method: "POST", headers: { ...sessionHeaders, "Idempotency-Key": "two" } });
    expect(adminResponse.status).toBe(404);
  });
});
test("global admins can create the control-plane default pool without an organization", async () => {
  const queries: string[] = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("FROM workers")) return [{ platform: "macos-arm64", admissionState: "adopted", connectionState: "online", configurationState: "ready", draining: false, limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8, maxStorageBytesPerPod: 20, maxConcurrentPods: 2 } }];
    if (query.includes("runner_pools") && query.includes("RETURNING id")) return [{ id: "00000000-0000-4000-8000-000000000003" }];
    if (query.includes("dashboard_mutations")) return [{ idempotency_key: "global-pool" }];
    return [];
  }, {}) as never;
  const response = await appFor(admin, db).request("/api/pools", {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json", "Idempotency-Key": "global-pool" },
    body: JSON.stringify({ workerId: "00000000-0000-4000-8000-000000000004", name: "default", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, triggerLabel: "whitesmith-macos", imageDigest: `macos@sha256:${"a".repeat(64)}` }),
  });
  expect(response.status).toBe(200);
  expect(queries.some((query) => query.includes("INSERT INTO runner_pools"))).toBe(true);
});
test("global pool creation converges a matching legacy pool to shared capacity", async () => {
  const queries: string[] = [];
  const db = Object.assign(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("FROM workers")) return [{ platform: "macos-arm64", admissionState: "adopted", connectionState: "online", configurationState: "ready", draining: false }];
    if (query.includes("FROM runner_pools")) return [{ id: "00000000-0000-4000-8000-000000000003", name: "macos-smoke", triggerLabel: "whitesmith-macos" }];
    if (query.includes("UPDATE runner_pools")) return [{ id: "00000000-0000-4000-8000-000000000003" }];
    return [];
  }, {}) as never;
  const response = await appFor(admin, db).request("/api/pools", {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json", "Idempotency-Key": "repair-global-pool" },
    body: JSON.stringify({ workerId: "00000000-0000-4000-8000-000000000004", name: "macos-smoke", resources: { vcpu: 4, memoryBytes: 8_589_934_592, storageBytes: 85_899_345_920, concurrency: 1 }, triggerLabel: "whitesmith-macos", imageDigest: `whitesmith-macos-job@sha256:${"a".repeat(64)}` }),
  });
  expect(response.status).toBe(200);
  expect(queries.some((query) => query.includes("UPDATE runner_pools") && query.includes("worker_id=NULL"))).toBe(true);
  expect(queries.some((query) => query.includes("INSERT INTO runner_pools"))).toBe(false);
});
test("global admins can list the control-plane pool without selecting a workspace", async () => {
  const db = Object.assign(async (strings: TemplateStringsArray) => {
    if (strings.join(" ").includes("runner_pools")) return [{ id: "pool-1", organizationId: null, workerId: null, workerName: "Shared fleet", name: "default", platform: "macos-arm64", driver: "tart-vm", imageDigest: `macos@sha256:${"a".repeat(64)}`, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, labels: ["self-hosted", "macos", "arm64", "whitesmith-macos"], triggerLabel: "whitesmith-macos", enabled: true, active: 0 }];
    return [];
  }, {}) as never;
  const response = await appFor(admin, db).request("/api/pools", { headers: sessionHeaders });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ name: "default", workerName: "Shared fleet" }] });
});
