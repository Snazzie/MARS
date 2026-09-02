import { expect, test } from "bun:test";
import { LeaseBootstrapEnvelope, OutOfMemoryResult, RunnerJitConfig, RuntimeTerminationEvidence, WorkerBuildImagePayload, WorkerContainerStatus, WorkerDoctorData, WorkerDoctorReport, WorkerImageBuildSpec, sanitizeDiagnosticText } from "./orchestration.ts";
import * as orchestration from "./orchestration.ts";

test("parses a GitHub JIT config with a one-time lease binding", () => {
  expect(RunnerJitConfig.parse({
    encodedJitConfig: "encoded",
    runnerName: "mars-lease-1",
    labels: ["self-hosted", "macos", "arm64", "mars-default"],
    expiresAt: "2026-08-12T12:00:00.000Z",
  })).toMatchObject({ runnerName: "mars-lease-1" });
  expect(LeaseBootstrapEnvelope.safeParse({
    leaseId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    nonce: "n".repeat(32),
    guestPlatform: "macos-arm64",
    encodedJitConfig: "encoded",
    expiresAt: "2026-08-12T12:00:00.000Z",
    imageDigest: "sha256:test",
    resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 },
  }).success).toBe(true);
});

test("rejects JIT config without runner labels", () => {
  expect(RunnerJitConfig.safeParse({ encodedJitConfig: "encoded", runnerName: "runner", labels: [], expiresAt: "2026-08-12T12:00:00.000Z" }).success).toBe(false);
});

test("parses structured out-of-memory results", () => {
  expect(OutOfMemoryResult.parse({
    reason: "out_of_memory",
    memoryWorkingSetBytes: 11_295_763_988,
    memoryLimitBytes: 10_737_418_240,
    detectedAt: "2026-08-17T20:59:24.015Z",
    gracefulStopAcknowledged: false,
  })).toMatchObject({ reason: "out_of_memory", gracefulStopAcknowledged: false });
});

test("accepts sanitized forced-termination evidence", () => {
  expect(RuntimeTerminationEvidence.parse({
    cause: "forced_job_termination",
    exitCode: 1,
    exitObserved: false,
    elapsedMs: 900_000,
    childPid: 1234,
    servicePid: 456,
    activeProcessCount: 2,
    peakProcessCount: 4,
    peakProcessMemoryBytes: 10_000,
    peakJobMemoryBytes: 12_000,
    kernelTimeMs: 4_000,
    userTimeMs: 8_000,
    lastSampleOccurredAt: new Date().toISOString(),
    sampleCount: 42,
    samplingGapMs: 5_000,
  }).cause).toBe("forced_job_termination");
});

test("rejects sensitive or unknown termination evidence fields", () => {
  expect(RuntimeTerminationEvidence.safeParse({ cause: "child_exit", exitCode: 0, commandLine: "secret" }).success).toBe(false);
});

test("rejects invalid out-of-memory measurements", () => {
  expect(() => OutOfMemoryResult.parse({
    reason: "out_of_memory",
    memoryWorkingSetBytes: -1,
    memoryLimitBytes: 10,
    detectedAt: "2026-08-17T20:59:24.015Z",
    gracefulStopAcknowledged: false,
  })).toThrow();
});
test("accepts worker-local runtime readiness without a registry digest", () => {
  expect(WorkerDoctorData.parse({ runtimeMode: "container", artifactSource: "worker_local", artifactIdentity: "mars/windows-job:local", runtimeReady: true, probe: true, egress: true, imageSignatures: true })).toMatchObject({
    artifactSource: "worker_local",
    artifactIdentity: "mars/windows-job:local",
    runtimeReady: true,
  });
});
test("accepts worker-reported active lease inventory", () => {
  expect(WorkerDoctorData.parse({
    runtimeMode: "tart",
    activeLeases: ["11111111-1111-4111-8111-111111111111"],
  }).activeLeases).toEqual(["11111111-1111-4111-8111-111111111111"]);
});
const workerContainerStatusFixture = {
  containerId: "a".repeat(64),
  name: "build",
  leaseId: "11111111-1111-4111-8111-111111111111",
  state: "running" as const,
  cpuUsagePercent: 42.5,
  memoryWorkingSetBytes: 1024,
  memoryLimitBytes: 2048,
  diskUsageBytes: 4096,
  sampledAt: "2026-08-23T12:00:00.000+00:00",
};

const workerCapacityFixture = {
  actualVcpu: 4,
  actualMemoryBytes: 8192,
  actualStorageBytes: 16384,
  freeVcpu: 2,
  freeMemoryBytes: 4096,
  freeStorageBytes: 8192,
};

test("parses complete and partially unavailable worker container statuses", () => {
  expect(WorkerContainerStatus.parse(workerContainerStatusFixture)).toEqual(workerContainerStatusFixture);
  expect(WorkerContainerStatus.parse({
    ...workerContainerStatusFixture,
    state: "exited",
    cpuUsagePercent: null,
    memoryWorkingSetBytes: null,
    memoryLimitBytes: null,
    diskUsageBytes: null,
  })).toMatchObject({ state: "exited", cpuUsagePercent: null, memoryWorkingSetBytes: null, memoryLimitBytes: null, diskUsageBytes: null });
});

test("defaults worker doctor container inventory to an empty array", () => {
  expect(WorkerDoctorData.parse({}).containers).toEqual([]);
});

test("parses a strict worker doctor report with container inventory", () => {
  const parsed = WorkerDoctorReport.parse({
    doctor: { containers: [workerContainerStatusFixture] },
    capacity: workerCapacityFixture,
  });
  expect(parsed.doctor.containers).toEqual([workerContainerStatusFixture]);
  expect(WorkerDoctorReport.safeParse({ doctor: {}, capacity: workerCapacityFixture, unexpected: true }).success).toBe(false);
});

test("rejects invalid worker container status values", () => {
  const invalidCases = [
    { state: "unknown" },
    { cpuUsagePercent: 101 },
    { cpuUsagePercent: -1 },
    { diskUsageBytes: -1 },
    { leaseId: "not-a-uuid" },
    { memoryWorkingSetBytes: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const changes of invalidCases) {
    expect(WorkerContainerStatus.safeParse({ ...workerContainerStatusFixture, ...changes }).success).toBe(false);
  }
});
test("parses an immutable worker-local image build request", () => {
  const artifact = (name: string, hash: string) => ({ url: `https://control.test/api/workers/${name}`, sha256: hash.repeat(64) });
  const payload = WorkerBuildImagePayload.parse({
    buildId: "11111111-1111-4111-8111-111111111111",
    image: "mars/windows-job:local",
    baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${"a".repeat(64)}`,
    runner: artifact("runner.zip", "b"),
    git: artifact("git.zip", "c"),
    vcRuntime: artifact("vc_redist.x64.exe", "d"),
    artifacts: {
      builder: artifact("windows-container-builder", "1"),
      verifier: artifact("windows-container-verifier", "2"),
      containerfile: artifact("windows-containerfile", "3"),
      entrypoint: artifact("windows-container-entrypoint", "4"),
      jobAgent: artifact("windows-container-job-agent", "5"),
    },
    contentSha256: "f".repeat(64),
  });
  expect(payload.artifacts.entrypoint.url).toBe("https://control.test/api/workers/windows-container-entrypoint");
  expect(WorkerImageBuildSpec.safeParse({ image: "mars/windows-job:local", dockerfile: "FROM base" }).success).toBe(false);
  expect(WorkerBuildImagePayload.safeParse({ ...payload, contentSha256: "mutable" }).success).toBe(false);
});

test("defaults omitted runner cache settings", () => {
  const configuration = orchestration.WorkerConfiguration.parse({
    appliance: { vcpu: 1, memoryBytes: 2, storageBytes: 3 },
    runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 3, maxConcurrentPods: 1 },
    guestPlatforms: ["linux-x64"],
  });
  expect(configuration.cache).toEqual({ ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 });
  expect(orchestration.WorkerConfiguration.parse({
    appliance: { vcpu: 1, memoryBytes: 2, storageBytes: 3 },
    runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 3, maxConcurrentPods: 1 },
    guestPlatforms: ["linux-x64"],
    cache: { ttlSeconds: 3600 },
  }).cache).toEqual({ ttlSeconds: 3600, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 });
});

test("parses explicit runner cache settings and rejects invalid caps", () => {
  expect(orchestration.WorkerConfiguration.parse({
    appliance: { vcpu: 1, memoryBytes: 2, storageBytes: 3 },
    runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 3, maxConcurrentPods: 1 },
    guestPlatforms: ["linux-x64"],
    cache: { ttlSeconds: 3600, runnerCacheEnabled: false, runnerCacheMaxGiB: 7 },
  }).cache).toEqual({ ttlSeconds: 3600, runnerCacheEnabled: false, runnerCacheMaxGiB: 7 });
  expect(orchestration.WorkerCacheConfiguration.safeParse({ runnerCacheMaxGiB: 0 }).success).toBe(false);
  expect(orchestration.WorkerCacheConfiguration.safeParse({ runnerCacheMaxGiB: 1.5 }).success).toBe(false);
  expect(orchestration.WorkerCacheConfiguration.safeParse({ runnerCacheMaxGiB: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  expect(orchestration.WorkerCacheConfiguration.safeParse({ ttlSeconds: 0 }).success).toBe(false);
  expect(orchestration.WorkerCacheConfiguration.safeParse({ ttlSeconds: 1, extra: true }).success).toBe(false);
});

test("parses an explicitly disabled runner cache", () => {
  expect(orchestration.WorkerConfiguration.parse({
    appliance: { vcpu: 1, memoryBytes: 2, storageBytes: 3 },
    runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 3, maxConcurrentPods: 1 },
    guestPlatforms: ["linux-x64"],
    cache: { ttlSeconds: 3600, runnerCacheEnabled: false, runnerCacheMaxGiB: 20 },
  }).cache).toEqual({ ttlSeconds: 3600, runnerCacheEnabled: false, runnerCacheMaxGiB: 20 });
});

test("requires runner cache settings in observed configuration", () => {
  const observed = {
    appliance: { vcpu: 1, memoryBytes: 2, storageBytes: 3 },
    runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 3, maxConcurrentPods: 1 },
    guestPlatforms: ["linux-x64"],
  };
  const acknowledgement = {
    commandId: "11111111-1111-4111-8111-111111111111",
    workerId: "22222222-2222-4222-8222-222222222222",
    revision: "a".repeat(64),
  };
  expect(orchestration.WorkerConfiguredPayload.safeParse({ ...acknowledgement, observed: { ...observed, cache: { ttlSeconds: 172800, runnerCacheEnabled: true } } }).success).toBe(false);
  expect(orchestration.WorkerConfiguredPayload.safeParse({ ...acknowledgement, observed: { ...observed, cache: { ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } } }).success).toBe(true);
});
test("defaults missing runner cache policy fields in legacy configure payloads only", () => {
  const payload = {
    workerId: "11111111-1111-4111-8111-111111111111",
    appliance: { vcpu: 1, memoryBytes: 2, storageBytes: 3 },
    runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 3, maxConcurrentPods: 1 },
    guestPlatforms: ["linux-x64"],
    cache: { ttlSeconds: 3600 },
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
  };
  expect(orchestration.WorkerConfigurePayload.parse(payload).cache).toEqual({
    ttlSeconds: 3600,
    runnerCacheEnabled: true,
    runnerCacheMaxGiB: 20,
  });
  expect(orchestration.WorkerObservedConfiguration.safeParse({
    appliance: payload.appliance,
    runtime: payload.runtime,
    guestPlatforms: payload.guestPlatforms,
    cache: payload.cache,
  }).success).toBe(false);
});



test("keeps cache proxy material guest-only", () => {
  const cache = {
    proxyUrl: "http://lease-user:lease-secret@127.0.0.1:3128",
    cacheBaseUrl: "https://cache.worker.test",
    caCertificatePem: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----",
    expiresAt: "2026-08-23T12:00:00.000Z",
  };
  expect(orchestration.WorkerCacheProxy.parse(cache)).toEqual(cache);
  const envelope = {
    leaseId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    nonce: "n".repeat(32),
    guestPlatform: "linux-x64",
    encodedJitConfig: "encoded",
    expiresAt: "2026-08-23T12:00:00.000Z",
    imageDigest: "sha256:test",
    resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 },
  };
  expect(LeaseBootstrapEnvelope.safeParse({ ...envelope, cache }).success).toBe(false);
  expect(orchestration.WorkerCacheProxy.safeParse({ ...cache, workerAddress: "10.0.0.1" }).success).toBe(false);
  expect(orchestration.WorkerCacheProxy.safeParse({ ...cache, proxyUrl: "http://127.0.0.1:3128" }).success).toBe(false);
  expect(orchestration.WorkerCacheProxy.safeParse({ ...cache, proxyUrl: "https://127.0.0.1:3128" }).success).toBe(false);
  expect(orchestration.WorkerCacheProxy.safeParse({ ...cache, proxyUrl: "http://127.0.0.1:3128/path" }).success).toBe(false);
  expect(orchestration.WorkerCacheProxy.safeParse({ ...cache, cacheBaseUrl: "http://cache.worker.test" }).success).toBe(false);
  expect(orchestration.WorkerCacheProxy.safeParse({ ...cache, cacheBaseUrl: "https://user:secret@cache.worker.test" }).success).toBe(false);
  expect(orchestration.WorkerCacheProxy.safeParse({ ...cache, cacheBaseUrl: "https://cache.worker.test/path" }).success).toBe(false);
});

test("parses strict lossless worker cache telemetry", () => {
  const entry = {
    entryId: "11111111-1111-4111-8111-111111111111",
    githubRepositoryId: "9223372036854775807",
    cacheKeyPreview: "node-modules-linux",
    cacheKeyHash: "a".repeat(64),
    scopePreview: "refs/heads/main",
    scopeHash: "b".repeat(64),
    versionHash: "c".repeat(64),
    sizeBytes: "9007199254740993",
    createdAt: "2026-08-23T12:00:00.000Z",
    lastAccessedAt: "2026-08-23T12:01:00+00:00",
    expiresAt: "2026-08-25T12:00:00.000Z",
  };
  const status = {
    generation: "22222222-2222-4222-8222-222222222222",
    ready: true,
    ttlSeconds: 172800,
    proxyOrigin: "http://127.0.0.1:3128",
    cacheBaseUrl: "https://cache.worker.test",
    sizeBytes: "9007199254740993",
    entryCount: 1,
    observedAt: "2026-08-23T12:01:00.000Z",
    error: null,
  };
  expect(orchestration.WorkerCacheTelemetry.parse({
    type: "worker.cache_entry_upsert",
    payload: { generation: status.generation, entry },
  }).payload).toEqual({ generation: status.generation, entry });
  expect(orchestration.WorkerCacheTelemetry.parse({
    type: "worker.cache_snapshot_begin",
    payload: { snapshotId: "33333333-3333-4333-8333-333333333333", status },
  }).payload).toEqual({ snapshotId: "33333333-3333-4333-8333-333333333333", status });
  const runnerStatus = {
    generation: status.generation,
    enabled: true,
    maxGiB: 20,
    sizeBytes: "9007199254740993",
    entryCount: 1,
    observedAt: "2026-08-23T12:01:00.000Z",
  };
  expect(orchestration.WorkerRunnerCacheStatus.parse(runnerStatus)).toEqual(runnerStatus);
  expect(orchestration.WorkerCacheTelemetry.parse({ type: "worker.runner_cache_status", payload: runnerStatus }).payload).toEqual(runnerStatus);
  expect(orchestration.WorkerEventPayload.parse({ type: "worker.runner_cache_status", payload: runnerStatus }).payload).toEqual(runnerStatus);
  expect(orchestration.WorkerRunnerCacheStatus.safeParse({ ...runnerStatus, unknown: true }).success).toBe(false);
  expect(orchestration.WorkerRunnerCacheStatus.safeParse({ ...runnerStatus, entryCount: -1 }).success).toBe(false);
  expect(orchestration.WorkerRunnerCacheStatus.safeParse({ ...runnerStatus, sizeBytes: "12.5" }).success).toBe(false);
  expect(orchestration.WorkerCacheEntryProjection.safeParse({ ...entry, sizeBytes: 9_007_199_254_740_993 }).success).toBe(false);
  expect(orchestration.WorkerCacheEntryProjection.safeParse({ ...entry, githubRepositoryId: "9223372036854775808" }).success).toBe(false);
  expect(() => orchestration.WorkerCacheEntryProjection.safeParse({ ...entry, githubRepositoryId: "not-a-number" })).not.toThrow();
  expect(orchestration.WorkerCacheEntryProjection.safeParse({ ...entry, githubRepositoryId: "not-a-number" }).success).toBe(false);
  expect(() => orchestration.WorkerCacheEntryProjection.safeParse({ ...entry, sizeBytes: "12.5" })).not.toThrow();
  expect(orchestration.WorkerCacheEntryProjection.safeParse({ ...entry, sizeBytes: "12.5" }).success).toBe(false);
  expect(orchestration.WorkerCacheStatus.safeParse({ ...status, proxyOrigin: "http://lease-user:lease-secret@127.0.0.1:3128" }).success).toBe(false);
});

test("bounds worker cache snapshot frames and requires completion counts", () => {
  const entry = {
    entryId: "11111111-1111-4111-8111-111111111111",
    githubRepositoryId: "1",
    cacheKeyPreview: "key",
    cacheKeyHash: "a".repeat(64),
    scopePreview: "scope",
    scopeHash: "b".repeat(64),
    versionHash: "c".repeat(64),
    sizeBytes: "1",
    createdAt: "2026-08-23T12:00:00.000Z",
    lastAccessedAt: "2026-08-23T12:00:00.000Z",
    expiresAt: "2026-08-25T12:00:00.000Z",
  };
  const snapshotId = "33333333-3333-4333-8333-333333333333";
  expect(orchestration.WorkerCacheTelemetry.safeParse({
    type: "worker.cache_snapshot_page",
    payload: { snapshotId, sequence: 0, entries: Array.from({ length: 101 }, () => entry) },
  }).success).toBe(false);
  expect(orchestration.WorkerCacheTelemetry.safeParse({
    type: "worker.cache_snapshot_end",
    payload: { snapshotId, pageCount: 1, entryCount: 1 },
  }).success).toBe(false);
  expect(orchestration.WorkerCacheTelemetry.safeParse({
    type: "worker.cache_snapshot_end",
    payload: { snapshotId, pageCount: 1, entryCount: 1, sizeBytes: "1" },
  }).success).toBe(true);
});
test("redacts diagnostic credential assignments while preserving useful output", () => {
  const input = [
    "started worker",
    "config.password=secret-one",
    "PASSWORD=secret-two",
    "token=secret-three",
    "api-key: secret-four",
    "--credential=secret-five",
    "healthy nonsecret diagnostic",
  ].join("\n");
  const output = sanitizeDiagnosticText(input);
  expect(output).toContain("started worker");
  expect(output).toContain("healthy nonsecret diagnostic");
  for (const secret of ["secret-one", "secret-two", "secret-three", "secret-four", "secret-five"]) expect(output).not.toContain(secret);
  expect(output.match(/\[REDACTED\]/g)?.length).toBe(5);
});
