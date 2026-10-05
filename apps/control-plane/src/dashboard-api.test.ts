import { describe, expect, test } from "bun:test";
import { getSession, SecretBox } from "./auth.ts";
import { createControlPlaneApp } from "./http/app.ts";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
function fakeDb(rows: unknown[] = [], memberAllowed = true) {
  return preparedTestDatabase(name => {
    if (name === "route_membership") return memberAllowed ? [{ allowed: 1 }] : [];
    if (name === "dashboard_list_organizations" || name === "dashboard_list_all_organizations") return rows;
    if (name === "dashboard_mutation") return [{ idempotencyKey: "key" }];
    if (name === "worker_bootstrap_initialize") return [{ generation: 1, createdAt: new Date().toISOString(), rotatedAt: null }];
    return [];
  });
}
function discoveryRecheckApiDb(result: "queued" | "not_found" | "not_paused" = "queued") {
  const state = { updates: 0, invalidations: 0 };
  const db = preparedTestDatabase(name => {
    if (name === "route_membership") return [{ allowed: 1 }];
    if (name === "dashboard_repository_recheck_lock") return result === "not_found" ? [] : [{ paused: result !== "not_paused" }];
    if (name === "dashboard_mutation") return [{ idempotencyKey: "recheck" }];
    if (name === "dashboard_repository_recheck_update") state.updates += 1;
    if (name === "dashboard_invalidate") state.invalidations += 1;
    return [];
  });
  return { db, state };
}
const healthWorkerId = "86afd915-add3-407c-a6c1-1b46803ef713";
function workerHealthApiDb(worker: Record<string, unknown> | null = {
  id: healthWorkerId,
  configurationState: "ready",
  connectionState: "offline",
  heartbeatAgeSeconds: 1,
  doctorAgeSeconds: 2,
  lastHeartbeatAt: new Date("2026-08-23T11:59:59.000Z"),
  lastDoctorAt: new Date("2026-08-23T11:59:58.000Z"),
  observedAt: new Date("2026-08-23T12:00:00.000Z"),
  limits: { maxConcurrentPods: 2 },
  doctor: { doctor: { probe: true, containers: [{ containerId: "b".repeat(64), name: "managed", leaseId: "33333333-3333-4333-8333-333333333333", state: "exited", cpuUsagePercent: null, memoryWorkingSetBytes: null, memoryLimitBytes: null, diskUsageBytes: 987654321, sampledAt: "2026-08-23T11:59:00.000Z" }] }, capacity: { actualVcpu: 8, freeVcpu: 6, actualMemoryBytes: "100", freeMemoryBytes: "80", actualStorageBytes: "200", freeStorageBytes: "150" }, credentials: "do-not-return" },
  desiredConfiguration: { cache: { ttlSeconds: 3600 } },
  cacheGeneration: "11111111-1111-4111-8111-111111111111",
  cacheReady: true,
  cacheTtlSeconds: 1800,
  cacheSizeBytes: "1000",
  cacheEntryCount: 12,
  cacheObservedAt: new Date("2026-08-23T11:59:50.000Z"),
  cacheError: null,
}) {
  return preparedTestDatabase(name => { 
  if (name === "dashboard_get_worker_health") return worker ? [worker] : [];
  if (name === "dashboard_worker_health_leases") return [{
    leaseId: "22222222-2222-4222-8222-222222222222",
    jobId: 42,
    repositoryFullName: "acme/project",
    repositoryName: "project",
    state: "busy",
    startedAt: new Date("2026-08-23T11:59:00.000Z"),
    ageSeconds: 60,
    requested: { vcpu: 2, memoryBytes: "10", storageBytes: "20", concurrency: 1 },
    credentials: "do-not-return",
  }]; });
}
const trendRepositoryId = "11111111-1111-4111-8111-111111111111";
const trendJobKey = Buffer.from(JSON.stringify({ repositoryId: trendRepositoryId, workflowName: "CI", jobName: "build" })).toString("base64url");
function trendDb() {
  return preparedTestDatabase(name => {
    if (name === "route_membership") return [{ allowed: 1 }];
    if (name === "resource_trends_totals") return [{ jobCount: 1, completedRunCount: 1, medianExecutionDurationMs: 60_000, telemetryCoveredRunCount: 1 }];
    if (name === "resource_trends_facets") return [{ platforms: ["windows-x64"], vcpus: [2], concurrencies: [1], workers: [] }];
    if (name.startsWith("resource_trends_summary_") || name === "resource_trends_selected") return [{
      repositoryId: trendRepositoryId, repositoryName: "acme/app", workflowName: "CI", jobName: "build",
      platform: "windows-x64", runCount: 1, latestCompletedAt: new Date("2026-09-02T12:00:00.000Z"),
      latestRequestedVcpu: 2, latestRequestedMemoryBytes: 4_294_967_296, latestEffectiveConcurrency: 1,
      medianExecutionDurationMs: 60_000, cpuPeakPercent: 80, memoryPeakBytes: 2_147_483_648,
      telemetryCoveredRunCount: 1, durationChangePercent: null, cpuChangePercent: null, memoryChangePercent: null,
    }];
    if (name === "resource_trends_points") return [{
      organizationId: "org", runId: "run-1", jobId: "job-1", completedAt: new Date("2026-09-02T12:00:00.000Z"),
      outcome: "success", executionDurationMs: 60_000, cpuAveragePercent: 40, cpuPeakPercent: 80,
      memoryPeakBytes: 2_147_483_648, requestedVcpu: 2, requestedMemoryBytes: 4_294_967_296,
      effectiveConcurrency: 1, telemetryState: "available", telemetrySampleCount: 10,
    }];
    return [];
  });
}

const member = { id: "u1", githubUserId: 1, login: "member", isGlobalAdmin: false };
const admin = { id: "u2", githubUserId: 2, login: "admin", isGlobalAdmin: true };
function appFor(user: typeof member | typeof admin | null = member, db = fakeDb()) { return createControlPlaneApp({ db, setup: { publicOrigin: () => "https://x", publicOriginManaged: () => false, configure: async (origin: string) => origin, authenticate: async () => ({ userId: "admin", firstAdmin: true }) }, browserOrigin: () => "https://x", workerConnectionOrigins: () => ["https://x"], githubApp: { getOAuthCredentials: async () => ({ clientId: "id", clientSecret: "secret" }), getWebhookSecret: async () => "webhook" } as never, secretBox: new SecretBox(Buffer.alloc(32, 7).toString("base64")), defaultJobImages: {}, requestId: () => "req", requestSource: () => "test", webRoot: new URL("file:///tmp/"), workerInstallerRoot: new URL("file:///tmp/"), workerOrchestratorExecutable: new URL("file:///tmp/mars-orchestrator"), workerConnected: () => true, onWorkerChanged: () => undefined, currentUser: async () => user, health: () => ({ buildId: "test", startedAt: new Date().toISOString(), discovery: { lastAttemptAt: null, lastSuccessAt: null, stale: false, staleAfterMs: 60000 } }) }); }
const sessionHeaders = { Cookie: "mars_session=test" };

test.each(["runner=unknown", "from=not-a-date", "from=2026-10-04", "limit=0"])("run history rejects invalid filters: %s", async (query) => {
  const response = await appFor(member).request(`/api/organizations/all/runs?${query}`, { headers: sessionHeaders });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_query" });
});

test("worker configuration endpoints reject missing required fields with a client error", async () => {
  for (const path of ["/api/workers/11111111-1111-4111-8111-111111111111/configure", "/api/workers/pending/11111111-1111-4111-8111-111111111111/configure"]) {
    const response = await appFor(admin).request(path, {
      method: "POST",
      headers: { ...sessionHeaders, "Content-Type": "application/json", "Idempotency-Key": "invalid-configuration" },
      body: JSON.stringify({ guestPlatforms: ["windows-x64"], selectedDriver: "windows-hyperv-container" }),
    });
    expect(response.status).toBe(400);
  }
});

test("session lookup normalizes PostgreSQL bigint GitHub IDs", async () => {
  const db = preparedTestDatabase(name => name === "auth_get_session" ? [{ id: "user-1", githubUserId: "153311365", login: "admin", isGlobalAdmin: true }] : [])
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
  test("accepts opaque job timing cursors", async () => {
    const cursor = Buffer.from("2026-09-03T12:00:00.000Z").toString("base64url");
    const db = preparedTestDatabase(name => name === "route_membership" ? [{ ok: true }] : []);
    const response = await appFor(member, db).request(`/api/organizations/org/job-timings?cursor=${cursor}`, { headers: sessionHeaders });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { items: [], nextCursor: null } });
  });
  test("returns validated job resource trends to organization members", async () => {
    const response = await appFor(member, trendDb()).request(
      "/api/organizations/org/job-resource-trends?from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z&sort=memory&limit=50&pointLimit=100",
      { headers: sessionHeaders },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ summary: { jobCount: 1 }, jobs: [{ jobName: "build" }] });
  });
  test("accepts Unix-second trend bounds", async () => {
    const response = await appFor(member, trendDb()).request(
      "/api/organizations/org/job-resource-trends?from=1787788800&to=1788393600",
      { headers: sessionHeaders },
    );
    expect(response.status).toBe(200);
  });
  test("supports all-organization trend scope", async () => {
    const response = await appFor(member, trendDb()).request(
      "/api/organizations/all/job-resource-trends?from=1787788800&to=1788393600",
      { headers: sessionHeaders },
    );
    expect(response.status).toBe(200);
  });
  test("rejects invalid trend bounds and hides foreign organizations", async () => {
    const invalid = await appFor().request("/api/organizations/org/job-resource-trends?from=nope", { headers: sessionHeaders });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_resource_trend_query" });
    const foreign = await appFor(member, fakeDb([], false)).request(
      "/api/organizations/foreign/job-resource-trends?from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z",
      { headers: sessionHeaders },
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ code: "not_found" });
  });
  test("strictly validates job resource trend query parameters", async () => {
    const invalidQueries = [
      "from=2026-09-03T00:00:00.000Z&to=2026-09-03T00:00:00.000Z",
      "from=2026-09-03T00:00:00.000Z&to=2026-09-02T00:00:00.000Z",
      "from=2026-06-04T23:59:59.999Z&to=2026-09-03T00:00:00.000Z",
      "from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z&limit=101",
      "from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z&pointLimit=1",
      "from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z&pointLimit=201",
      "from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z&sort=disk",
      "from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z&unexpected=true",
    ];
    for (const query of invalidQueries) {
      const response = await appFor(member, trendDb()).request(`/api/organizations/org/job-resource-trends?${query}`, { headers: sessionHeaders });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_resource_trend_query" });
    }
  });
  test("uses the static trend sorts and validates opaque cursors and keys through the database codec", async () => {
    const base = "from=2026-08-27T00:00:00.000Z&to=2026-09-03T00:00:00.000Z";
    for (const sort of ["latest", "duration", "cpu", "memory", "runs"]) {
      const sortValue = sort === "latest" ? "2026-09-02T12:00:00.000Z" : 1;
      const cursor = Buffer.from(JSON.stringify({ sortValue, jobKey: trendJobKey })).toString("base64url");
      const response = await appFor(member, trendDb()).request(
        `/api/organizations/org/job-resource-trends?${base}&sort=${sort}&cursor=${cursor}&jobKey=${trendJobKey}`,
        { headers: sessionHeaders },
      );
      expect(response.status).toBe(200);
    }
    for (const parameter of ["cursor", "jobKey"]) {
      const invalidOpaqueValue = Buffer.from("not-json").toString("base64url");
      const response = await appFor(member, trendDb()).request(
        `/api/organizations/org/job-resource-trends?${base}&${parameter}=${invalidOpaqueValue}`,
        { headers: sessionHeaders },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_resource_trend_query" });
    }
  });
  test("requires global administrator access for worker mutations", async () => {
    const response = await appFor().request("/api/organizations/org/workers/w1/drain", { method: "POST", headers: sessionHeaders });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden", requestId: expect.any(String) });
    const adminResponse = await appFor(admin).request("/api/organizations/org/workers/w1/adopt", { method: "POST", headers: { ...sessionHeaders, "Idempotency-Key": "two" } });
    expect(adminResponse.status).toBe(404);
  });
  test("renames an adopted worker to a trimmed friendly name", async () => {
    const workerId = "86afd915-add3-407c-a6c1-1b46803ef713";
    const row = {
      id: workerId,
      name: "BUILD-HOST",
      platform: "macos-arm64",
      releaseVersion: "0.1.0",
      contractVersion: "0.1.0",
      guestPlatforms: ["macos-arm64"],
      admissionState: "adopted",
      connectionState: "online",
      configurationState: "ready",
      fingerprint: "sha256:worker",
      limits: null,
      doctor: { doctor: { runtimeMode: "tart" }, capacity: { actualVcpu: 4, actualMemoryBytes: 8, actualStorageBytes: 10, freeVcpu: 4, freeMemoryBytes: 8, freeStorageBytes: 10 } },
      draining: false,
      preserveLeases: false,
      activeSandboxes: 0,
    };
    const db = preparedTestDatabase((name, parameters) => {
          if (name === "dashboard_list_all_workers") return [row];
          if (name === "workers_rename") { row.name = String(parameters.name); return [{ id: workerId }]; }
          return [];
        });
    const response = await appFor(admin, db).request(`/api/organizations/all/workers/${workerId}/name`, {
      method: "POST",
      headers: { ...sessionHeaders, "Content-Type": "application/json", "Idempotency-Key": "rename-1" },
      body: JSON.stringify({ name: "  Friendly Builder  " }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: workerId, name: "Friendly Builder" });
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
  });
});
test("global admins can create the control-plane default pool without an organization", async () => {
  const db = preparedTestDatabase(name => { 
  if (name === "route_pool_worker") return [{ platform: "macos-arm64", guestPlatforms: ["macos-arm64"], desiredConfiguration: { selectedDriver: "tart-vm" }, doctor: { capabilities: [{ driver: "tart-vm", guestPlatform: "macos-arm64", imageDigest: `macos-arm64@sha256:${"a".repeat(64)}`, ready: true, remediation: null }] }, admissionState: "adopted", connectionState: "online", configurationState: "ready", configurationRevision: "a", appliedConfigurationRevision: "a", lastDoctorAt: new Date().toISOString(), draining: false, limits: { maxVcpuPerPod: 4, maxMemoryBytes: 8, maxStorageBytes: 20, maxConcurrentPods: 2 } }];
  if (name === "route_global_pool_create") return [{ id: "00000000-0000-4000-8000-000000000003" }];
  if (name === "dashboard_mutation") return [{ idempotency_key: "global-pool" }];
  return []; });
  const response = await appFor(admin, db).request("/api/pools", {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json", "Idempotency-Key": "global-pool" },
    body: JSON.stringify({ workerId: "00000000-0000-4000-8000-000000000004", guestPlatform: "macos-arm64", cpuMode: "shared", name: "default", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, triggerLabel: "mars-macos-arm64", imageDigest: `macos-arm64@sha256:${"a".repeat(64)}` }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ labels: ["mars-macos-arm64"] });
});
test("global pool creation rejects duplicate names and labels", async () => {
  const db = preparedTestDatabase(name => { 
  if (name === "route_pool_worker") return [{ platform: "macos-arm64", guestPlatforms: ["macos-arm64"], desiredConfiguration: { selectedDriver: "tart-vm" }, doctor: { capabilities: [{ driver: "tart-vm", guestPlatform: "macos-arm64", imageDigest: `macos-arm64@sha256:${"a".repeat(64)}`, ready: true, remediation: null }] }, admissionState: "adopted", connectionState: "online", configurationState: "ready", configurationRevision: "a", appliedConfigurationRevision: "a", lastDoctorAt: new Date().toISOString(), draining: false }];
  if (name === "route_global_pool_duplicate") return [{ id: "00000000-0000-4000-8000-000000000003", name: "macos-smoke", triggerLabel: "mars-macos" }];
  return []; });
  const response = await appFor(admin, db).request("/api/pools", {
    method: "POST",
    headers: { ...sessionHeaders, "Content-Type": "application/json", "Idempotency-Key": "repair-global-pool" },
    body: JSON.stringify({ workerId: "00000000-0000-4000-8000-000000000004", guestPlatform: "macos-arm64", cpuMode: "shared", name: "macos-smoke", resources: { vcpu: 4, memoryBytes: 8_589_934_592, storageBytes: 85_899_345_920, concurrency: 1 }, triggerLabel: "mars-macos", imageDigest: `macos-arm64@sha256:${"a".repeat(64)}` }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "pool_conflict" });
});
test("global admins can list the control-plane pool without selecting a workspace", async () => {
  const db = preparedTestDatabase(name => { if (name === "dashboard_list_global_pools") return [{ id: "pool-1", organizationId: null, workerId: null, workerName: "Shared fleet", name: "default", platform: "macos-arm64", driver: "tart-vm", imageDigest: `macos@sha256:${"a".repeat(64)}`, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, cpuMode: "shared", labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64", enabled: true, active: 0 }];
  return []; });
  const response = await appFor(admin, db).request("/api/pools", { headers: sessionHeaders });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ name: "default", workerName: "Shared fleet" }] });
});
test("global admins can page worker cache inventory with an opaque cursor", async () => {
  const db = preparedTestDatabase(name => { if (name === "worker_cache_listing") return [{ entryId: "33333333-3333-4333-8333-333333333333", githubRepositoryId: "123", repositoryFullName: "Acme/Repo", cacheKeyPreview: "build-linux", cacheKeyHash: "a".repeat(64), scopePreview: "refs/heads/main", scopeHash: "b".repeat(64), versionHash: "c".repeat(64), sizeBytes: "10", createdAt: "2026-08-23T12:00:00.000Z", lastAccessedAt: "2026-08-23T12:01:00.000Z", expiresAt: "2026-08-25T12:01:00.000Z" }];
  return []; });
  const response = await appFor(admin, db).request("/api/workers/11111111-1111-4111-8111-111111111111/cache?limit=1&query=BUILD", { headers: sessionHeaders });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ repositoryUrl: "https://github.com/Acme/Repo", githubRepositoryId: "123" }], nextCursor: null });
});
test("worker cache inventory rejects malformed opaque cursors", async () => {
  const response = await appFor(admin).request("/api/workers/11111111-1111-4111-8111-111111111111/cache?cursor=%%%25", { headers: sessionHeaders });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_cache_cursor" });
});
test("worker health requires authentication", async () => {
  const response = await appFor(null, workerHealthApiDb()).request(`/api/workers/${healthWorkerId}/health`);
  expect(response.status).toBe(401);
});

test("worker health requires global administrator authorization", async () => {
  const response = await appFor(member, workerHealthApiDb()).request(`/api/workers/${healthWorkerId}/health`, { headers: sessionHeaders });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "forbidden" });
});

test("worker health returns a no-store not-found error for unknown workers", async () => {
  const response = await appFor(admin, workerHealthApiDb(null)).request(`/api/workers/${healthWorkerId}/health`, { headers: sessionHeaders });
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ code: "not_found" });
});

test("global admins receive strict no-store worker health without secrets", async () => {
  const response = await appFor(admin, workerHealthApiDb()).request(`/api/workers/${healthWorkerId}/health?configuration=1`, { headers: sessionHeaders });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toEqual({
    observedAt: "2026-08-23T12:00:00.000Z",
    runtimeMode: null,
    configuration: { state: "ready", failureReason: null },
    connection: {
      state: "online",
      lastHeartbeatAt: "2026-08-23T11:59:59.000Z",
      lastDoctorAt: "2026-08-23T11:59:58.000Z",
      heartbeatAgeSeconds: 1,
      doctorAgeSeconds: 2,
    },
    usage: {
      cpu: { actual: 8, reserved: 2, free: 6 },
      memoryBytes: { actual: "100", reserved: "10", free: "80" },
      storageBytes: { actual: "200", reserved: "20", free: "150" },
      pods: { actual: 2, reserved: 1, free: 1 },
    },
    cache: {
      desiredTtlSeconds: 3600,
      effectiveTtlSeconds: 1800,
      effectiveRunnerCacheEnabled: null,
      effectiveRunnerCacheMaxGiB: null,
      ready: true,
      generation: "11111111-1111-4111-8111-111111111111",
      sizeBytes: "1000",
      entryCount: 12,
      runnerCacheSizeBytes: null,
      runnerCacheEntryCount: null,
      observedAt: "2026-08-23T11:59:50.000Z",
      runnerCacheObservedAt: null,
      error: null,
    },
    containers: [{
      containerId: "b".repeat(64),
      name: "managed",
      leaseId: "33333333-3333-4333-8333-333333333333",
      state: "exited",
      cpuUsagePercent: null,
      memoryWorkingSetBytes: null,
      memoryLimitBytes: null,
      diskUsageBytes: "987654321",
      sampledAt: "2026-08-23T11:59:00.000Z",
    }],
    jobs: [{
      jobId: 42,
      repositoryFullName: "acme/project",
      repositoryName: "project",
      leaseId: "22222222-2222-4222-8222-222222222222",
      state: "busy",
      startedAt: "2026-08-23T11:59:00.000Z",
      sample: null,
      ageSeconds: 60,
      requested: { vcpu: 2, memoryBytes: "10", storageBytes: "20", concurrency: 1 },
    }],
  });
  expect(JSON.stringify(body)).not.toContain("do-not-return");
});

test("worker health preserves the legacy response shape for older dashboards", async () => {
  const app = appFor(admin, workerHealthApiDb());
  const legacy = await app.request(`/api/workers/${healthWorkerId}/health`, { headers: sessionHeaders });
  const expanded = await app.request(`/api/workers/${healthWorkerId}/health?configuration=1`, { headers: sessionHeaders });
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get("cache-control")).toBe("no-store");
  const { configuration, ...originalShape } = await expanded.json();
  expect(configuration).toEqual({ state: "ready", failureReason: null });
  expect(await legacy.json()).toEqual(originalShape);
});
