import type { JobResourceSample, JobResourceTrendJob, JobResourceTrendResponse } from "@mars/contracts";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultTimingFilters } from "./timing-model.ts";
import {
  flattenJobResourceSamplePages,
  jobResourceSampleOrganizationId,
  jobResourceSamplesQueryOptions,
  jobResourceTrendQueryOptions,
  ResourceHistoryEmptyState,
  ResourceHistoryHeader,
  resourceHistoryJobsWithSelectedSummary,
  resourceHistoryDisplayedDetail,
  resourceHistoryPageState,
  resourceHistoryRefreshError,
  resourceHistoryToolbarFacets,
  resourceHistoryViewAfterResponses,
  resourceSampleElapsedMs,
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
const sample: JobResourceSample = {
  organizationId: "org-1",
  runId: "run-1",
  jobId: "job-1",
  leaseId: "lease-1",
  occurredAt: "2026-09-03T11:59:30.000Z",
  cpuUsagePercent: 42,
  cpuTimeMs: 1_000,
  memoryWorkingSetBytes: 2_000,
  memoryLimitBytes: 4_000,
};

function trendPage(job: JobResourceTrendJob): JobResourceTrendResponse {
  return {
    summary: {
      jobCount: 1,
      completedRunCount: 1,
      medianExecutionDurationMs: 60_000,
      telemetryCoveredRunCount: 1,
      telemetryCoveragePercent: 100,
    },
    jobs: [job],
    nextCursor: null,
    selectedJob: { summary: job, points: [] },
    filters: { platforms: [job.platform], vcpus: [job.latestRequestedVcpu], concurrencies: [job.latestEffectiveConcurrency] },
    generatedAt: now.toISOString(),
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

test("selected-run samples query is disabled until both run and job are selected", () => {
  expect(jobResourceSamplesQueryOptions("org-1", null, null).enabled).toBe(false);
  expect(jobResourceSamplesQueryOptions("org-1", "run-1", "job-1").enabled).toBe(true);
  expect(jobResourceSamplesQueryOptions("org-1", "run-1", "job-1").queryKey).toEqual([
    "org", "org-1", "job-resource-samples", "run-1", "job-1",
  ]);
});

test("sample pages flatten chronologically and preserve elapsed origin", () => {
  const later = { ...sample, occurredAt: "2026-09-03T11:59:50.000Z" };
  const pages = [
    { items: [sample], nextCursor: "next" },
    { items: [later], nextCursor: null },
  ];
  expect(flattenJobResourceSamplePages(pages).map((item) => item.occurredAt)).toEqual([
    sample.occurredAt, later.occurredAt,
  ]);
  expect(resourceSampleElapsedMs(sample, "2026-09-03T12:00:00.000Z", 60_000)).toBe(30_000);
});

test("sample requests use the selected point organization in the all-organizations view", () => {
  expect(jobResourceSampleOrganizationId("all", {
    organizationId: "org-real",
  })).toBe("org-real");
  expect(jobResourceSampleOrganizationId("org-real", null)).toBe("org-real");
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

test("commits summary and selected detail only from one request generation", () => {
  const first = trendJob("job-one");
  const second = { ...trendJob("job-two"), repositoryName: "acme/service" };
  const oldPage = trendPage(first);
  const nextPage = trendPage(second);
  const current = {
    organizationId: "org-1",
    generation: "old",
    pages: [oldPage],
    selectedJob: oldPage.selectedJob,
    filters: defaultTimingFilters,
  };
  const base = {
    organizationId: "org-1",
    generation: "new",
    pages: [nextPage],
    selectedJobKey: "job-two",
    detailResponse: nextPage,
    filters: { ...defaultTimingFilters, platform: "windows-x64" },
  };

  expect(resourceHistoryViewAfterResponses(current, { ...base, summaryPlaceholder: true, detailPlaceholder: false })).toBe(current);
  expect(resourceHistoryViewAfterResponses(current, { ...base, summaryPlaceholder: false, detailPlaceholder: true })).toBe(current);
  expect(resourceHistoryViewAfterResponses(current, { ...base, summaryPlaceholder: false, detailPlaceholder: false })).toMatchObject({
    generation: "new",
    selectedJob: { summary: { jobKey: "job-two" } },
  });
  const sameGeneration = { ...current, generation: "same" };
  expect(resourceHistoryViewAfterResponses(sameGeneration, {
    ...base,
    generation: "same",
    pages: [oldPage, nextPage],
    detailResponse: undefined,
    summaryPlaceholder: false,
    detailPlaceholder: false,
  })).toMatchObject({
    pages: [{ jobs: [{ jobKey: "job-one" }] }, { jobs: [{ jobKey: "job-two" }] }],
    selectedJob: { summary: { jobKey: "job-one" } },
  });
  expect(resourceHistoryViewAfterResponses(current, { ...base, organizationId: "org-2", summaryPlaceholder: true, detailPlaceholder: true })).toBeNull();
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
