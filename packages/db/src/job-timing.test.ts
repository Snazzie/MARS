import { expect, test } from "bun:test";
import { JobTimingSnapshot } from "@mars/contracts";
import { preparedTestDatabase } from "./prepared-test-fixture.ts";
import { getJobTimingAggregates, listJobTimingHistory, recordJobTimingSnapshot, type JobTimingSnapshotInput } from "./job-timing.ts";

const input: JobTimingSnapshotInput = {
  organizationId: "org-1", jobId: "job-1", runId: "run-1", repositoryId: "repo-1", githubJobId: 42,
  repositoryName: "acme/project", workflowName: "CI", jobName: "build", platform: "windows-x64",
  workerId: "worker-1", driver: "windows-hyperv-container", runtimeBoundary: "Hyper-V isolated container", poolId: "pool-1",
  artifactDigest: "sha256:test", outcome: "success", completedAt: "2026-08-16T00:00:10.000Z",
  queuedAt: "2026-08-16T00:00:00.000Z", startedAt: "2026-08-16T00:00:03.000Z",
  queueDurationMs: 1000, startupDurationMs: 2000, executionDurationMs: 5000, cleanupDurationMs: 300, totalDurationMs: 8300,
  requestedVcpu: 2, requestedMemoryBytes: 1024, requestedStorageBytes: 2048, requestedConcurrency: 3,
  observedVcpu: 2, observedMemoryBytes: 1024, observedStorageBytes: 2048, effectiveConcurrency: 3,
  telemetryState: "unavailable", telemetrySampleCount: 0, cpuAveragePercent: null, cpuP50Percent: null, cpuP95Percent: null, cpuPeakPercent: null, cpuTimeMs: null, memoryAverageBytes: null, memoryPeakBytes: null,
};

test("accepts a complete timing snapshot", () => {
  expect(() => JobTimingSnapshot.parse({ ...input, createdAt: input.completedAt })).not.toThrow();
});

test("rejects negative duration and secret-like fields", () => {
  expect(() => JobTimingSnapshot.parse({ ...input, createdAt: input.completedAt, totalDurationMs: -1 })).toThrow();
  expect(() => JobTimingSnapshot.parse({ ...input, createdAt: input.completedAt, artifactDigest: "secret", encodedJitConfig: "bad" })).toThrow();
});

test("inserts once and is idempotent on conflict", async () => {
  let insertCount = 0;
  const db = preparedTestDatabase((name) => name === "job_timing_insert" ? (++insertCount === 1 ? [{ jobId: "job-1" }] : []) : []);
  expect(await recordJobTimingSnapshot(db, input)).toBe(true);
  expect(await recordJobTimingSnapshot(db, input)).toBe(false);
});

test("normalizes timing timestamps and bigint fields in history", async () => {
  const db = preparedTestDatabase((name) => name === "job_timing_history" ? [{
    ...input, completedAt: "2026-08-16 00:00:10+00", queuedAt: "2026-08-16 00:00:00+00", startedAt: "2026-08-16 00:00:03+00", createdAt: "2026-08-16 00:00:10+00", effectiveConcurrency: "3",
  }] : []);
  const result = await listJobTimingHistory(db, "org-1");
  expect(result.items[0]).toMatchObject({ completedAt: "2026-08-16T00:00:10.000Z", queuedAt: "2026-08-16T00:00:00.000Z", startedAt: "2026-08-16T00:00:03.000Z", createdAt: "2026-08-16T00:00:10.000Z", effectiveConcurrency: 3 });
});

test("uses limit-plus-one timing history pagination", async () => {
  const db = preparedTestDatabase((name) => name === "job_timing_history" ? [
    { ...input, completedAt: "2026-08-16T00:00:10.000Z", effectiveConcurrency: "3" },
    { ...input, jobId: "job-2", completedAt: "2026-08-16T00:00:09.000Z", effectiveConcurrency: "4" },
  ] : []);
  const result = await listJobTimingHistory(db, "org-1", { limit: 1 });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.effectiveConcurrency).toBe(3);
  expect(result.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("normalizes timing aggregates", async () => {
  const db = preparedTestDatabase((name) => name === "job_timing_aggregates" ? [{ groupPlatform: "windows-x64", sampleCount: 2, minMs: "10", maxMs: "30", p50Ms: "20", p95Ms: "29" }] : []);
  await expect(getJobTimingAggregates(db, "org-1")).resolves.toEqual([{ group: { platform: "windows-x64" }, sampleCount: 2, minMs: 10, maxMs: 30, p50Ms: 20, p95Ms: 29 }]);
});
