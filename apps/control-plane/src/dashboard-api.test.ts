import { describe, expect, test } from "bun:test";
import { getSession, SecretBox } from "./auth.ts";
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
function discoveryRecheckApiDb(result: "queued" | "not_found" | "not_paused" = "queued") {
  const state = { updates: 0, invalidations: 0, queries: [] as string[] };
  const sql = Object.assign(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    state.queries.push(query);
    if (query.includes("FROM memberships")) return [{ ok: true }];
    if (query.includes("FROM dashboard_repositories r")) return result === "not_found" ? [] : [{ paused: result !== "not_paused" }];
    if (query.includes("SELECT 1 FROM dashboard_mutations")) return [];
    if (query.includes("INSERT INTO dashboard_mutations")) return [{ idempotency_key: "recheck" }];
    if (query.includes("SET discovery_retry_at=now()")) state.updates += 1;
    if (query.includes("dashboard_outbox_invalidations")) state.invalidations += 1;
    return [];
  }, {
    begin: async (transaction: (tx: unknown) => Promise<unknown>) => transaction(sql),
  }) as never;
  return { db: sql, state };
}
const member = { id: "u1", githubUserId: 1, login: "member", isGlobalAdmin: false };
const admin = { id: "u2", githubUserId: 2, login: "admin", isGlobalAdmin: true };
function appFor(user = member, db = fakeDb()) { return createControlPlaneApp({ db, baseUrl: "https://x", browserBaseUrl: "https://x", githubClientId: "id", githubClientSecret: "secret", bootstrapGithubLogin: "admin", secretBox: new SecretBox(Buffer.alloc(32, 7).toString("base64")), defaultJobImages: {}, githubWebhookSecret: "webhook", requestId: () => "req", requestSource: () => "test", webRoot: new URL("file:///tmp/"), workerInstallerRoot: new URL("file:///tmp/"), workerOrchestratorExecutable: new URL("file:///tmp/whitesmith-orchestrator"), onWorkerAdopted: () => {}, health: () => ({ buildId: "test-build", startedAt: "2026-08-13T00:00:00.000Z", discovery: { lastAttemptAt: null, lastSuccessAt: null, stale: false, staleAfterMs: 60_000 } }), currentUser: async () => user }); }
const sessionHeaders = { Cookie: "whitesmith_session=test" };

test("session lookup normalizes PostgreSQL bigint GitHub IDs", async () => {
  const db = (async () => [{ id: "user-1", githubUserId: "153311365", login: "admin", isGlobalAdmin: true }]) as never;
  expect(await getSession(db, Buffer.alloc(32, 1).toString("base64url"))).toEqual({
    id: "user-1",
    githubUserId: 153311365,
    login: "admin",
    isGlobalAdmin: true,
  });
});
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
  test("forwards repository cursors to the database query", async () => {
    const cursor = "11111111-1111-4111-8111-111111111111";
    const values: unknown[] = [];
    const db = (async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      if (strings.join(" ").includes("FROM memberships")) return [{ ok: true }];
      values.push(...parameters);
      return [];
    }) as never;
    const response = await appFor(member, db).request(`/api/organizations/org/repositories?cursor=${cursor}`, { headers: sessionHeaders });
    expect(response.status).toBe(200);
    expect(values).toContain(cursor);
  });
  test("requires global administrator access for worker mutations", async () => {
    const response = await appFor().request("/api/organizations/org/workers/w1/drain", { method: "POST", headers: sessionHeaders });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden", requestId: expect.any(String) });
    const adminResponse = await appFor(admin).request("/api/organizations/org/workers/w1/adopt", { method: "POST", headers: { ...sessionHeaders, "Idempotency-Key": "two" } });
    expect(adminResponse.status).toBe(404);
  });
});

describe("repository discovery recheck", () => {
  const path = "/api/organizations/11111111-1111-4111-8111-111111111111/repositories/22222222-2222-4222-8222-222222222222/discovery/recheck";

  test("requires global administrator authorization", async () => {
    const response = await appFor(member, discoveryRecheckApiDb().db).request(path, {
      method: "POST",
      headers: { ...sessionHeaders, "Idempotency-Key": "recheck-1" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  test("requires an idempotency key", async () => {
    const response = await appFor(admin, discoveryRecheckApiDb().db).request(path, { method: "POST", headers: sessionHeaders });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "missing_idempotency_key" });
  });

  test("queues a paused repository without calling GitHub", async () => {
    const setup = discoveryRecheckApiDb();
    const response = await appFor(admin, setup.db).request(path, {
      method: "POST",
      headers: { ...sessionHeaders, "Idempotency-Key": "recheck-1" },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: true });
    expect(setup.state.updates).toBe(1);
    expect(setup.state.invalidations).toBe(1);
    expect(setup.state.queries.some((query) => query.toLowerCase().includes("github.com") || query.includes("actions/runs"))).toBe(false);
  });

  test.each([
    ["not_found", 404, "not_found"],
    ["not_paused", 409, "repository_discovery_not_paused"],
  ] as const)("maps %s repository state to HTTP %i", async (result, status, code) => {
    const setup = discoveryRecheckApiDb(result);
    const response = await appFor(admin, setup.db).request(path, {
      method: "POST",
      headers: { ...sessionHeaders, "Idempotency-Key": `recheck-${result}` },
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(setup.state.queries.some((query) => query.includes("FROM dashboard_repositories r"))).toBe(true);
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
    body: JSON.stringify({ workerId: "00000000-0000-4000-8000-000000000004", name: "default", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, triggerLabel: "whitesmith-macos-arm64", imageDigest: `macos@sha256:${"a".repeat(64)}` }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ labels: ["whitesmith-macos-arm64"] });
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
