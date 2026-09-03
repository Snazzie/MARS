import { expect, test } from "bun:test";
import { JobTimingSnapshot } from "@mars/contracts";
import { listJobTimingHistory, recordJobTimingSnapshot, type JobTimingDb, type JobTimingSnapshotInput } from "./job-timing.ts";

const input: JobTimingSnapshotInput = {
  organizationId: "org-1", jobId: "job-1", runId: "run-1", repositoryId: "repo-1", githubJobId: 42,
  repositoryName: "acme/project", workflowName: "CI", jobName: "build", platform: "windows-x64",
  driver: "windows-hyperv-container", runtimeBoundary: "Hyper-V isolated container", poolId: "pool-1",
  artifactDigest: "sha256:test", outcome: "success", completedAt: "2026-08-16T00:00:10.000Z",
  queuedAt: "2026-08-16T00:00:00.000Z", startedAt: "2026-08-16T00:00:03.000Z",
  queueDurationMs: 1000, startupDurationMs: 2000, executionDurationMs: 5000, cleanupDurationMs: 300, totalDurationMs: 8300,
  requestedVcpu: 2, requestedMemoryBytes: 1024, requestedStorageBytes: 2048, requestedConcurrency: 3,
  observedVcpu: 2, observedMemoryBytes: 1024, observedStorageBytes: 2048, effectiveConcurrency: 3,
  telemetryState: "unavailable", telemetrySampleCount: 0, cpuAveragePercent: null, cpuP50Percent: null, cpuP95Percent: null, cpuPeakPercent: null, cpuTimeMs: null, memoryAverageBytes: null, memoryPeakBytes: null,
};

function fakeDb(rows: unknown[][]): JobTimingDb {
  return (async (strings: TemplateStringsArray) => rows.shift() ?? []) as unknown as JobTimingDb;
}

test("accepts a complete timing snapshot", () => {
  expect(() => JobTimingSnapshot.parse({ ...input, createdAt: input.completedAt })).not.toThrow();
});

test("rejects negative duration and secret-like fields", () => {
  expect(() => JobTimingSnapshot.parse({ ...input, createdAt: input.completedAt, totalDurationMs: -1 })).toThrow();
  expect(() => JobTimingSnapshot.parse({ ...input, createdAt: input.completedAt, artifactDigest: "secret", encodedJitConfig: "bad" })).toThrow();
});

test("inserts once and is idempotent on conflict", async () => {
  const db = fakeDb([[{ jobId: "job-1" }], []]);
  expect(await recordJobTimingSnapshot(db, input)).toBe(true);
  expect(await recordJobTimingSnapshot(db, input)).toBe(false);
});
test("normalizes PostgreSQL timestamp strings in timing history", async () => {
  const db = fakeDb([[{ ...input, completedAt: "2026-08-16 00:00:10+00", queuedAt: "2026-08-16 00:00:00+00", startedAt: "2026-08-16 00:00:03+00", createdAt: "2026-08-16 00:00:10+00" }]]);
  const result = await listJobTimingHistory(db, "org-1");
  expect(result.items[0]).toMatchObject({
    completedAt: "2026-08-16T00:00:10.000Z",
    queuedAt: "2026-08-16T00:00:00.000Z",
    startedAt: "2026-08-16T00:00:03.000Z",
    createdAt: "2026-08-16T00:00:10.000Z",
  });
});
test("normalizes bigint effective concurrency and emits a safe cursor", async () => {
  const db = fakeDb([[
    { ...input, effectiveConcurrency: "3", completedAt: "2026-08-16 00:00:10+00", jobId: "job-1" },
    { ...input, effectiveConcurrency: "4", completedAt: "2026-08-16 00:00:09+00", jobId: "job-2" },
  ]]);
  const result = await listJobTimingHistory(db, "org-1", { limit: 1 });
  expect(result.items[0]?.effectiveConcurrency).toBe(3);
  expect(result.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
});
