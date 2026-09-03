import { describe, expect, test } from "bun:test";
import type { DatabaseClient } from "./index.ts";
import {
  JobResourceTrendInputError,
  decodeJobResourceCursor,
  decodeJobResourceKey,
  encodeJobResourceCursor,
  encodeJobResourceKey,
  listJobResourceTrends,
} from "./job-resource-trends.ts";

type RecordedCall = { sql: string; values: unknown[] };
type FakeDatabase = DatabaseClient & { calls: RecordedCall[] };

function fakeDatabase(resultSets: unknown[][]): FakeDatabase {
  const calls: RecordedCall[] = [];
  const execute = (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return Promise.resolve(resultSets.shift() ?? []);
  };
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => execute(strings.join("?"), values)) as unknown as FakeDatabase;
  db.unsafe = execute as FakeDatabase["unsafe"];
  db.calls = calls;
  return db;
}

const identity = { repositoryId: "repo-1", workflowName: "CI", jobName: "build" };
const validIdentity = { repositoryId: "00000000-0000-4000-8000-000000000001", workflowName: "CI", jobName: "build" };
const validIdentityTwo = { repositoryId: "00000000-0000-4000-8000-000000000002", workflowName: "CI", jobName: "build" };

const summaryRow = (overrides: Record<string, unknown> = {}) => ({
  repositoryId: "repo-1", repositoryName: "acme/one", workflowName: "CI", jobName: "build", platform: "windows-x64",
  runCount: "3", latestCompletedAt: "2026-09-03 12:00:00+00", latestRequestedVcpu: "2",
  latestRequestedMemoryBytes: "16384", latestEffectiveConcurrency: "3", medianExecutionDurationMs: "1200",
  cpuPeakPercent: "84.50", memoryPeakBytes: "4096", telemetryCoveredRunCount: "2",
  durationChangePercent: "20.5", cpuChangePercent: null, memoryChangePercent: "-10", ...overrides,
});

const pointRow = (ordinal: number, overrides: Record<string, unknown> = {}) => ({
  organizationId: "org-1", runId: `run-${ordinal}`, jobId: `job-${ordinal}`,
  completedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, ordinal)).toISOString(), outcome: "success",
  executionDurationMs: String(1000 + ordinal), cpuAveragePercent: "50.25", cpuPeakPercent: "75.50",
  memoryPeakBytes: "8192", requestedVcpu: "2", requestedMemoryBytes: "16384", effectiveConcurrency: "3",
  telemetryState: "available", telemetrySampleCount: "4", ...overrides,
});

const baseQuery = { from: "2026-08-27T00:00:00.000Z", to: "2026-09-03T13:00:00.000Z" };

describe("job resource key and cursor codecs", () => {
  test("round trips stable opaque job identities and cursors", () => {
    const jobKey = encodeJobResourceKey(identity);
    expect(jobKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeJobResourceKey(jobKey)).toEqual(identity);
    const cursor = encodeJobResourceCursor({ sortValue: "2026-09-03T12:00:00.000Z", jobKey });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeJobResourceCursor(cursor)).toEqual({ sortValue: "2026-09-03T12:00:00.000Z", jobKey });
  });

  test("returns null for malformed or structurally invalid encoded values", () => {
    expect(decodeJobResourceKey("not-json")).toBeNull();
    expect(decodeJobResourceKey(Buffer.from(JSON.stringify({ ...identity, extra: true })).toString("base64url"))).toBeNull();
    expect(decodeJobResourceCursor("not-json")).toBeNull();
    expect(decodeJobResourceCursor(Buffer.from(JSON.stringify({ sortValue: null, jobKey: "x" })).toString("base64url"))).toBeNull();
  });
});

describe("listJobResourceTrends", () => {
  test("rejects malformed client keys and cursors before issuing SQL", async () => {
    for (const query of [
      { ...baseQuery, jobKey: "not-json" },
      { ...baseQuery, cursor: "not-json" },
      { ...baseQuery, cursor: encodeJobResourceCursor({ sortValue: 1, jobKey: "not-a-job-key" }) },
    ]) {
      const db = fakeDatabase([]);
      await expect(listJobResourceTrends(db, "org-1", query)).rejects.toMatchObject({
        name: JobResourceTrendInputError.name,
        code: "invalid_resource_trend_query",
      });
      expect(db.calls).toHaveLength(0);
    }
  });

  test("rejects decoded non-UUID repository identities before issuing SQL", async () => {
    const nonUuidJobKey = encodeJobResourceKey(identity);
    const queries = [
      { ...baseQuery, jobKey: nonUuidJobKey },
      { ...baseQuery, sort: "duration" as const, cursor: encodeJobResourceCursor({ sortValue: 1, jobKey: nonUuidJobKey }) },
    ];
    for (const query of queries) {
      const db = fakeDatabase([]);
      await expect(listJobResourceTrends(db, "org-1", query)).rejects.toMatchObject({
        name: JobResourceTrendInputError.name,
        code: "invalid_resource_trend_query",
      });
      expect(db.calls).toHaveLength(0);
    }
  });

  test("rejects a point limit that cannot preserve both range endpoints", async () => {
    const db = fakeDatabase([]);

    await expect(listJobResourceTrends(db, "org-1", { ...baseQuery, pointLimit: 1 })).rejects.toMatchObject({
      name: JobResourceTrendInputError.name,
      code: "invalid_resource_trend_query",
    });
    expect(db.calls).toHaveLength(0);
  });

  test("normalizes filtered totals, facets, distinct identities, and selected points", async () => {
    const db = fakeDatabase([
      [{ jobCount: "2", completedRunCount: "5", medianExecutionDurationMs: "1100", telemetryCoveredRunCount: "3" }],
      [{ platforms: ["linux-x64", "windows-x64"], vcpus: ["2", "4"], concurrencies: ["1", "3"] }],
      [summaryRow(), summaryRow({ repositoryId: "repo-2", repositoryName: "acme/two", cpuPeakPercent: null, memoryPeakBytes: null })],
      [pointRow(2, { cpuAveragePercent: null, cpuPeakPercent: null, memoryPeakBytes: null }), pointRow(1)],
    ]);

    const result = await listJobResourceTrends(db, "org-1", {
      ...baseQuery, platform: "windows-x64", vcpu: 2, concurrency: 3, search: "build", limit: 2, pointLimit: 2,
    });

    expect(result.summary).toEqual({ jobCount: 2, completedRunCount: 5, medianExecutionDurationMs: 1100, telemetryCoveredRunCount: 3, telemetryCoveragePercent: 60 });
    expect(result.filters).toEqual({ platforms: ["linux-x64", "windows-x64"], vcpus: [2, 4], concurrencies: [1, 3] });
    expect(result.jobs.map(({ repositoryId, runCount, cpuPeakPercent, memoryPeakBytes }) => ({ repositoryId, runCount, cpuPeakPercent, memoryPeakBytes }))).toEqual([
      { repositoryId: "repo-1", runCount: 3, cpuPeakPercent: 84.5, memoryPeakBytes: 4096 },
      { repositoryId: "repo-2", runCount: 3, cpuPeakPercent: null, memoryPeakBytes: null },
    ]);
    expect(result.jobs[0]).toMatchObject({
      latestRequestedVcpu: 2,
      latestRequestedMemoryBytes: 16384,
      latestEffectiveConcurrency: 3,
      telemetryCoveragePercent: 2 / 3 * 100,
      durationChangePercent: 20.5,
      cpuChangePercent: null,
      memoryChangePercent: -10,
    });
    expect(result.selectedJob?.summary).toEqual(result.jobs[0]);
    expect(result.selectedJob?.points.map(point => point.completedAt)).toEqual(["2026-09-01T00:00:01.000Z", "2026-09-01T00:00:02.000Z"]);
    expect(result.selectedJob?.points[0]).toMatchObject({ executionDurationMs: 1001, requestedVcpu: 2, requestedMemoryBytes: 16384, effectiveConcurrency: 3, telemetrySampleCount: 4 });
    expect(result.selectedJob?.points[1]).toMatchObject({ cpuAveragePercent: null, cpuPeakPercent: null, memoryPeakBytes: null });
    expect(db.calls).toHaveLength(4);
    for (const call of db.calls) {
      expect(call.sql).toContain("organization_id=");
      expect(call.sql).toContain("completed_at >=");
      expect(call.sql).toContain("completed_at <");
      expect(call.sql).toContain("requested_vcpu=");
      expect(call.sql).toContain("effective_concurrency=");
      expect(call.sql).toContain("ILIKE");
    }
  });

  test("uses deterministic limit-plus-one pagination and an opaque cursor", async () => {
    const db = fakeDatabase([
      [{ jobCount: "2", completedRunCount: "4", medianExecutionDurationMs: "1000", telemetryCoveredRunCount: "0" }],
      [{ platforms: [], vcpus: [], concurrencies: [] }],
      [summaryRow(), summaryRow({ repositoryId: "repo-2", repositoryName: "acme/two" })],
      [],
    ]);
    const result = await listJobResourceTrends(db, "org-1", { ...baseQuery, sort: "duration", limit: 1 });
    expect(result.jobs).toHaveLength(1);
    expect(decodeJobResourceCursor(result.nextCursor!)).toEqual({ sortValue: 1200, jobKey: encodeJobResourceKey(identity) });
    expect(db.calls[2]?.values).toContain(2);
    expect(db.calls[2]?.sql).toContain("repository_id, workflow_name, job_name");
    expect(db.calls[2]?.sql).toContain("$10::uuid");
    expect(db.calls[2]?.values[9]).toBe("00000000-0000-0000-0000-000000000000");
  });

  test("falls back to the first summary when a valid selected identity is filtered out", async () => {
    const db = fakeDatabase([
      [{ jobCount: "1", completedRunCount: "1", medianExecutionDurationMs: "1000", telemetryCoveredRunCount: "1" }],
      [{ platforms: ["windows-x64"], vcpus: ["2"], concurrencies: ["1"] }],
      [summaryRow({ repositoryId: validIdentity.repositoryId })], [], [pointRow(1)],
    ]);
    const result = await listJobResourceTrends(db, "org-1", { ...baseQuery, jobKey: encodeJobResourceKey(validIdentityTwo) });
    expect(result.selectedJob).toEqual({
      summary: expect.objectContaining({ jobKey: encodeJobResourceKey(validIdentity), repositoryId: validIdentity.repositoryId }),
      points: [expect.objectContaining({ jobId: "job-1" })],
    });
    expect(db.calls).toHaveLength(5);
  });

  test("loads a requested filtered identity when the summary page is empty", async () => {
    const requestedKey = encodeJobResourceKey(validIdentityTwo);
    const db = fakeDatabase([
      [{ jobCount: "1", completedRunCount: "1", medianExecutionDurationMs: "1000", telemetryCoveredRunCount: "1" }],
      [{ platforms: ["windows-x64"], vcpus: ["2"], concurrencies: ["1"] }],
      [],
      [summaryRow({ repositoryId: validIdentityTwo.repositoryId, repositoryName: "acme/two" })],
      [pointRow(1)],
    ]);
    const result = await listJobResourceTrends(db, "org-1", { ...baseQuery, jobKey: requestedKey });
    expect(result.selectedJob).toEqual({
      summary: expect.objectContaining({ jobKey: requestedKey, repositoryId: validIdentityTwo.repositoryId }),
      points: [expect.objectContaining({ jobId: "job-1" })],
    });
    expect(db.calls).toHaveLength(5);
  });

  for (const total of [0, 1, 2, 201, 1000]) {
    test(`uses bounded representative SQL sampling for ${total} input rows`, async () => {
      const limit = 100;
      const sampled = total <= limit
        ? Array.from({ length: total }, (_, index) => pointRow(index + 1))
        : Array.from({ length: limit }, (_, index) => pointRow(Math.round(1 + index * (total - 1) / (limit - 1))));
      const db = fakeDatabase([
        [{ jobCount: "1", completedRunCount: String(total), medianExecutionDurationMs: total ? "1000" : "0", telemetryCoveredRunCount: "0" }],
        [{ platforms: [], vcpus: [], concurrencies: [] }],
        [summaryRow({ runCount: String(Math.max(total, 1)) })], sampled,
      ]);
      const result = await listJobResourceTrends(db, "org-1", { ...baseQuery, pointLimit: limit });
      const points = result.selectedJob?.points ?? [];
      expect(points.length).toBeLessThanOrEqual(limit);
      if (total > 0) {
        expect(points[0]?.jobId).toBe("job-1");
        expect(points.at(-1)?.jobId).toBe(`job-${total}`);
      }
      const pointSql = db.calls[3]?.sql ?? "";
      expect(pointSql).toContain("row_number() OVER (ORDER BY completed_at, job_id)");
      expect(pointSql).toContain("count(*) OVER ()");
      expect(pointSql).toContain("round(1 + (target_index - 1) * (total - 1)::numeric");
      expect(pointSql).toContain('ORDER BY ordered."completedAt", ordered."jobId"');
      expect(pointSql).not.toContain("AS generated(target_index) ON true");
      expect(pointSql).toContain("LIMIT");
    });
  }
});
