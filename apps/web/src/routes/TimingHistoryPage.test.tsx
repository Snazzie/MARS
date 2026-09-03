import { expect, test } from "bun:test";
import { defaultTimingFilters } from "./timing-model.ts";
import { jobResourceTrendQueryOptions, resourceHistoryPageState, resourceHistoryRefreshError } from "./TimingHistoryPage.tsx";

const now = new Date("2026-09-03T12:00:00.000Z");

test("resource history defaults to a seven-day bounded request", () => {
  const options = jobResourceTrendQueryOptions("org-1", defaultTimingFilters, null, now);

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
      jobKey: null,
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
  }, "repo-ci-build", now);

  expect(options.queryKey.at(-1)).toEqual({
    from: "2026-08-04T12:00:00.000Z",
    to: "2026-09-03T12:00:00.000Z",
    platform: "windows-x64",
    vcpu: 4,
    concurrency: 3,
    search: "nightly build",
    sort: "memory",
    jobKey: "repo-ci-build",
  });
});

test("resource history preserves prior pages while a changed request refreshes", () => {
  const options = jobResourceTrendQueryOptions("org-1", defaultTimingFilters, null, now);
  const prior = { pages: [], pageParams: [] } as Parameters<typeof options.placeholderData>[0];

  expect(options.placeholderData(prior)).toBe(prior);
});

test("resource history query identity changes with the selected job", () => {
  const first = jobResourceTrendQueryOptions("org-1", defaultTimingFilters, "job-one", now);
  const second = jobResourceTrendQueryOptions("org-1", defaultTimingFilters, "job-two", now);

  expect(first.queryKey).not.toEqual(second.queryKey);
  expect(first.queryKey.at(-1)).toMatchObject({ jobKey: "job-one" });
  expect(second.queryKey.at(-1)).toMatchObject({ jobKey: "job-two" });
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
