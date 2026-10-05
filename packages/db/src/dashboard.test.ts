import { expect, test } from "bun:test";
import { LogChunk, OverviewDto, RepositorySummary, RunDetail, RunSummary, WorkerDetail, WorkerHealth } from "@mars/contracts";
import { getAllOverview, getOverview, getRunDetail, getWorkerDetail, getWorkerHealth, listAllRepositories, listAllRuns, listAllPools, listAllWorkers, listRepositories, listRuns, listWorkers, listPools, listLogChunks, listStepLogChunks, queueRepositoryDiscoveryRecheck, type DashboardDb } from "./dashboard.ts";
import { preparedTestDatabase } from "./prepared-test-fixture.ts";

function dashboardDb(responses: Record<string, unknown>) {
  return preparedTestDatabase((name) => responses[name] ?? responses.__default ?? []);
}

test("overview uses active runner leases for the load numerator", async () => {
  const db = dashboardDb({
    dashboard_overview: [{ organizationId: "org-1", period: "24h", queued: 1, running: 2, completed: 3, failed: 4, queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0, concurrency: 10 }],
    dashboard_overview_queue_reasons: [{ code: "run_not_dispatchable", count: 1 }],
    dashboard_overview_timeseries: [{ bucket: new Date("2026-08-12T10:00:00.000Z"), pending: 2, running: 1 }],
    dashboard_overview_timeseries_current: [],
    dashboard_overview_job_outcomes: [],
    dashboard_overview_running_containers: [{ id: "lease-1", organizationId: "org-1", jobId: "job-1", runId: "run-1", jobName: "build", repositoryName: "acme/project", workflowName: "CI", workerName: "worker-1", runtime: "windows-hyperv-container", startedAt: new Date("2026-08-17T20:00:00.000Z"), cpuUsagePercent: 42.5, memoryWorkingSetBytes: 2_147_483_648, memoryLimitBytes: 4_294_967_296, diskUsageBytes: null, allocatedStorageBytes: 10_737_418_240, sampledAt: new Date("2026-08-17T20:05:00.000Z") }],
    github_runner_cost_savings: [],
  });
  const result = await getOverview(db, "org-1", "24h");
  expect(OverviewDto.parse(result)).toMatchObject({ running: 2, concurrency: 10, queueReasons: [{ code: "run_not_dispatchable", count: 1 }], utilization: { pods: 0.2 }, timeseries: [{ bucket: "2026-08-12T10:00:00.000Z", pending: 2, running: 1 }], runningContainers: [{ organizationId: "org-1", jobName: "build", cpuUsagePercent: 42.5 }] });
});
test("aggregate overview preserves each running container organization", async () => {
  const db = dashboardDb({
    dashboard_all_overview: [{ organizationId: "all", period: "24h", queued: 0, running: 1, completed: 0, failed: 0, queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0, concurrency: 1 }],
    dashboard_overview_queue_reasons: [{ code: "eligible", count: 1 }],
    dashboard_overview_running_containers: [{ id: "lease-1", organizationId: "org-2", jobId: "job-1", runId: "run-1", jobName: "build", repositoryName: "acme/project", workflowName: "CI", workerName: "worker-1", runtime: "windows-hyperv-container", startedAt: new Date("2026-08-17T20:00:00.000Z"), cpuUsagePercent: 42.5, memoryWorkingSetBytes: 2_147_483_648, memoryLimitBytes: 4_294_967_296, diskUsageBytes: null, allocatedStorageBytes: 10_737_418_240, sampledAt: new Date("2026-08-17T20:05:00.000Z") }],
    dashboard_overview_timeseries: [],
    dashboard_overview_timeseries_current: [],
    dashboard_overview_job_outcomes: [],
    github_runner_cost_savings: [],
  });
  const result = await getAllOverview(db, "user-1", "24h");
  expect(OverviewDto.parse(result).runningContainers).toEqual([expect.objectContaining({ organizationId: "org-2" })]);
});
test("overview outcomes aggregate platform counts", async () => {
  const db = dashboardDb({
    dashboard_overview: [{ organizationId: "org-1", period: "24h", queued: 1, running: 0, completed: 0, failed: 0, queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0, concurrency: 0 }],
    dashboard_overview_queue_reasons: [],
    dashboard_overview_timeseries: [],
    dashboard_overview_timeseries_current: [],
    dashboard_overview_job_outcomes: [{ outcome: "queued", platform: "other", count: 1 }],
    dashboard_overview_running_containers: [],
    github_runner_cost_savings: [],
  });
  const result = await getOverview(db, "org-1", "24h");
  expect(result.jobOutcomes.find((outcome) => outcome.outcome === "queued")?.platforms.other).toBe(1);
});

test("worker listing drops malformed persisted timestamps", async () => {
  const db = dashboardDb({ dashboard_list_workers: [{ id: "86afd915-add3-407c-a6c1-1b46803ef713", organizationId: "c432f22a-16e4-44f8-9a6b-bc00e5de1a7d", name: "mac-worker", platform: "macos-arm64", driver: "tart-vm", admissionState: "adopted", connectionState: "online", configurationState: "ready", configurationAppliedAt: "", lastHeartbeatAt: "not-a-date", lastDoctorAt: "0000-00-00", fingerprint: "sha256:worker", limits: "{\"maxVcpuPerPod\":2,\"maxMemoryBytesPerPod\":3221225472,\"maxStorageBytesPerPod\":10737418240,\"maxConcurrentPods\":1}", doctor: { doctor: { probe: true, egress: true }, capacity: { freeVcpu: 10, actualVcpu: 10, freeMemoryBytes: 16149077032, actualMemoryBytes: 34359738368, freeStorageBytes: 103244165120, actualStorageBytes: 994610155520 } }, activeSandboxes: 0, draining: false }] });
  const page = await listWorkers(db, "c432f22a-16e4-44f8-9a6b-bc00e5de1a7d");
  expect(page.items[0]).toMatchObject({ configurationAppliedAt: null, lastHeartbeatAt: null, lastDoctorAt: null });
  expect(() => WorkerDetail.parse(page.items[0])).not.toThrow();
});

test("worker listings expose desired and applied configuration metadata", async () => {
  const worker = { id: "worker-1", organizationId: null, name: "worker", platform: "linux-x64", releaseVersion: null, contractVersion: null, guestPlatforms: ["linux-x64"], admissionState: "adopted", connectionState: "offline", configurationState: "ready", configurationRevision: "desired-rev", appliedConfigurationRevision: "applied-rev", configurationAppliedAt: new Date("2026-01-01T00:00:00Z"), lastHeartbeatAt: null, lastDoctorAt: null, fingerprint: "sha256:worker", limits: null, doctor: null, desiredConfiguration: {}, preserveLeases: false, activeSandboxes: 0, draining: false };
  const db = dashboardDb({ dashboard_list_workers: [worker], dashboard_list_all_workers: [worker] });
  expect((await listWorkers(db, "org-1")).items[0]).toMatchObject({ configurationRevision: "desired-rev", appliedConfigurationRevision: "applied-rev", configurationAppliedAt: "2026-01-01T00:00:00.000Z" });
  expect((await listAllWorkers(db, "user-1")).items[0]).toMatchObject({ configurationRevision: "desired-rev", appliedConfigurationRevision: "applied-rev", configurationAppliedAt: "2026-01-01T00:00:00.000Z" });
});

test("worker health projects complete cache and active lease telemetry", async () => {
  const workerId = "86afd915-add3-407c-a6c1-1b46803ef713";
  const cacheGeneration = "11111111-1111-4111-8111-111111111111";
  const leases = [
    { leaseId: "22222222-2222-4222-8222-222222222222", jobId: 42, repositoryFullName: "acme/project", repositoryName: "project", state: "busy", startedAt: new Date("2026-08-23T11:59:00.000Z"), ageSeconds: 60, requested: { vcpu: 2, memoryBytes: "100000000000000000000", storageBytes: "200000000000000000000", concurrency: 1 }, sampleCpuUsagePercent: "37.5", sampleMemoryWorkingSetBytes: "1073741824", sampleMemoryLimitBytes: "10737418240", sampleDiskUsageBytes: "2147483648", sampledAt: new Date("2026-08-23T11:59:50.000Z") },
    { leaseId: "33333333-3333-4333-8333-333333333333", jobId: null, repositoryFullName: null, repositoryName: null, state: "online", startedAt: null, ageSeconds: null, requested: { vcpu: 1, memoryBytes: "300", storageBytes: "400", concurrency: 1 } },
    { leaseId: "44444444-4444-4444-8444-444444444444", jobId: 43, repositoryFullName: null, repositoryName: null, state: "provisioning", startedAt: new Date("2026-08-23T11:58:00.000Z"), ageSeconds: 120, requested: { vcpu: 1, memoryBytes: "500", storageBytes: "600", concurrency: 1 } },
    { leaseId: "55555555-5555-4555-8555-555555555555", jobId: 44, repositoryFullName: "acme/other", repositoryName: "other", state: "reserved", startedAt: new Date("2026-08-23T11:57:00.000Z"), ageSeconds: 180, requested: { vcpu: 0.5, memoryBytes: "700", storageBytes: "800", concurrency: 1 } },
  ];
  const db = workerHealthDb({
    worker: {
      configurationState: "ready",
      heartbeatAgeSeconds: 1,
      doctorAgeSeconds: 2,
      connectionState: "offline",
      lastHeartbeatAt: new Date("2026-08-23T11:59:59.000Z"),
      lastDoctorAt: new Date("2026-08-23T11:59:58.000Z"),
      observedAt: new Date("2026-08-23T12:00:00.000Z"),
      desiredConfiguration: { cache: { ttlSeconds: 3600 } },
      limits: { maxConcurrentPods: 8 },
      doctor: { doctor: { probe: true }, capacity: { actualVcpu: 16, freeVcpu: 10, actualMemoryBytes: "100000000000000000000", freeMemoryBytes: "99999999999999999900", actualStorageBytes: "300000000000000000000", freeStorageBytes: "299999999999999999000" } },
      cacheGeneration,
      cacheReady: true,
      cacheTtlSeconds: 1800,
      cacheSizeBytes: "100000000000000000000",
      cacheEntryCount: 12,
      cacheObservedAt: new Date("2026-08-23T11:59:50.000Z"),
      runnerCacheEnabled: true,
      runnerCacheMaxGiB: 20,
      runnerCacheSizeBytes: "300000000000000000000",
      runnerCacheEntryCount: 34,
      runnerCacheObservedAt: new Date("2026-08-23T11:59:51.000Z"),
      cacheError: null,
    },
    leases,
  });

  const health = await getWorkerHealth(db, workerId, () => true);

  expect(health).not.toBeNull();
  expect(() => WorkerHealth.parse(health)).not.toThrow();
  expect(health).toMatchObject({
    observedAt: "2026-08-23T12:00:00.000Z",
    connection: { state: "online", heartbeatAgeSeconds: 1, doctorAgeSeconds: 2 },
    usage: {
      cpu: { actual: 16, reserved: 4.5, free: 10 },
      pods: { actual: 8, reserved: 4, free: 4 },
      memoryBytes: { actual: "100000000000000000000", reserved: "100000000000000001500", free: "99999999999999999900" },
      storageBytes: { actual: "300000000000000000000", reserved: "200000000000000001800", free: "299999999999999999000" },
    },
    cache: { desiredTtlSeconds: 3600, effectiveTtlSeconds: 1800, effectiveRunnerCacheEnabled: true, effectiveRunnerCacheMaxGiB: 20, generation: cacheGeneration, sizeBytes: "100000000000000000000", entryCount: 12, runnerCacheSizeBytes: "300000000000000000000", runnerCacheEntryCount: 34, runnerCacheObservedAt: "2026-08-23T11:59:51.000Z" },
  });
  expect(health?.jobs).toEqual(expect.arrayContaining([
    expect.objectContaining({ jobId: 42, repositoryFullName: "acme/project", repositoryName: "project", ageSeconds: 60, sample: { cpuUsagePercent: 37.5, memoryWorkingSetBytes: "1073741824", memoryLimitBytes: "10737418240", diskUsageBytes: "2147483648", sampledAt: "2026-08-23T11:59:50.000Z" } }),
    expect.objectContaining({ jobId: null, repositoryFullName: null, repositoryName: null, ageSeconds: null, sample: null }),
  ]));
  expect(health?.jobs).toHaveLength(4);
});
test("worker health projects valid latest container observations and skips invalid legacy rows", async () => {
  const worker = minimalWorkerHealthRow({
    doctor: {
      doctor: {
        probe: true,
        containers: [
          {
            containerId: "b".repeat(64),
            name: "zulu",
            leaseId: "22222222-2222-4222-8222-222222222222",
            state: "exited",
            cpuUsagePercent: null,
            memoryWorkingSetBytes: null,
            memoryLimitBytes: null,
            diskUsageBytes: 987654321,
            sampledAt: "2026-08-23T11:59:00.000Z",
          },
          {
            containerId: "a".repeat(64),
            name: "alpha",
            leaseId: "33333333-3333-4333-8333-333333333333",
            state: "running",
            cpuUsagePercent: 12.3,
            memoryWorkingSetBytes: 9007199254740991,
            memoryLimitBytes: 9007199254740991,
            diskUsageBytes: null,
            sampledAt: "2026-08-23T11:59:01.000Z",
          },
          {
            containerId: "c".repeat(64),
            name: "invalid-state",
            leaseId: "44444444-4444-4444-8444-444444444444",
            state: "bogus",
            cpuUsagePercent: null,
            memoryWorkingSetBytes: null,
            memoryLimitBytes: null,
            diskUsageBytes: null,
            sampledAt: "2026-08-23T11:59:02.000Z",
          },
        ],
      },
      capacity: { actualVcpu: 1, freeVcpu: 1, actualMemoryBytes: "1", freeMemoryBytes: "1", actualStorageBytes: "1", freeStorageBytes: "1" },
    },
  });
  const db = workerHealthDb({ worker, leases: [] });

  const health = await getWorkerHealth(db, worker.id, () => true);

  expect(health?.containers).toEqual([
    {
      containerId: "a".repeat(64),
      name: "alpha",
      leaseId: "33333333-3333-4333-8333-333333333333",
      state: "running",
      cpuUsagePercent: 12.3,
      memoryWorkingSetBytes: "9007199254740991",
      memoryLimitBytes: "9007199254740991",
      diskUsageBytes: null,
      sampledAt: "2026-08-23T11:59:01.000Z",
    },
    {
      containerId: "b".repeat(64),
      name: "zulu",
      leaseId: "22222222-2222-4222-8222-222222222222",
      state: "exited",
      cpuUsagePercent: null,
      memoryWorkingSetBytes: null,
      memoryLimitBytes: null,
      diskUsageBytes: "987654321",
      sampledAt: "2026-08-23T11:59:00.000Z",
    },
  ]);
});

test("worker health defaults missing legacy container inventory to an empty array", async () => {
  const worker = minimalWorkerHealthRow();
  const health = await getWorkerHealth(workerHealthDb({ worker, leases: [] }), worker.id, () => true);
  expect(health?.containers).toEqual([]);
});


test("worker health connection state uses the live connection callback", async () => {
  const worker = minimalWorkerHealthRow({ connectionState: "online" });
  const db = workerHealthDb({ worker, leases: [] });
  expect((await getWorkerHealth(db, worker.id, () => false))?.connection.state).toBe("offline");
  expect((await getWorkerHealth(db, worker.id, () => true))?.connection.state).toBe("online");
});

test("worker health excludes terminal leases and clamps negative ages", async () => {
  const worker = minimalWorkerHealthRow();
  const leases = [{ leaseId: "22222222-2222-4222-8222-222222222222", jobId: null, repositoryFullName: null, repositoryName: null, state: "busy", startedAt: new Date("2026-08-23T12:01:00.000Z"), ageSeconds: 0, requested: { vcpu: 1, memoryBytes: "1", storageBytes: "1", concurrency: 1 } }];
  const db = workerHealthDb({ worker, leases });
  const health = await getWorkerHealth(db, worker.id, () => true);
  expect(health?.jobs).toHaveLength(1);
  expect(health?.jobs[0]?.ageSeconds).toBe(0);
});

test("worker health returns null for a missing worker", async () => {
  const db = workerHealthDb({ worker: null, leases: [] });
  expect(await getWorkerHealth(db, "86afd915-add3-407c-a6c1-1b46803ef713", () => true)).toBeNull();
});

test("worker health preserves exact large decimal byte strings", async () => {
  const worker = minimalWorkerHealthRow({
    doctor: { doctor: { probe: true }, capacity: { actualVcpu: 2, freeVcpu: 1, actualMemoryBytes: "900719925474099300000", freeMemoryBytes: "900719925474099299999", actualStorageBytes: "900719925474099400000", freeStorageBytes: "900719925474099399999" } },
  });
  const db = workerHealthDb({
    worker,
    leases: [{ leaseId: "22222222-2222-4222-8222-222222222222", jobId: null, repositoryFullName: null, repositoryName: null, state: "busy", startedAt: null, ageSeconds: null, requested: { vcpu: 1, memoryBytes: "900719925474099200000", storageBytes: "900719925474099100000", concurrency: 1 } }],
  });
  const health = await getWorkerHealth(db, worker.id, () => true);
  expect(health?.usage.memoryBytes).toEqual({ actual: "900719925474099300000", reserved: "900719925474099200000", free: "900719925474099299999" });
  expect(health?.jobs[0]?.requested.memoryBytes).toBe("900719925474099200000");
});

test("worker health tolerates missing cache telemetry while retaining desired TTL", async () => {
  const db = workerHealthDb({ worker: minimalWorkerHealthRow({ desiredConfiguration: { cache: { ttlSeconds: 7200 } } }), leases: [] });
  const health = await getWorkerHealth(db, "86afd915-add3-407c-a6c1-1b46803ef713", () => true);
  expect(health?.cache).toEqual({ desiredTtlSeconds: 7200, effectiveTtlSeconds: null, effectiveRunnerCacheEnabled: null, effectiveRunnerCacheMaxGiB: null, ready: false, generation: null, sizeBytes: null, entryCount: null, runnerCacheSizeBytes: null, runnerCacheEntryCount: null, observedAt: null, runnerCacheObservedAt: null, error: null });
});

test("worker health exposes the current configuration failure and clears it after recovery", async () => {
  const failed = minimalWorkerHealthRow({ configurationState: "error", configurationFailureReason: "Docker image download failed" });
  const recovered = minimalWorkerHealthRow({ configurationState: "ready", configurationFailureReason: null });
  expect((await getWorkerHealth(workerHealthDb({ worker: failed, leases: [] }), failed.id, () => true))?.configuration)
    .toEqual({ state: "error", failureReason: "Docker image download failed" });
  expect((await getWorkerHealth(workerHealthDb({ worker: recovered, leases: [] }), recovered.id, () => true))?.configuration)
    .toEqual({ state: "ready", failureReason: null });
});

function minimalWorkerHealthRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "86afd915-add3-407c-a6c1-1b46803ef713",
    configurationState: "ready",
    connectionState: "offline",
    heartbeatAgeSeconds: null,
    doctorAgeSeconds: null,
    lastHeartbeatAt: new Date("2026-08-23T12:00:00.000Z"),
    lastDoctorAt: null,
    observedAt: new Date("2026-08-23T12:00:00.000Z"),
    limits: { maxConcurrentPods: 1 },
    doctor: { doctor: { probe: true }, capacity: { actualVcpu: 1, freeVcpu: 1, actualMemoryBytes: "1", freeMemoryBytes: "1", actualStorageBytes: "1", freeStorageBytes: "1" } },
    desiredConfiguration: { cache: { ttlSeconds: 172800 } },
    cacheGeneration: null,
    cacheReady: false,
    cacheTtlSeconds: null,
    cacheSizeBytes: null,
    cacheEntryCount: null,
    cacheObservedAt: null,
    runnerCacheEnabled: null,
    runnerCacheMaxGiB: null,
    runnerCacheSizeBytes: null,
    runnerCacheEntryCount: null,
    runnerCacheObservedAt: null,
    cacheError: null,
    ...overrides,
  };
}

function workerHealthDb(options: { worker: Record<string, unknown> | null; leases: Record<string, unknown>[] }): DashboardDb {
  return dashboardDb({
    dashboard_get_worker_health: options.worker ? [options.worker] : [],
    dashboard_worker_health_leases: options.leases,
  });
}

test("pool listing normalizes PostgreSQL JSONB resources and labels", async () => {
  const db = dashboardDb({ dashboard_list_pools: [{ id: "pool-1", organizationId: "org-1", workerId: "worker-1", workerName: "worker", name: "default", platform: "linux-x64", driver: "linux-libvirt-vm", imageDigest: "ubuntu@sha256:" + "a".repeat(64), resources: "{\"vcpu\":2,\"memoryBytes\":4294967296,\"storageBytes\":10737418240,\"concurrency\":1}", cpuMode: "shared", labels: "[\"self-hosted\",\"linux\",\"x64\",\"mars-default\"]", triggerLabel: "mars-default", enabled: true, active: "0" }] });
  const page = await listPools(db, "org-1");
  expect(page.items[0].resources.memoryBytes).toBe(4294967296);
  expect(page.items[0].labels).toEqual(["self-hosted", "linux", "x64", "mars-default"]);
});

test("repository listings normalize active paused and queued discovery states", async () => {
  const future = new Date("2026-08-15T12:00:00.000Z");
  const past = new Date("2026-08-14T12:00:00.000Z");
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const rows = [
    { id: "22222222-2222-4222-8222-222222222221", organizationId, name: "active", fullName: "acme/active", visibility: "public", available: true, installationId: "33333333-3333-4333-8333-333333333331", discoveryState: "active", discoveryRetryAt: null },
    { id: "22222222-2222-4222-8222-222222222222", organizationId, name: "paused", fullName: "acme/paused", visibility: "private", available: true, installationId: "33333333-3333-4333-8333-333333333332", discoveryState: "paused", discoveryRetryAt: future },
    { id: "22222222-2222-4222-8222-222222222223", organizationId, name: "queued", fullName: "acme/queued", visibility: "internal", available: true, installationId: "33333333-3333-4333-8333-333333333333", discoveryState: "queued", discoveryRetryAt: past },
  ];
  const db = dashboardDb({ dashboard_list_repositories: rows, dashboard_list_all_repositories: rows });
  const scoped = await listRepositories(db, organizationId);
  const all = await listAllRepositories(db, "user-1");
  expect(scoped.items.map((item) => RepositorySummary.parse(item).discoveryState)).toEqual(["active", "paused", "queued"]);
  expect(all.items[1]?.discoveryRetryAt).toBe(future.toISOString());
});

test("repository listings continue after the requested cursor", async () => {
  const cursor = "11111111-1111-4111-8111-111111111111";
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    organizationId: "33333333-3333-4333-8333-333333333333",
    name: `repo-${index}`,
    fullName: `SpeedHQ/repo-${index}`,
    visibility: "private",
    available: true,
    installationId: "44444444-4444-4444-8444-444444444444",
    discoveryState: "active",
    discoveryRetryAt: null,
  }));

  const db = dashboardDb({ dashboard_list_all_repositories: rows });
  const page = await listAllRepositories(db, "user-1", 2, cursor);
  expect(page.items).toHaveLength(2);
  expect(page.nextCursor).toBe(rows[1]!.id);
});

test("run listing normalizes PostgreSQL bigint and timestamp values", async () => {
  const db = dashboardDb({ dashboard_list_runs: [{
    id: "run-1",
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryName: "repo",
    runNumber: "42",
    workflowName: "ci",
    event: "push",
    branch: "main",
    commitSha: "abcdef1",
    actorLogin: "acme",
    status: "completed",
    conclusion: "success",
    queuedAt: new Date("2026-08-13T10:00:00.000Z"),
    startedAt: new Date("2026-08-13T10:00:01.000Z"),
    completedAt: new Date("2026-08-13T10:00:02.000Z"),
    durationMs: "1000",
    runtimeBoundary: null,
  }] });
  const run = (await listRuns(db, "org-1")).items[0];
  expect(() => RunSummary.parse(run)).not.toThrow();
  expect(run).toMatchObject({
    runNumber: 42,
    queuedAt: "2026-08-13T10:00:00.000Z",
    startedAt: "2026-08-13T10:00:01.000Z",
    completedAt: "2026-08-13T10:00:02.000Z",
    durationMs: 1000,
  });
});

test("run listing distinguishes jobs without a Mars pool label", async () => {
  const db = dashboardDb({ dashboard_list_runs: [{ id: "run-1", allocationState: "external", runNumber: 1, queuedAt: new Date("2026-08-15T04:00:00Z"), startedAt: null, completedAt: null, durationMs: 0, status: "queued" }] });
  const item = (await listRuns(db, "org-1")).items[0];
  expect(item.allocationState).toBe("external");
});

test("run listing derives runtime from run timestamps when duration is unset", async () => {
  const db = dashboardDb({ dashboard_list_runs: [{
    id: "run-1",
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryName: "repo",
    runNumber: "42",
    workflowName: "ci",
    event: "push",
    branch: "main",
    commitSha: "abcdef1",
    actorLogin: "acme",
    status: "completed",
    conclusion: "success",
    queuedAt: new Date("2026-08-13T10:00:00.000Z"),
    startedAt: new Date("2026-08-13T10:00:01.000Z"),
    completedAt: new Date("2026-08-13T10:01:01.000Z"),
    durationMs: "0",
    runtimeBoundary: null,
  }] });
  expect((await listRuns(db, "org-1")).items[0].durationMs).toBe(60_000);
});
test("run detail returns complete jobs and ordered steps", async () => {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const repositoryId = "22222222-2222-4222-8222-222222222222";
  const runId = "33333333-3333-4333-8333-333333333333";
  const jobId = "44444444-4444-4444-8444-444444444444";
  const dependentJobId = "66666666-6666-4666-8666-666666666666";
  const stepId = "55555555-5555-4555-8555-555555555555";
  const timestamp = new Date("2026-08-13T10:00:00.000Z");
  const jobRows = [
    { id: jobId, name: "build", status: "completed", conclusion: "success", stage: "completed", runnerName: "runner", logsState: "pending", requestedLabels: ["self-hosted", "windows", "x64"], queuedAt: timestamp, startedAt: new Date("2026-08-13T10:00:01.000Z"), completedAt: new Date("2026-08-13T10:00:02.000Z"), requested: { vcpu: 2, memoryBytes: 4_294_967_296, storageBytes: 10_737_418_240, concurrency: 1 }, observed: null },
    { id: dependentJobId, name: "test", status: "completed", conclusion: "success", stage: "completed", runnerName: "runner", logsState: "ingested", requestedLabels: ["self-hosted", "windows", "x64"], queuedAt: timestamp, startedAt: new Date("2026-08-13T10:00:02.000Z"), completedAt: new Date("2026-08-13T10:00:04.000Z"), requested: { vcpu: 2, memoryBytes: 4_294_967_296, storageBytes: 10_737_418_240, concurrency: 1 }, observed: null },
  ];
  const db = dashboardDb({
    dashboard_list_runs: [{ id: runId, organizationId, repositoryId, repositoryName: "repo", runNumber: "42", workflowName: "ci", event: "push", branch: "main", commitSha: "abcdef1", actorLogin: "acme", status: "completed", conclusion: "success", queuedAt: timestamp, startedAt: new Date("2026-08-13T10:00:01.000Z"), completedAt: new Date("2026-08-13T10:00:02.000Z"), durationMs: "1000", runtimeBoundary: null, allocationState: "external" }],
    dashboard_run_detail_jobs: jobRows,
    dashboard_run_detail_steps: [{ id: stepId, jobId, name: "test", number: 1, status: "completed", conclusion: "success", queuedAt: timestamp, startedAt: new Date("2026-08-13T10:00:01.000Z"), completedAt: new Date("2026-08-13T10:00:02.000Z"), durationMs: "1000" }],
    dashboard_run_detail_edges: [{ from: jobId, to: dependentJobId }],
    dashboard_run_detail_stages: [],
  });

  const detail = await getRunDetail(db, organizationId, runId);
  expect(() => RunDetail.parse(detail)).not.toThrow();
  expect(detail?.jobs[0]).toMatchObject({
    logsState: "pending",
    requestedLabels: ["self-hosted", "windows", "x64"],
    steps: [{ id: stepId, number: 1, durationMs: 1000, startedAt: "2026-08-13T10:00:01.000Z" }],
  });
  expect(detail?.actionGraph.edges).toEqual([{ from: jobId, to: dependentJobId }]);
  expect(detail?.actionGraph.nodes[0]).toMatchObject({ conclusion: "success", durationMs: 1000 });
});
test("run detail assembles current-attempt job and graph data", async () => {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const runId = "33333333-3333-4333-8333-333333333333";
  const currentJobId = "55555555-5555-4555-8555-555555555555";
  const currentStepId = "66666666-6666-4666-8666-666666666666";
  const current = { id: currentJobId, name: "Build", status: "completed", conclusion: "success", stage: "completed", runnerName: "runner", logsState: "pending", requested: { vcpu: 2, memoryBytes: 4_294_967_296, storageBytes: 10_737_418_240, concurrency: 1 }, requestedLabels: ["self-hosted"], observed: null, queuedAt: new Date("2026-08-13T10:00:00.000Z"), startedAt: new Date("2026-08-13T10:00:01.000Z"), completedAt: new Date("2026-08-13T10:00:02.000Z") };
  const db = dashboardDb({
    dashboard_list_runs: [{ id: runId, organizationId, repositoryId: "22222222-2222-4222-8222-222222222222", repositoryName: "repo", runNumber: "42", workflowName: "ci", event: "push", branch: "main", commitSha: "abcdef1", actorLogin: "acme", status: "completed", conclusion: "success", queuedAt: new Date("2026-08-13T10:00:00.000Z"), startedAt: new Date("2026-08-13T10:00:01.000Z"), completedAt: new Date("2026-08-13T10:00:02.000Z"), durationMs: "1000", runtimeBoundary: null, allocationState: "external" }],
    dashboard_run_detail_jobs: [current],
    dashboard_run_detail_steps: [{ id: currentStepId, jobId: currentJobId, name: "run", number: 1, status: "completed", conclusion: "success", queuedAt: new Date("2026-08-13T10:00:00.000Z"), startedAt: new Date("2026-08-13T10:00:01.000Z"), completedAt: new Date("2026-08-13T10:00:02.000Z"), durationMs: "1000" }],
    dashboard_run_detail_edges: [],
    dashboard_run_detail_stages: [],
  });

  const detail = await getRunDetail(db, organizationId, runId);
  expect(detail?.jobs.map(({ id }) => id)).toEqual([currentJobId]);
  expect(detail?.jobs[0]?.steps.map(({ id }) => id)).toEqual([currentStepId]);
  expect(detail?.actionGraph.nodes.map(({ id }) => id)).toEqual([currentJobId]);
  expect(detail?.actionGraph.edges).toEqual([]);
});



test("log listings normalize PostgreSQL bigint sequences and timestamps", async () => {
  const logChunk = { organizationId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", jobId: "33333333-3333-4333-8333-333333333333", sequence: "0", content: "output", hasMore: false, occurredAt: new Date("2026-08-13T00:00:00.000Z") };
  const db = dashboardDb({ dashboard_log_chunks: [logChunk], dashboard_step_log_chunks: [logChunk] });
  const job = await listLogChunks(db, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333");
  const step = await listStepLogChunks(db, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444");
  expect(LogChunk.parse(job.items[0])).toMatchObject({ sequence: 0, occurredAt: "2026-08-13T00:00:00.000Z" });
  expect(LogChunk.parse(step.items[0])).toMatchObject({ sequence: 0, occurredAt: "2026-08-13T00:00:00.000Z" });
});


test("all-workspace worker listing hides rejected workers by default", async () => {
  expect(await listAllWorkers(dashboardDb({ dashboard_list_all_workers: [] }), "user-1")).toEqual({ items: [], nextCursor: null });
});

test("all-workspace worker listing includes workers across organizations", async () => {
  const workers = [{ id: "w-1", organizationId: null, name: "linux-one", platform: "linux-x64", admissionState: "adopted", connectionState: "online", configurationState: "ready", fingerprint: "sha256:one", limits: null, doctor: null, activeSandboxes: 0, draining: false }, { id: "w-2", organizationId: null, name: "mac-two", platform: "macos-arm64", admissionState: "pending", connectionState: "offline", configurationState: "unconfigured", fingerprint: "sha256:two", limits: null, doctor: null, activeSandboxes: 0, draining: false }];
  expect((await listAllWorkers(dashboardDb({ dashboard_list_all_workers: workers }), "user-1")).items.map((worker) => worker.id)).toEqual(["w-1", "w-2"]);
});

test("global worker detail finds a fleet worker without an organization", async () => {
  const worker = { id: "worker-1", name: "arm-worker", platform: "windows-x64", admissionState: "adopted", connectionState: "online", configurationState: "unconfigured", fingerprint: "abc", limits: null, doctor: null, activeSandboxes: 0, draining: false };
  const db = dashboardDb({ dashboard_list_all_workers: [worker], dashboard_list_workers: [] });
  expect(await getWorkerDetail(db, "all", worker.id)).toMatchObject({ id: worker.id, name: worker.name });
  expect(await getWorkerDetail(db, "11111111-1111-4111-8111-111111111111", worker.id)).toBeNull();
});

test("all-workspace listings preserve tenant membership and workspace IDs", async () => {
  const repository = { id: "repo-1", organizationId: "org-1", name: "repo", fullName: "acme/repo", visibility: "private", available: false, installationId: "install-1", discoveryState: "active" };
  const run = { id: "run-1", organizationId: "org-1", repositoryId: "repo-1", repositoryName: "repo", runNumber: 1, workflowName: "ci", event: "push", branch: "main", commitSha: "abcdef1", actorLogin: "acme", status: "completed", conclusion: "success", queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0, runtimeBoundary: null, allocationState: "external" };
  const pool = { id: "pool-1", organizationId: "org-1", workerId: "worker-1", workerName: "worker", name: "default", platform: "linux-x64", driver: "linux-libvirt-vm", imageDigest: "ubuntu@sha256:" + "a".repeat(64), resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, cpuMode: "shared", labels: ["self-hosted"], triggerLabel: "mars", enabled: true, active: 0 };
  const db = dashboardDb({ dashboard_list_all_repositories: [repository], dashboard_list_all_runs: [run], dashboard_list_all_pools: [pool] });
  expect((await listAllRepositories(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1", available: false });
  expect((await listAllRuns(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1" });
  expect((await listAllPools(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1" });
});

const discoveryOrganizationId = "11111111-1111-4111-8111-111111111111";
const discoveryRepositoryId = "22222222-2222-4222-8222-222222222222";

function discoveryRecheckDb(options: { paused?: boolean; missing?: boolean } = {}) {
  const state = { paused: options.paused ?? true, keys: new Set<string>(), updates: 0 };
  const db = preparedTestDatabase((name, parameters) => {
    if (name === "dashboard_repository_recheck_lock") return options.missing ? [] : [{ paused: state.paused }];
    if (name === "dashboard_repository_recheck_prior") return state.keys.has(String(parameters.key)) ? [{ idempotencyKey: parameters.key }] : [];
    if (name === "dashboard_mutation") {
      const key = String(parameters.key);
      if (state.keys.has(key)) return [];
      state.keys.add(key);
      return [{ idempotencyKey: key }];
    }
    if (name === "dashboard_repository_recheck_update") {
      state.updates += 1;
      state.paused = false;
    }
    return [];
  });
  return { db, state };
}

test("queues one paused repository discovery recheck", async () => {
  const setup = discoveryRecheckDb();
  expect(await queueRepositoryDiscoveryRecheck(setup.db, discoveryOrganizationId, discoveryRepositoryId, "retry-1")).toBe("queued");
  expect(setup.state.updates).toBe(1);
  expect(setup.state.keys).toEqual(new Set([`repository-discovery-recheck:${discoveryRepositoryId}:retry-1`]));
});

test("converges an idempotent repository discovery replay", async () => {
  const setup = discoveryRecheckDb();
  await queueRepositoryDiscoveryRecheck(setup.db, discoveryOrganizationId, discoveryRepositoryId, "retry-1");
  expect(await queueRepositoryDiscoveryRecheck(setup.db, discoveryOrganizationId, discoveryRepositoryId, "retry-1")).toBe("queued");
  expect(setup.state.updates).toBe(1);
});

test("rejects an active repository without consuming the idempotency key", async () => {
  const setup = discoveryRecheckDb({ paused: false });
  expect(await queueRepositoryDiscoveryRecheck(setup.db, discoveryOrganizationId, discoveryRepositoryId, "retry-active")).toBe("not_paused");
  expect(setup.state.keys.size).toBe(0);
});

test("rejects a missing repository without consuming the idempotency key", async () => {
  const setup = discoveryRecheckDb({ missing: true });
  expect(await queueRepositoryDiscoveryRecheck(setup.db, discoveryOrganizationId, discoveryRepositoryId, "retry-missing")).toBe("not_found");
  expect(setup.state.keys.size).toBe(0);
});
