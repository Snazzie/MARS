import { expect, test } from "bun:test";
import { LogChunk, OverviewDto, RunDetail, RunSummary, WorkerDetail } from "@whitesmith/contracts";
import { getOverview, getOrganizationSettings, getRunDetail, listAllRepositories, listAllRuns, listAllPools, listAllWorkers, listRuns, listWorkers, listPools, listLogChunks, listStepLogChunks } from "./dashboard.ts";

test("overview returns point-in-time pending and running buckets", async () => {
  const db = (async (strings: TemplateStringsArray) => {
    if (strings.join(" ").includes("generate_series")) return [{ bucket: new Date("2026-08-12T10:00:00.000Z"), pending: 2, running: 1 }];
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
  expect(OverviewDto.parse(result).timeseries).toEqual([{ bucket: "2026-08-12T10:00:00.000Z", pending: 2, running: 1 }]);
});

test("worker listing normalizes persisted telemetry into the WorkerDetail contract", async () => {
  const db = (async () => [{ id: "86afd915-add3-407c-a6c1-1b46803ef713", organizationId: "c432f22a-16e2-44f8-9a6b-bc00e5de1a7d", name: "mac-worker", platform: "macos-arm64", driver: "tart-vm", admissionState: "adopted", connectionState: "online", configurationState: "ready", fingerprint: "sha256:worker", limits: "{\"maxVcpuPerPod\":2,\"maxMemoryBytesPerPod\":3221225472,\"maxStorageBytesPerPod\":10737418240,\"maxConcurrentPods\":1}", doctor: { doctor: { probe: true, egress: true }, capacity: { freeVcpu: 10, actualVcpu: 10, freeMemoryBytes: 16149077032, actualMemoryBytes: 34359738368, freeStorageBytes: 103244165120, actualStorageBytes: 994610155520 } }, activeSandboxes: 0, draining: false }]) as never;
  const page = await listWorkers(db, "c432f22a-16e2-44f8-9a6b-bc00e5de1a7d");
  expect(() => WorkerDetail.parse(page.items[0])).not.toThrow();
  expect(page.items[0]).toMatchObject({ driver: "tart-vm", doctor: { probe: true }, limits: { maxVcpuPerPod: 2 }, capacity: { vcpu: { actual: 10, free: 10 }, memoryBytes: { actual: 34359738368, free: 16149077032 } } });
});

test("pool listing normalizes PostgreSQL JSONB resources and labels", async () => {
  const db = (async () => [{ id: "pool-1", organizationId: "org-1", workerId: "worker-1", workerName: "worker", name: "default", platform: "linux-x64", driver: "kata-k3s", imageDigest: "ubuntu@sha256:" + "a".repeat(64), resources: "{\"vcpu\":2,\"memoryBytes\":4294967296,\"storageBytes\":10737418240,\"concurrency\":1}", labels: "[\"self-hosted\",\"linux\",\"x64\",\"whitesmith-default\"]", triggerLabel: "whitesmith-default", enabled: true, active: "0" }]) as never;
  const page = await listPools(db, "org-1");
  expect(page.items[0].resources.memoryBytes).toBe(4294967296);
  expect(page.items[0].labels).toEqual(["self-hosted", "linux", "x64", "whitesmith-default"]);
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
