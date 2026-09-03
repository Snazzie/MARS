import type { JobResourceTrendJob, JobResourceTrendResponse } from "@mars/contracts";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultTimingFilters } from "./timing-model.ts";
import {
  jobResourceTrendQueryOptions,
  ResourceHistoryEmptyState,
  ResourceHistoryHeader,
  resourceHistoryJobsWithSelectedSummary,
  resourceHistoryDisplayedDetail,
  resourceHistoryPageState,
  resourceHistoryRefreshError,
  resourceHistoryToolbarFacets,
  selectedJobResourceTrendQueryOptions,
} from "./TimingHistoryPage.tsx";

const now = new Date("2026-09-03T12:00:00.000Z");

function trendJob(jobKey: string): JobResourceTrendJob {
  return {
    jobKey,
    repositoryId: "11111111-1111-4111-8111-111111111111",
    repositoryName: "acme/app",
    workflowName: "CI",
    jobName: "build",
    platform: "windows-x64",
    runCount: 1,
    latestCompletedAt: now.toISOString(),
    latestRequestedVcpu: 4,
    latestRequestedMemoryBytes: 4_294_967_296,
    latestEffectiveConcurrency: 2,
    medianExecutionDurationMs: 60_000,
    cpuPeakPercent: 50,
    memoryPeakBytes: 1_073_741_824,
    telemetryCoveredRunCount: 1,
    telemetryCoveragePercent: 100,
    durationChangePercent: null,
    cpuChangePercent: null,
    memoryChangePercent: null,
  };
}

test("resource history defaults to a seven-day bounded request", () => {
  const options = jobResourceTrendQueryOptions("org-1", defaultTimingFilters, now);

  expect(options.queryKey).toEqual([
    "org",
    "org-1",
    "job-resource-trends",
    {
      from: "2026-08-27T12:00:00.000Z",
      to: "2026-09-03T12:00:00.000Z",
      platform: undefined,
      vcpu: undefined,
      concurrency: undefined,
      search: undefined,
      sort: "latest",
    },
  ]);
  expect(options.queryFn).toBeFunction();
  expect(options.placeholderData).toBeFunction();
  expect(options.initialPageParam).toBeNull();
});

test("resource history query includes every active filter", () => {
  const options = jobResourceTrendQueryOptions("org-1", {
    range: "30d",
    platform: "windows-x64",
    vcpu: "4",
    concurrency: "3",
    search: "nightly build",
    sort: "memory",
  }, now);

  expect(options.queryKey.at(-1)).toEqual({
    from: "2026-08-04T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
    platform: "windows-x64",
    vcpu: 4,
    concurrency: 3,
    search: "nightly build",
    sort: "memory",
  });
});

test("resource history preserves prior pages while a changed request refreshes", () => {
  const options = jobResourceTrendQueryOptions("org-1", defaultTimingFilters, now);
  const prior = { pages: [], pageParams: [] } as Parameters<typeof options.placeholderData>[0];

  expect(options.placeholderData(prior, { queryKey: ["org", "org-1", "job-resource-trends"] } as never)).toBe(prior);
});

test("resource history never carries placeholder pages across organizations", () => {
  const options = jobResourceTrendQueryOptions("org-2", defaultTimingFilters, now);
  const prior = { pages: [], pageParams: [] } as Parameters<typeof options.placeholderData>[0];

  expect(options.placeholderData(prior, { queryKey: ["org", "org-1", "job-resource-trends"] } as never)).toBeUndefined();
});

test("summary pagination is independent from selected detail while detail requests retain the job key", () => {
  const summaryOptions = jobResourceTrendQueryOptions("org-1", defaultTimingFilters, now);
  const first = selectedJobResourceTrendQueryOptions("org-1", defaultTimingFilters, "job-one", now);
  const second = selectedJobResourceTrendQueryOptions("org-1", defaultTimingFilters, "job-two", now);

  expect(summaryOptions.queryKey.at(-1)).not.toHaveProperty("jobKey");
  expect(first.queryKey).not.toEqual(second.queryKey);
  expect(first.queryKey.at(-1)).toMatchObject({ jobKey: "job-one" });
  expect(second.queryKey.at(-1)).toMatchObject({ jobKey: "job-two" });
  expect(first.placeholderData).toBeFunction();
});

test("page state distinguishes an empty history from filters with no matches", () => {
  expect(resourceHistoryPageState(0, defaultTimingFilters)).toBe("empty");
  expect(resourceHistoryPageState(0, { ...defaultTimingFilters, search: "missing job" })).toBe("no-match");
  expect(resourceHistoryPageState(2, { ...defaultTimingFilters, search: "missing job" })).toBe("ready");
});

test("failed background attempts surface an error without discarding established data", () => {
  const failure = new Error("Temporary failure");

  expect(resourceHistoryRefreshError(true, null, failure)).toBe(failure);
  expect(resourceHistoryRefreshError(true, failure, null)).toBe(failure);
  expect(resourceHistoryRefreshError(false, failure, failure)).toBeNull();
});

test("keeps list selection and rendered detail consistent through pending, error, and filter replacement", () => {
  const first = trendJob("job-one");
  const second = { ...trendJob("job-two"), repositoryName: "acme/service" };
  const firstDetail = { summary: first, points: [] };
  const secondDetail = { summary: second, points: [] };

  expect(resourceHistoryDisplayedDetail([first, second], firstDetail, null, "job-two")).toBe(firstDetail);
  expect(resourceHistoryDisplayedDetail([first, second], firstDetail, secondDetail, "job-two")).toBe(secondDetail);
  const refreshedJobs = resourceHistoryJobsWithSelectedSummary([first], secondDetail);
  expect(refreshedJobs.map((job) => job.jobKey)).toEqual(["job-two", "job-one"]);
  expect(resourceHistoryDisplayedDetail(refreshedJobs, firstDetail, secondDetail, "job-two")).toBe(secondDetail);
});

test("no-match facets retain active controlled filter options", () => {
  const empty: JobResourceTrendResponse["filters"] = { platforms: [], vcpus: [], concurrencies: [] };
  const filters = { ...defaultTimingFilters, platform: "windows-x64", vcpu: "4", concurrency: "3" };

  expect(resourceHistoryToolbarFacets(empty, filters)).toEqual({
    platforms: ["windows-x64"],
    vcpus: [4],
    concurrencies: [3],
  });
});

test("renders the approved resource header, disclosure, sampled-peak caveat, and completed-job empty guidance", () => {
  const header = renderToStaticMarkup(<ResourceHistoryHeader />);
  const empty = renderToStaticMarkup(<ResourceHistoryEmptyState />);

  expect(header).toContain("<h1>Resource history</h1>");
  expect(header).toContain("CPU, memory, and execution time for completed jobs.");
  expect(header).toContain("About these metrics");
  expect(header).toContain("Resource values are sampled.");
  expect(header).toContain("Peaks are the highest observed samples, not exact process-level peaks.");
  expect(header).toContain("Missing telemetry is not treated as zero.");
  expect(empty).toContain("No completed job history yet");
  expect(empty).toContain("Records appear after completed jobs provide timing data.");
  expect(empty).not.toContain("first resource is connected");
});
