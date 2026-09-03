import { expect, test } from "bun:test";
import type { JobResourceTrendJob } from "@mars/contracts";
import { ApiRequestError, buildJobResourceTrendsUrl, getJobResourceTrends } from "../api.ts";
import {
  defaultTimingFilters,
  formatBytes,
  formatDate,
  formatDeltaPercent,
  formatDuration,
  formatPercent,
  selectionAfterJobsChange,
  timingRangeBounds,
} from "./timing-model.ts";

const fixedNow = new Date("2026-09-03T12:00:00.000Z");

test("derives exact bounds for every supported range", () => {
  expect(timingRangeBounds("24h", fixedNow)).toEqual({
    from: "2026-09-02T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
  });
  expect(timingRangeBounds("7d", fixedNow)).toEqual({
    from: "2026-08-27T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
  });
  expect(timingRangeBounds("30d", fixedNow)).toEqual({
    from: "2026-08-04T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
  });
  expect(timingRangeBounds("90d", fixedNow)).toEqual({
    from: "2026-06-05T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
  });
});

test("provides the seven-day default filter set", () => {
  expect(defaultTimingFilters).toEqual({
    range: "7d",
    platform: "",
    vcpu: "",
    concurrency: "",
    search: "",
    sort: "latest",
  });
});

test("formats durations without exposing milliseconds", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(1_000)).toBe("1s");
  expect(formatDuration(59_000)).toBe("59s");
  expect(formatDuration(59_999)).toBe("59s");
  expect(formatDuration(60_000)).toBe("1m 0s");
  expect(formatDuration(61_000)).toBe("1m 1s");
  expect(formatDuration(3_599_000)).toBe("59m 59s");
  expect(formatDuration(3_599_999)).toBe("59m 59s");
  expect(formatDuration(3_600_000)).toBe("1h 0m");
  expect(formatDuration(7_260_000)).toBe("2h 1m");
});

test("formats byte values at explicit IEC boundaries", () => {
  expect(formatBytes(null)).toBe("Unavailable");
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1_023)).toBe("1,023 B");
  expect(formatBytes(1_024)).toBe("1.0 KiB");
  expect(formatBytes(1_536)).toBe("1.5 KiB");
  expect(formatBytes(1_024 ** 2)).toBe("1.0 MiB");
  expect(formatBytes(1_024 ** 3)).toBe("1.0 GiB");
  expect(formatBytes(1_024 ** 4)).toBe("1.0 TiB");
});

test("formats percentages, deltas, and dates for people", () => {
  expect(formatPercent(null)).toBe("Unavailable");
  expect(formatPercent(84.5)).toBe("84.5%");
  expect(formatPercent(84.56, 2)).toBe("84.56%");
  expect(formatDeltaPercent(null)).toBe("Unavailable");
  expect(formatDeltaPercent(12.34)).toBe("+12.3%");
  expect(formatDeltaPercent(-4.56)).toBe("-4.6%");
  expect(formatDeltaPercent(0)).toBe("0.0%");
  expect(formatDeltaPercent(-0)).toBe("0.0%");
  expect(formatDeltaPercent(-0.01)).toBe("0.0%");
  expect(formatDate("2026-09-03T12:00:00.000Z")).toBe("Sep 3, 2026, 12:00 PM UTC");
});

test("uses truncated precision when normalizing negative zero", () => {
  expect(formatDeltaPercent(-0.04, 1.5)).toBe("0.0%");
});

test("uses clamped minimum precision when normalizing delta signs", () => {
  expect(formatDeltaPercent(1, -1)).toBe("+1%");
});

test("uses clamped maximum precision when normalizing negative zero", () => {
  expect(formatDeltaPercent(-4e-21, 21)).toBe("0.00000000000000000000%");
});

test("preserves selection until filters remove it", () => {
  const jobs = [{ jobKey: "first" }, { jobKey: "second" }] as JobResourceTrendJob[];
  expect(selectionAfterJobsChange("second", jobs)).toBe("second");
  expect(selectionAfterJobsChange("missing", jobs)).toBe("first");
  expect(selectionAfterJobsChange(null, jobs)).toBe("first");
  expect(selectionAfterJobsChange("missing", [])).toBeNull();
});

test("builds a complete trends URL while omitting empty filters", () => {
  expect(buildJobResourceTrendsUrl("org-1", {
    from: "2026-08-27T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
    platform: "windows-x64",
    vcpu: 4,
    concurrency: 2,
    search: "build & test",
    sort: "memory",
    cursor: "next_page",
    limit: 25,
    jobKey: "selected_job",
    pointLimit: 75,
  })).toBe("/api/organizations/org-1/job-resource-trends?from=2026-08-27T12%3A00%3A00.000Z&to=2026-09-03T12%3A00%3A00.000Z&platform=windows-x64&vcpu=4&concurrency=2&search=build+%26+test&sort=memory&cursor=next_page&limit=25&jobKey=selected_job&pointLimit=75");

  expect(buildJobResourceTrendsUrl("org-1", {
    from: "2026-08-27T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
    platform: "",
    search: "",
    cursor: null,
    jobKey: null,
  })).toBe("/api/organizations/org-1/job-resource-trends?from=2026-08-27T12%3A00%3A00.000Z&to=2026-09-03T12%3A00%3A00.000Z");
});

test("rejects a trend point limit that cannot preserve earliest and latest runs", () => {
  expect(() => buildJobResourceTrendsUrl("org-1", {
    from: "2026-08-27T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
    pointLimit: 1,
  })).toThrow("pointLimit must be between 2 and 200");
});

test("validates trend responses through the shared contract", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 })) as unknown as typeof fetch;
  let rejection: unknown;
  try {
    await getJobResourceTrends("org-1", {
      from: "2026-08-27T12:00:00.000Z",
      to: "2026-09-03T12:00:00.000Z",
    });
  } catch (error) {
    rejection = error;
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(rejection).toBeInstanceOf(ApiRequestError);
  expect(rejection).toMatchObject({ status: 200, code: "invalid_response" });
});
