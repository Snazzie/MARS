import { expect, test } from "bun:test";
import { LogChunk, OverviewDto, RepositorySummary, RunDetail, RunSummary, WorkerDetail } from "@whitesmith/contracts";
import { getOverview, getOrganizationSettings, getRunDetail, listAllRepositories, listAllRuns, listAllPools, listAllWorkers, listRepositories, listRuns, listWorkers, listPools, listLogChunks, listStepLogChunks, queueRepositoryDiscoveryRecheck } from "./dashboard.ts";

test("overview counts only GitHub job status and runtime leases", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("SELECT l.id")) return [{ id: "lease-1", jobId: "job-1", jobName: "build", repositoryName: "acme/project", workflowName: "CI", workerName: "worker-1", runtime: "windows-hyperv-container", startedAt: new Date("2026-08-17T20:00:00.000Z"), cpuUsagePercent: 42.5, memoryWorkingSetBytes: 2_147_483_648, memoryLimitBytes: 4_294_967_296, diskUsageBytes: null, allocatedStorageBytes: 10_737_418_240, sampledAt: new Date("2026-08-17T20:05:00.000Z") }];
    if (query.includes("generate_series")) return [{ bucket: new Date("2026-08-12T10:00:00.000Z"), pending: 2, running: 1 }];
    return [{
      organizationId: "org-1",
      period: "24h",
      queued: 1,
      running: 2,
      completed: 3,
      failed: 4,
      queueP50Ms: 0,
      queueP95Ms: 0,
      durationP50Ms: 0,
      durationP95Ms: 0,
      concurrency: 2,
      utilization: 0,
    }];
  }) as never;
  const result = await getOverview(db, "org-1", "24h");
  expect(OverviewDto.parse(result)).toMatchObject({ running: 2, utilization: { pods: 1 }, timeseries: [{ bucket: "2026-08-12T10:00:00.000Z", pending: 2, running: 1 }], runningContainers: [{ jobName: "build", cpuUsagePercent: 42.5 }] });
  expect(queries.some((query) => query.includes("l.state IN ('sandbox_ready','online','busy')") && query.includes("j.status='in_progress'"))).toBe(true);
  expect(queries.some((query) => query.includes("count(*) FILTER (WHERE j.status='queued')") && query.includes("count(*) FILTER (WHERE j.status='in_progress')"))).toBe(true);
});
test("overview outcome aggregation guards malformed scalar runner labels", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("SELECT l.id")) return [];
    queries.push(query);
    if (query.includes("generate_series")) return [];
    if (query.includes("GROUP BY outcome, platform")) return [{ outcome: "queued", platform: "other", count: 1 }];
    return [{ organizationId: "org-1", period: "24h", queued: 1, running: 0, completed: 0, failed: 0, queueP50Ms: 0, queueP95Ms: 0, durationP50Ms: 0, durationP95Ms: 0, concurrency: 0, utilization: 0 }];
  }) as never;
  const result = await getOverview(db, "org-1", "24h");
  expect(queries.some((query) => query.includes("jsonb_typeof(requested_labels)='array'"))).toBe(true);
  expect(result.jobOutcomes.find((outcome) => outcome.outcome === "queued")?.platforms.other).toBe(1);
});

test("worker listing drops malformed persisted timestamps", async () => {
  const db = (async () => [{ id: "86afd915-add3-407c-a6c1-1b46803ef713", organizationId: "c432f22a-16e4-44f8-9a6b-bc00e5de1a7d", name: "mac-worker", platform: "macos-arm64", driver: "tart-vm", admissionState: "adopted", connectionState: "online", configurationState: "ready", configurationAppliedAt: "", lastHeartbeatAt: "not-a-date", lastDoctorAt: "0000-00-00", fingerprint: "sha256:worker", limits: "{\"maxVcpuPerPod\":2,\"maxMemoryBytesPerPod\":3221225472,\"maxStorageBytesPerPod\":10737418240,\"maxConcurrentPods\":1}", doctor: { doctor: { probe: true, egress: true }, capacity: { freeVcpu: 10, actualVcpu: 10, freeMemoryBytes: 16149077032, actualMemoryBytes: 34359738368, freeStorageBytes: 103244165120, actualStorageBytes: 994610155520 } }, activeSandboxes: 0, draining: false }]) as never;
  const page = await listWorkers(db, "c432f22a-16e4-44f8-9a6b-bc00e5de1a7d");
  expect(page.items[0]).toMatchObject({ configurationAppliedAt: null, lastHeartbeatAt: null, lastDoctorAt: null });
  expect(() => WorkerDetail.parse(page.items[0])).not.toThrow();
});

test("worker listings expose desired and applied configuration metadata", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [];
  }) as never;
  await listWorkers(db, "org-1");
  await listAllWorkers(db, "user-1");
  expect(queries).toHaveLength(2);
  for (const query of queries) {
    expect(query).toContain('configuration_revision AS "configurationRevision"');
    expect(query).toContain('applied_configuration_revision AS "appliedConfigurationRevision"');
    expect(query).toContain('configuration_applied_at AS "configurationAppliedAt"');
  }
});

test("pool listing normalizes PostgreSQL JSONB resources and labels", async () => {
  const db = (async () => [{ id: "pool-1", organizationId: "org-1", workerId: "worker-1", workerName: "worker", name: "default", platform: "linux-x64", driver: "kata-k3s", imageDigest: "ubuntu@sha256:" + "a".repeat(64), resources: "{\"vcpu\":2,\"memoryBytes\":4294967296,\"storageBytes\":10737418240,\"concurrency\":1}", labels: "[\"self-hosted\",\"linux\",\"x64\",\"whitesmith-default\"]", triggerLabel: "whitesmith-default", enabled: true, active: "0" }]) as never;
  const page = await listPools(db, "org-1");
  expect(page.items[0].resources.memoryBytes).toBe(4294967296);
  expect(page.items[0].labels).toEqual(["self-hosted", "linux", "x64", "whitesmith-default"]);
});

test("repository listings normalize active paused and queued discovery states", async () => {
  const future = new Date("2026-08-15T12:00:00.000Z");
  const past = new Date("2026-08-14T12:00:00.000Z");
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const queries: string[] = [];
  const rows = [
    { id: "22222222-2222-4222-8222-222222222221", organizationId, name: "active", fullName: "acme/active", visibility: "public", available: true, installationId: "33333333-3333-4333-8333-333333333331", discoveryState: "active", discoveryRetryAt: null },
    { id: "22222222-2222-4222-8222-222222222222", organizationId, name: "paused", fullName: "acme/paused", visibility: "private", available: true, installationId: "33333333-3333-4333-8333-333333333332", discoveryState: "paused", discoveryRetryAt: future },
    { id: "22222222-2222-4222-8222-222222222223", organizationId, name: "queued", fullName: "acme/queued", visibility: "internal", available: true, installationId: "33333333-3333-4333-8333-333333333333", discoveryState: "queued", discoveryRetryAt: past },
  ];
  const db = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return rows;
  }) as never;

  const scoped = await listRepositories(db, organizationId);
  const all = await listAllRepositories(db, "user-1");

  expect(scoped.items.map((item) => RepositorySummary.parse(item).discoveryState)).toEqual(["active", "paused", "queued"]);
  expect(all.items[1]?.discoveryRetryAt).toBe(future.toISOString());
  expect(queries.every((query) => query.includes("discovery_retry_at") && query.includes('"discoveryState"'))).toBe(true);
});

test("repository listings continue after the requested cursor", async () => {
  const cursor = "11111111-1111-4111-8111-111111111111";
  let query = "";
  let values: unknown[] = [];
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
  const db = (async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    query = strings.join(" ");
    values = parameters;
    return rows;
  }) as never;

  const page = await listAllRepositories(db, "user-1", 2, cursor);

  expect(query).toContain("cursor.full_name");
  expect(values).toContain(cursor);
  expect(page.items).toHaveLength(2);
  expect(page.nextCursor).toBe(rows[1]!.id);
});

test("run listing normalizes PostgreSQL bigint and timestamp values", async () => {
  const db = (async () => [{
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
  }]) as never;
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

test("run listing distinguishes jobs without a Whitesmith pool label", async () => {
  let query = "";
  const db = (async (strings: TemplateStringsArray) => {
    query = strings.join(" ");
    return [{ id: "run-1", allocationState: "external", runNumber: 1, queuedAt: new Date("2026-08-15T04:00:00Z"), startedAt: null, completedAt: null, durationMs: 0, status: "queued" }];
  }) as never;

  const item = (await listRuns(db, "org-1")).items[0];

  expect(query).toContain("lower(allocation_label) LIKE 'whitesmith-%'");
  expect(item.allocationState).toBe("external");
});

test("run listing derives runtime from run timestamps when duration is unset", async () => {
  const db = (async () => [{
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
  }]) as never;
  expect((await listRuns(db, "org-1")).items[0].durationMs).toBe(60_000);
});
test("run detail returns complete jobs and ordered steps", async () => {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const repositoryId = "22222222-2222-4222-8222-222222222222";
  const runId = "33333333-3333-4333-8333-333333333333";
  const jobId = "44444444-4444-4444-8444-444444444444";
  const stepId = "55555555-5555-4555-8555-555555555555";
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("FROM dashboard_jobs WHERE")) {
      return [{
        id: jobId,
        name: "build",
        status: "completed",
        conclusion: "success",
        stage: "completed",
        runnerName: "runner",
        requested: { vcpu: 2, memoryBytes: 4_294_967_296, storageBytes: 10_737_418_240, concurrency: 1 },
        observed: null,
        ...(query.includes('logs_state AS "logsState"') ? { logsState: "pending", requestedLabels: ["self-hosted", "windows", "x64"] } : {}),
      }];
    }
    if (query.includes("FROM dashboard_job_steps")) {
      return [{ id: stepId, jobId, name: "test", number: 1, status: "completed", conclusion: "success", queuedAt: new Date("2026-08-13T10:00:00.000Z"), startedAt: new Date("2026-08-13T10:00:01.000Z"), completedAt: new Date("2026-08-13T10:00:02.000Z"), durationMs: "1000" }];
    }
    if (query.includes("dashboard_action_edges")) return [];
    if (query.includes("dashboard_run_stages")) return [];
    return [{ id: runId, organizationId, repositoryId, repositoryName: "repo", runNumber: "42", workflowName: "ci", event: "push", branch: "main", commitSha: "abcdef1", actorLogin: "acme", status: "completed", conclusion: "success", queuedAt: new Date("2026-08-13T10:00:00.000Z"), startedAt: new Date("2026-08-13T10:00:01.000Z"), completedAt: new Date("2026-08-13T10:00:02.000Z"), durationMs: "1000", runtimeBoundary: null }];
  }) as never;

  const detail = await getRunDetail(db, organizationId, runId);
  expect(() => RunDetail.parse(detail)).not.toThrow();
  expect(detail?.jobs[0]).toMatchObject({
    logsState: "pending",
    requestedLabels: ["self-hosted", "windows", "x64"],
    steps: [{ id: stepId, number: 1, durationMs: 1000, startedAt: "2026-08-13T10:00:01.000Z" }],
  });
  expect(queries.some((query) => query.includes("dashboard_action_edges"))).toBe(false);
});


test("log listings normalize PostgreSQL bigint sequences", async () => {
  const db = (async () => [{ organizationId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222", jobId: "33333333-3333-4333-8333-333333333333", sequence: "0", content: "output", hasMore: false, occurredAt: "2026-08-13T00:00:00.000Z" }]) as never;
  const job = await listLogChunks(db, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333");
  const step = await listStepLogChunks(db, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444");
  expect(LogChunk.parse(job.items[0]).sequence).toBe(0);
  expect(LogChunk.parse(step.items[0]).sequence).toBe(0);
});

test("organization settings convert PostgreSQL numeric values to numbers", async () => {
  const db = (async () => [{ organizationId: "org-1", maxVcpuPerPod: "4", maxMemoryBytesPerPod: "8589934592", maxStorageBytesPerPod: "107374182400", maxConcurrentPods: "2" }]) as never;
  expect(await getOrganizationSettings(db, "org-1")).toEqual({ organizationId: "org-1", maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8589934592, maxStorageBytesPerPod: 107374182400, maxConcurrentPods: 2 });
});

test("all-workspace worker listing includes workers across organizations", async () => {
  const db = (async () => [{ id: "w-1", organizationId: "org-1", name: "linux-one", platform: "linux-x64", admissionState: "adopted", connectionState: "online", configurationState: "ready", fingerprint: "sha256:one", limits: null, doctor: null, activeSandboxes: 0, draining: false }, { id: "w-2", organizationId: "org-2", name: "mac-two", platform: "macos-arm64", admissionState: "pending", connectionState: "offline", configurationState: "unconfigured", fingerprint: "sha256:two", limits: null, doctor: null, activeSandboxes: 0, draining: false }]) as never;
  expect((await listAllWorkers(db, "user-1")).items.map((worker) => worker.organizationId)).toEqual(["org-1", "org-2"]);
});

test("all-workspace listings preserve tenant membership and workspace IDs", async () => {
  const repository = { id: "repo-1", organizationId: "org-1", name: "repo", fullName: "acme/repo", visibility: "private", available: false, installationId: "install-1" };
  const run = { id: "run-1", organizationId: "org-1", repositoryId: "repo-1", repositoryName: "repo", runNumber: 1, workflowName: "ci", event: "push", branch: "main", commitSha: "abcdef1", actorLogin: "acme", status: "completed", conclusion: "success", queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0, runtimeBoundary: null };
  const pool = { id: "pool-1", organizationId: "org-1", workerId: "worker-1", workerName: "worker", name: "default", platform: "linux-x64", driver: "kata-k3s", imageDigest: "ubuntu@sha256:" + "a".repeat(64), resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, labels: ["self-hosted"], triggerLabel: "whitesmith", enabled: true, active: 0 };
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => { const query = strings.join(" "); queries.push(query); if (query.includes("runner_pools")) return [pool]; if (query.includes("dashboard_repositories")) return [repository]; if (query.includes("dashboard_runs")) return [run]; return []; }) as never;
  expect((await listAllRepositories(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1", available: false });
  expect((await listAllRuns(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1" });
  expect((await listAllPools(db, "user-1")).items[0]).toMatchObject({ organizationId: "org-1" });
  expect(queries.every((query) => !query.includes("r.approved"))).toBe(true);
});

const discoveryOrganizationId = "11111111-1111-4111-8111-111111111111";
const discoveryRepositoryId = "22222222-2222-4222-8222-222222222222";

function discoveryRecheckDb(options: { paused?: boolean; missing?: boolean } = {}) {
  const state = { paused: options.paused ?? true, keys: new Set<string>(), updates: 0 };
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    if (query.includes("FROM dashboard_repositories r")) return options.missing ? [] : [{ paused: state.paused }];
    if (query.includes("SELECT 1 FROM dashboard_mutations")) return state.keys.has(String(values[1])) ? [{ exists: 1 }] : [];
    if (query.includes("INSERT INTO dashboard_mutations")) {
      const key = String(values[1]);
      if (state.keys.has(key)) return [];
      state.keys.add(key);
      return [{ idempotency_key: key }];
    }
    if (query.includes("SET discovery_retry_at=now()")) {
      state.updates += 1;
      state.paused = false;
    }
    return [];
  }, {
    begin: async (transaction: (tx: unknown) => Promise<unknown>) => transaction(sql),
  }) as never;
  return { db: sql, state };
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
