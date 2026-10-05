import { describe, expect, test } from "bun:test";
import { preparedTestDatabase } from "./prepared-test-fixture.ts";
import {
  buildOptimizedLabels,
  getJobLabelRecommendation,
  recommendResourceLabels,
  selectRoutingLabel,
} from "./job-label-recommendations.ts";
import { JobLabelRecommendation, JobLabelRecommendationQuery } from "@mars/contracts";

function fakeDatabase(rows: unknown[]) {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const db = preparedTestDatabase((name, parameters) => {
    calls.push({ name, parameters });
    return rows;
  });
  return { db, calls };
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

  test("replaces only the selected composite alternative", () => {
    expect(buildOptimizedLabels([
      "mars-windows-x64-8vcpu-16g",
      "mars-macos-arm64-2vcpu-4g",
      "mars-linux-x64-4vcpu-8g",
    ], 4, 8, "mars-windows-x64-8vcpu-16g")).toEqual([
      "mars-windows-x64-4vcpu-8g",
      "mars-macos-arm64-2vcpu-4g",
      "mars-linux-x64-4vcpu-8g",
    ]);
  });
  test("selects exact platform before neutral alternatives", () => {
    expect(selectRoutingLabel([
      "mars-any-4vcpu-10g",
      "mars-any-x64-4vcpu-12g",
      "mars-windows-x64-8vcpu-16g",
    ], "windows-x64")?.original).toBe("mars-windows-x64-8vcpu-16g");
  });
  test("recognizes versioned Ubuntu routes as Linux x64 routing labels", () => {
    for (const version of ["22", "24", "26"]) {
      expect(selectRoutingLabel(["mars-any-x64-2vcpu-4g", `mars-ubuntu-${version}-4vcpu-8g`], "linux-x64")?.route).toBe(`mars-ubuntu-${version}`);
      expect(selectRoutingLabel([`mars-ubuntu-${version}-4vcpu-8g`], "windows-x64")).toBeNull();
    }
  });
});

describe("getJobLabelRecommendation", () => {
  test("normalizes persisted telemetry and recommends resources for the current platform", async () => {
    const { db } = fakeDatabase([{
      currentLabels: ["mars-windows-x64-8vcpu-16g", "mars-macos-arm64-2vcpu-4g"],
      currentPlatform: "windows-x64",
      successfulRunCount: "8",
      coveredRunCount: "8",
      p95CpuPeakPercent: "201.00",
      p95MemoryPeakBytes: "5368709120.6",
    }]);
    const result = await getJobLabelRecommendation(db, "org-1", query, "user-1");
    expect(result).toMatchObject({
      status: "available",
      currentRoutingLabel: "mars-windows-x64-8vcpu-16g",
      currentPlatform: "windows-x64",
      recommendedVcpu: 3,
      recommendedMemoryGiB: 7,
      p95CpuPeakPercent: 201,
      p95MemoryPeakBytes: 5368709121,
      successfulRunCount: 8,
      telemetryCoveragePercent: 100,
      reason: null,
    });
  });

  test("returns unavailable when sample coverage is below the established threshold", async () => {
    const { db } = fakeDatabase([{
      currentLabels: ["mars-windows-x64-4vcpu-8g"],
      currentPlatform: "windows-x64",
      successfulRunCount: "8",
      coveredRunCount: "6",
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

  test("returns a neutral result when the scoped query has no samples", async () => {
    const { db } = fakeDatabase([]);
    expect(await getJobLabelRecommendation(db, "org-1", query)).toMatchObject({
      status: "unavailable",
      currentLabels: [],
      successfulRunCount: 0,
      telemetryCoveragePercent: 0,
      reason: "insufficient_history",
    });
  });
});

test("recommendation contracts are strict and represent multi-core CPU percentiles", () => {
  const value = {
    status: "available" as const,
    currentLabels: ["mars-windows-x64-8vcpu-16g"],
    currentRoutingLabel: "mars-windows-x64-8vcpu-16g",
    currentPlatform: "windows-x64",
    workflowPath: null,
    workflowJobId: null,
    recommendedVcpu: 3,
    recommendedMemoryGiB: 7,
    p95CpuPeakPercent: 201,
    p95MemoryPeakBytes: 5368709120,
    successfulRunCount: 8,
    telemetryCoveragePercent: 100,
    reason: null,
  };
  expect(JobLabelRecommendation.parse(value)).toEqual(value);
  expect(() => JobLabelRecommendationQuery.parse({ ...query, extra: true })).toThrow();
  expect(() => JobLabelRecommendation.parse({ ...value, extra: true })).toThrow();
});
