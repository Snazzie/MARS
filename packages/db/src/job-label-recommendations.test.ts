import { describe, expect, test } from "bun:test";
import type { DatabaseClient } from "./index.ts";
import {
  buildOptimizedLabels,
  getJobLabelRecommendation,
  parseCurrentResourceLabels,
  recommendResourceLabels,
} from "./job-label-recommendations.ts";
import { JobLabelRecommendation, JobLabelRecommendationQuery } from "@mars/contracts";

type RecordedCall = { sql: string; values: unknown[] };
type FakeDatabase = DatabaseClient & { calls: RecordedCall[] };

function fakeDatabase(rows: unknown[]): FakeDatabase {
  const calls: RecordedCall[] = [];
  const execute = (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return Promise.resolve(rows);
  };
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => execute(strings.join("?"), values)) as unknown as FakeDatabase;
  db.unsafe = execute as FakeDatabase["unsafe"];
  db.calls = calls;
  return db;
}

const query = {
  from: "2026-08-27T00:00:00.000Z",
  to: "2026-09-03T13:00:00.000Z",
  repositoryId: "00000000-0000-4000-8000-000000000001",
  workflowName: "CI",
  jobName: "build",
};

describe("resource label recommendation policy", () => {
  test("rounds p95 demand with the fixed safety factor", () => {
    expect(recommendResourceLabels({ cpuP95: 201, memoryP95Bytes: 5 * 1024 ** 3, successfulRuns: 8, coveredRuns: 8 })).toMatchObject({ vcpu: 3, memoryGiB: 7 });
  });

  test("rejects insufficient history or telemetry", () => {
    expect(recommendResourceLabels({ cpuP95: 10, memoryP95Bytes: 1, successfulRuns: 4, coveredRuns: 4 }).status).toBe("unavailable");
    expect(recommendResourceLabels({ cpuP95: 10, memoryP95Bytes: 1, successfulRuns: 10, coveredRuns: 7 }).status).toBe("unavailable");
  });

  test("keeps a valid current numeric label when its metric is missing", () => {
    expect(recommendResourceLabels({ cpuP95: null, memoryP95Bytes: 5 * 1024 ** 3, successfulRuns: 8, coveredRuns: 8, currentVcpu: 4 })).toMatchObject({ status: "available", vcpu: 4, memoryGiB: 7 });
    expect(recommendResourceLabels({ cpuP95: 201, memoryP95Bytes: null, successfulRuns: 8, coveredRuns: 8, currentMemoryGiB: 8 })).toMatchObject({ status: "available", vcpu: 3, memoryGiB: 8 });
  });

  test("does not invent a value for missing metrics", () => {
    expect(recommendResourceLabels({ cpuP95: null, memoryP95Bytes: 1, successfulRuns: 8, coveredRuns: 8 }).status).toBe("unavailable");
    expect(recommendResourceLabels({ cpuP95: 10, memoryP95Bytes: null, successfulRuns: 8, coveredRuns: 8 }).status).toBe("unavailable");
  });

  test("never replaces the Windows routing label", () => {
    expect(buildOptimizedLabels(["mars-windows-x64", "8VCPU", "16G"], 4, 8)).toEqual(["mars-windows-x64", "4VCPU", "8G"]);
  });
  test("selects the composite Windows routing label over generic platform labels", () => {
    expect(parseCurrentResourceLabels(["self-hosted", "windows", "x64", "mars-windows-x64", "8VCPU", "16G"])).toEqual({
      windowsLabel: "mars-windows-x64",
      vcpu: 8,
      memoryGiB: 16,
    });
  });
});

describe("getJobLabelRecommendation", () => {
  test("normalizes SQL numerics and scopes successful selected snapshots", async () => {
    const db = fakeDatabase([{
      currentLabels: '["mars-windows-x64","8VCPU","16G"]',
      successfulRunCount: "8",
      coveredRunCount: "8",
      telemetryCoveragePercent: "100.00",
      p95CpuPeakPercent: "201.00",
      p95MemoryPeakBytes: "5368709120.6",
    }]);

    const result = await getJobLabelRecommendation(db, "org-1", query, "user-1");

    expect(result).toMatchObject({
      status: "available",
      currentWindowsLabel: "mars-windows-x64",
      recommendedVcpu: 3,
      recommendedMemoryGiB: 7,
      p95CpuPeakPercent: 201,
      p95MemoryPeakBytes: 5368709121,
      successfulRunCount: 8,
      telemetryCoveragePercent: 100,
      reason: null,
    });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toContain("successful AS");
    expect(db.calls[0]?.sql).toContain("LEFT JOIN scoped latest");
    expect(db.calls[0]?.sql).toContain("round(");
    expect(db.calls[0]?.sql).toContain("FROM dashboard_job_timing_snapshots");
    expect(db.calls[0]?.sql).toContain("outcome='success'");
    expect(db.calls[0]?.sql).toContain("percentile_cont(0.95)");
    expect(db.calls[0]?.sql).toContain("memberships");
    expect(db.calls[0]?.values).toEqual(["org-1", query.from, query.to, query.repositoryId, query.workflowName, query.jobName, "user-1"]);
  });

  test("returns an unavailable response without treating missing telemetry as zero", async () => {
    const db = fakeDatabase([{
      currentLabels: ["mars-windows-x64", "4VCPU", "8G"],
      successfulRunCount: "8",
      coveredRunCount: "6",
      telemetryCoveragePercent: "75",
      p95CpuPeakPercent: null,
      p95MemoryPeakBytes: null,
    }]);
    const result = await getJobLabelRecommendation(db, "org-1", query);
    expect(result.status).toBe("unavailable");
    expect(result.p95CpuPeakPercent).toBeNull();
    expect(result.p95MemoryPeakBytes).toBeNull();
    expect(result.recommendedVcpu).toBeNull();
    expect(result.recommendedMemoryGiB).toBeNull();
  });
});

test("recommendation contracts are strict and represent multi-core CPU percentiles", () => {
  const value = {
    status: "available",
    currentWindowsLabel: "mars-windows-x64",
    recommendedVcpu: 3,
    recommendedMemoryGiB: 7,
    p95CpuPeakPercent: 201,
    p95MemoryPeakBytes: 5368709120,
    successfulRunCount: 8,
    telemetryCoveragePercent: 100,
    reason: null,
  } as const;
  expect(JobLabelRecommendation.parse(value)).toEqual(value);
  expect(() => JobLabelRecommendationQuery.parse({ ...query, extra: true })).toThrow();
  expect(() => JobLabelRecommendation.parse({ ...value, extra: true })).toThrow();
});
