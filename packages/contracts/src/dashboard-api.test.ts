import { expect, test } from "bun:test";
import { DashboardHealthResponse, DashboardWorkerMutationResponse, DashboardEndpoint, WorkerConfiguration } from "./dashboard-api.ts";
import { JobResourceTrendResponse, WorkerHealth } from "./dashboard.ts";

const workerHealthFixture = {
  observedAt: "2026-08-23T12:00:00.000Z",
  connection: {
    state: "online",
    lastHeartbeatAt: "2026-08-23T11:59:59.000Z",
    lastDoctorAt: null,
    heartbeatAgeSeconds: 1,
    doctorAgeSeconds: null,
  },
  usage: {
    cpu: { actual: 1.5, reserved: 2, free: 0.5 },
    memoryBytes: { actual: "100000000000000000000", reserved: "200", free: "99999999999999999800" },
    storageBytes: { actual: "300", reserved: "200", free: "100" },
    pods: { actual: 1, reserved: 2, free: 3 },
  },
  cache: {
    desiredTtlSeconds: 172800,
    effectiveTtlSeconds: null,
    effectiveRunnerCacheEnabled: null,
    effectiveRunnerCacheMaxGiB: null,
    ready: true,
    generation: "11111111-1111-4111-8111-111111111111",
    sizeBytes: "100000000000000000000",
    entryCount: 0,
    runnerCacheSizeBytes: "0",
    runnerCacheEntryCount: 0,
    observedAt: null,
    runnerCacheObservedAt: null,
    error: null,
  },
  containers: [{
    containerId: "a".repeat(64),
    name: "build",
    leaseId: "11111111-1111-4111-8111-111111111111",
    state: "running",
    cpuUsagePercent: 42.5,
    memoryWorkingSetBytes: "1024",
    memoryLimitBytes: "2048",
    diskUsageBytes: "4096",
    sampledAt: "2026-08-23T12:00:00.000+00:00",
  }],
  jobs: [{
    jobId: null,
    repositoryFullName: null,
    repositoryName: null,
    leaseId: "22222222-2222-4222-8222-222222222222",
    state: "running",
    startedAt: null,
    ageSeconds: null,
    requested: { vcpu: 0.5, memoryBytes: "1099511627776", storageBytes: "2147483648", concurrency: 1 },
  }],
} as const;

const trendResponse = {
  summary: { jobCount: 2, completedRunCount: 3, medianExecutionDurationMs: 62000, telemetryCoveredRunCount: 2, telemetryCoveragePercent: 66.67 },
  jobs: [{
    jobKey: "eyJyZXBvc2l0b3J5SWQiOiJyZXBvLTEiLCJ3b3JrZmxvd05hbWUiOiJDSSIsImpvYk5hbWUiOiJidWlsZCJ9",
    repositoryId: "repo-1", repositoryName: "acme/app", workflowName: "CI", jobName: "build",
    platform: "windows-x64", runCount: 2, latestCompletedAt: "2026-09-03T12:00:00.000Z",
    medianExecutionDurationMs: 62000, cpuPeakPercent: 84.5, memoryPeakBytes: 2147483648,
    telemetryCoveredRunCount: 2, telemetryCoveragePercent: 100,
    durationChangePercent: 12.5, cpuChangePercent: null, memoryChangePercent: -4.2,
  }, {
    jobKey: "eyJyZXBvc2l0b3J5SWQiOiJyZXBvLTIiLCJ3b3JrZmxvd05hbWUiOiJDSSIsImpvYk5hbWUiOiJidWlsZCJ9",
    repositoryId: "repo-2", repositoryName: "acme/service", workflowName: "CI", jobName: "build",
    platform: "windows-x64", runCount: 1, latestCompletedAt: "2026-09-03T11:00:00.000Z",
    medianExecutionDurationMs: 58000, cpuPeakPercent: null, memoryPeakBytes: null,
    telemetryCoveredRunCount: 0, telemetryCoveragePercent: 0,
    durationChangePercent: null, cpuChangePercent: null, memoryChangePercent: null,
  }],
  nextCursor: null,
  selectedJob: {
    jobKey: "eyJyZXBvc2l0b3J5SWQiOiJyZXBvLTEiLCJ3b3JrZmxvd05hbWUiOiJDSSIsImpvYk5hbWUiOiJidWlsZCJ9",
    points: [{
      organizationId: "org-1", runId: "run-1", jobId: "job-1", completedAt: "2026-09-03T12:00:00.000Z",
      outcome: "success", executionDurationMs: 62000, cpuAveragePercent: 42.5, cpuPeakPercent: 84.5,
      memoryPeakBytes: 2147483648, requestedVcpu: 2, requestedMemoryBytes: 4294967296,
      effectiveConcurrency: 1, telemetryState: "available", telemetrySampleCount: 12,
    }],
  },
  filters: { platforms: ["windows-x64"], vcpus: [2], concurrencies: [1] },
  generatedAt: "2026-09-03T12:01:00.000Z",
};

test("accepts job resource trend values and nullable missing telemetry", () => {
  const parsed = JobResourceTrendResponse.parse(trendResponse);
  expect(parsed.jobs.map(({ jobKey, repositoryId, jobName }) => ({ jobKey, repositoryId, jobName }))).toEqual([
    { jobKey: trendResponse.jobs[0].jobKey, repositoryId: "repo-1", jobName: "build" },
    { jobKey: trendResponse.jobs[1].jobKey, repositoryId: "repo-2", jobName: "build" },
  ]);
  expect(parsed.selectedJob?.points[0]?.cpuPeakPercent).toBe(84.5);
  expect(JobResourceTrendResponse.parse({
    ...trendResponse,
    selectedJob: { ...trendResponse.selectedJob, points: [{ ...trendResponse.selectedJob.points[0], cpuAveragePercent: null, cpuPeakPercent: null, memoryPeakBytes: null, telemetryState: "unavailable", telemetrySampleCount: 0 }] },
  }).selectedJob?.points[0]?.memoryPeakBytes).toBeNull();
});

test("rejects unsupported disk telemetry and invalid coverage", () => {
  expect(() => JobResourceTrendResponse.parse({ ...trendResponse, diskUsageBytes: 1 })).toThrow();
  expect(() => JobResourceTrendResponse.parse({ ...trendResponse, summary: { ...trendResponse.summary, telemetryCoveragePercent: 101 } })).toThrow();
  expect(() => JobResourceTrendResponse.parse({
    ...trendResponse,
    selectedJob: { ...trendResponse.selectedJob, points: [{ ...trendResponse.selectedJob.points[0], cpuPeakPercent: -0.1 }] },
  })).toThrow();
});

test("parses worker configuration response", () => {
  const response = DashboardWorkerMutationResponse.parse({
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
    commandId: "00000000-0000-4000-8000-000000000001",
  });
  expect(response.revision).toHaveLength(64);
});

test("rejects malformed health response", () => {
  expect(() => DashboardHealthResponse.parse({ ok: "yes" })).toThrow();
});

test("keeps endpoint request and response schemas type-linked", () => {
  const endpoint = {
    request: WorkerConfiguration,
    response: DashboardWorkerMutationResponse,
  } satisfies DashboardEndpoint<typeof WorkerConfiguration, typeof DashboardWorkerMutationResponse>;
  expect(endpoint.request).toBe(WorkerConfiguration);
  expect(endpoint.response).toBe(DashboardWorkerMutationResponse);
});
test("parses a complete worker health response", () => {
  const parsed = WorkerHealth.parse(workerHealthFixture);
  expect(parsed.cache.generation).toBe("11111111-1111-4111-8111-111111111111");
  expect(parsed.usage.memoryBytes.actual).toBe("100000000000000000000");
});
test("parses partially unavailable worker container health", () => {
  const parsed = WorkerHealth.parse({
    ...workerHealthFixture,
    containers: [{
      ...workerHealthFixture.containers[0],
      state: "exited",
      cpuUsagePercent: null,
      memoryWorkingSetBytes: null,
      memoryLimitBytes: null,
      diskUsageBytes: null,
    }],
  });
  expect(parsed.containers[0]).toMatchObject({ state: "exited", cpuUsagePercent: null, memoryWorkingSetBytes: null, memoryLimitBytes: null, diskUsageBytes: null });
});

test("rejects invalid worker container health values", () => {
  const invalidCases = [
    { state: "unknown" },
    { cpuUsagePercent: 101 },
    { diskUsageBytes: "-1" },
    { leaseId: "not-a-uuid" },
    { memoryWorkingSetBytes: Number.MAX_SAFE_INTEGER + 1 },
    { unexpected: true },
  ];
  for (const changes of invalidCases) {
    expect(WorkerHealth.safeParse({
      ...workerHealthFixture,
      containers: [{ ...workerHealthFixture.containers[0], ...changes }],
    }).success).toBe(false);
  }
});

test("rejects unsafe numeric worker health values, including byte fields", () => {
  expect(WorkerHealth.safeParse({
    ...workerHealthFixture,
    usage: { ...workerHealthFixture.usage, pods: { actual: Number.MAX_SAFE_INTEGER + 1, reserved: 0, free: 0 } },
  }).success).toBe(false);
  expect(WorkerHealth.safeParse({
    ...workerHealthFixture,
    usage: { ...workerHealthFixture.usage, memoryBytes: { ...workerHealthFixture.usage.memoryBytes, actual: Number.MAX_SAFE_INTEGER + 1 } },
  }).success).toBe(false);
});

test("accepts null GitHub metadata and telemetry timestamps", () => {
  const parsed = WorkerHealth.parse(workerHealthFixture);
  expect(parsed.jobs[0]).toMatchObject({ jobId: null, repositoryFullName: null, repositoryName: null, startedAt: null, ageSeconds: null });
  expect(parsed.connection).toMatchObject({ lastHeartbeatAt: expect.any(String), lastDoctorAt: null, doctorAgeSeconds: null });
  expect(parsed.cache.observedAt).toBeNull();
});

test("rejects secret-bearing proxy data", () => {
  expect(WorkerHealth.safeParse({
    ...workerHealthFixture,
    cache: {
      ...workerHealthFixture.cache,
      proxyUrl: "http://user:password@proxy.example.test/",
      caCertificatePem: "-----BEGIN CERTIFICATE-----secret",
    },
  }).success).toBe(false);
});
