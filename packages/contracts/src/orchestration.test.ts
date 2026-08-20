import { expect, test } from "bun:test";
import { LeaseBootstrapEnvelope, OutOfMemoryResult, RunnerJitConfig, RuntimeTerminationEvidence, WorkerBuildImagePayload, WorkerDoctorData, WorkerImageBuildSpec } from "./orchestration.ts";

test("parses a GitHub JIT config with a one-time lease binding", () => {
  expect(RunnerJitConfig.parse({
    encodedJitConfig: "encoded",
    runnerName: "whitesmith-lease-1",
    labels: ["self-hosted", "macos", "arm64", "whitesmith-default"],
    expiresAt: "2026-08-12T12:00:00.000Z",
  })).toMatchObject({ runnerName: "whitesmith-lease-1" });
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
  expect(WorkerDoctorData.parse({ runtimeMode: "container", artifactSource: "worker_local", artifactIdentity: "whitesmith/windows-job:local", runtimeReady: true, probe: true, egress: true, imageSignatures: true })).toMatchObject({
    artifactSource: "worker_local",
    artifactIdentity: "whitesmith/windows-job:local",
    runtimeReady: true,
  });
});
test("accepts worker-reported active lease inventory", () => {
  expect(WorkerDoctorData.parse({
    runtimeMode: "tart",
    activeLeases: ["11111111-1111-4111-8111-111111111111"],
  }).activeLeases).toEqual(["11111111-1111-4111-8111-111111111111"]);
});
test("parses an immutable worker-local image build request", () => {
  const artifact = (name: string, hash: string) => ({ url: `https://control.test/api/workers/${name}`, sha256: hash.repeat(64) });
  const payload = WorkerBuildImagePayload.parse({
    buildId: "11111111-1111-4111-8111-111111111111",
    image: "whitesmith/windows-job:local",
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
  expect(WorkerImageBuildSpec.safeParse({ image: "whitesmith/windows-job:local", dockerfile: "FROM base" }).success).toBe(false);
  expect(WorkerBuildImagePayload.safeParse({ ...payload, contentSha256: "mutable" }).success).toBe(false);
});
