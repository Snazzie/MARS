import { expect, test } from "bun:test";
import { DashboardHealthResponse, DashboardWorkerMutationResponse, DashboardEndpoint, WorkerConfiguration } from "./dashboard-api.ts";
import { WorkerHealth } from "./dashboard.ts";

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
    ready: true,
    generation: "11111111-1111-4111-8111-111111111111",
    sizeBytes: "100000000000000000000",
    entryCount: 0,
    observedAt: null,
    error: null,
  },
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
