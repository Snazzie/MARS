import type { JobResourceTrendResponse } from "@mars/contracts";
import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getJobResourceTrends } from "../api.ts";
import { JobResourceDetail } from "../components/JobResourceDetail.tsx";
import { JobResourceList } from "../components/JobResourceList.tsx";
import { QueryState, StateView } from "../components/StateView.tsx";
import { TimingSummary } from "../components/TimingSummary.tsx";
import { TimingToolbar } from "../components/TimingToolbar.tsx";
import { defaultTimingFilters, timingRangeBounds, type TimingFilters } from "./timing-model.ts";
import { useOrganizationFromRoute } from "./useOrganization.ts";

type ResourceTrendPage = JobResourceTrendResponse;
type SelectedResourceTrend = NonNullable<ResourceTrendPage["selectedJob"]>;
type ResourceHistoryPageState = "ready" | "empty" | "no-match";

const emptyFacets: ResourceTrendPage["filters"] = {
  platforms: [],
  vcpus: [],
  concurrencies: [],
};

function resourceTrendRequest(filters: TimingFilters, now: Date) {
  return {
    ...timingRangeBounds(filters.range, now),
    platform: filters.platform || undefined,
    vcpu: filters.vcpu ? Number(filters.vcpu) : undefined,
    concurrency: filters.concurrency ? Number(filters.concurrency) : undefined,
    search: filters.search.trim() || undefined,
    sort: filters.sort,
  };
}

export function jobResourceTrendQueryOptions(
  organizationId: string,
  filters: TimingFilters,
  now: Date = new Date(),
) {
  const request = resourceTrendRequest(filters, now);
  return {
    queryKey: ["org", organizationId, "job-resource-trends", request] as const,
    queryFn: ({ pageParam }: { pageParam: string | null }) => getJobResourceTrends(organizationId, {
      ...request,
      cursor: pageParam,
      limit: 30,
      pointLimit: 100,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (page: ResourceTrendPage) => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId),
    placeholderData: (
      previous: InfiniteData<ResourceTrendPage, string | null> | undefined,
      previousQuery: { queryKey: readonly unknown[] } | undefined,
    ) => previousQuery?.queryKey[0] === "org" && previousQuery.queryKey[1] === organizationId ? previous : undefined,
  };
}

export function selectedJobResourceTrendQueryOptions(
  organizationId: string,
  filters: TimingFilters,
  selectedJobKey: string | null,
  now: Date = new Date(),
) {
  const request = { ...resourceTrendRequest(filters, now), jobKey: selectedJobKey };
  return {
    queryKey: ["org", organizationId, "job-resource-trend-detail", request] as const,
    queryFn: () => getJobResourceTrends(organizationId, {
      ...request,
      limit: 1,
      pointLimit: 100,
    }),
    enabled: Boolean(organizationId && selectedJobKey),
    placeholderData: (
      previous: ResourceTrendPage | undefined,
      previousQuery: { queryKey: readonly unknown[] } | undefined,
    ) => previousQuery?.queryKey[0] === "org" && previousQuery.queryKey[1] === organizationId ? previous : undefined,
  };
}

export function resourceHistoryPageState(jobCount: number, filters: TimingFilters): ResourceHistoryPageState {
  if (jobCount > 0) return "ready";
  const hasActiveFilters = filters.range !== defaultTimingFilters.range
    || filters.platform !== defaultTimingFilters.platform
    || filters.vcpu !== defaultTimingFilters.vcpu
    || filters.concurrency !== defaultTimingFilters.concurrency
    || filters.search.trim() !== defaultTimingFilters.search
    || filters.sort !== defaultTimingFilters.sort;
  return hasActiveFilters ? "no-match" : "empty";
}

export function resourceHistoryJobsWithSelectedSummary(
  jobs: readonly ResourceTrendPage["jobs"][number][],
  detail: ResourceTrendPage["selectedJob"],
): ResourceTrendPage["jobs"] {
  if (!detail) return [...jobs];
  const existingIndex = jobs.findIndex((job) => job.jobKey === detail.summary.jobKey);
  if (existingIndex < 0) return [detail.summary, ...jobs];
  return jobs.map((job, index) => index === existingIndex ? detail.summary : job);
}

export function resourceHistoryDisplayedDetail(
  jobs: readonly ResourceTrendPage["jobs"][number][],
  firstPageDetail: ResourceTrendPage["selectedJob"],
  requestedDetail: ResourceTrendPage["selectedJob"],
  requestedJobKey: string | null,
): SelectedResourceTrend | null {
  const candidate = requestedJobKey === null ? firstPageDetail : requestedDetail ?? firstPageDetail;
  if (!candidate) return null;
  return jobs.some((job) => job.jobKey === candidate.summary.jobKey) ? candidate : null;
}

export function resourceHistoryToolbarFacets(
  facets: ResourceTrendPage["filters"],
  filters: TimingFilters,
): ResourceTrendPage["filters"] {
  const vcpu = filters.vcpu ? Number(filters.vcpu) : null;
  const concurrency = filters.concurrency ? Number(filters.concurrency) : null;
  return {
    platforms: filters.platform && !facets.platforms.includes(filters.platform)
      ? [...facets.platforms, filters.platform]
      : facets.platforms,
    vcpus: vcpu !== null && !facets.vcpus.includes(vcpu) ? [...facets.vcpus, vcpu] : facets.vcpus,
    concurrencies: concurrency !== null && !facets.concurrencies.includes(concurrency)
      ? [...facets.concurrencies, concurrency]
      : facets.concurrencies,
  };
}

export function resourceHistoryRefreshError<T>(hasData: boolean, error: T | null, failureReason: T | null): T | null {
  return hasData ? error ?? failureReason : null;
}

export function ResourceHistoryHeader() {
  return (
    <header className="resource-history-header runs-heading">
      <div>
        <p className="eyebrow">Runs / Resource analysis</p>
        <h1>Resource history</h1>
        <p className="resource-history-intro">CPU, memory, and execution time for completed jobs.</p>
      </div>
      <details className="resource-history-disclosure">
        <summary>About these metrics</summary>
        <div>
          <p>Resource values are sampled. Peaks are the highest observed samples, not exact process-level peaks.</p>
          <p>Missing telemetry is not treated as zero. This view includes CPU, memory, and execution duration; disk telemetry is not collected.</p>
        </div>
      </details>
    </header>
  );
}

export function ResourceHistoryEmptyState() {
  return (
    <StateView
      kind="empty"
      title="No completed job history yet"
      message="Records appear after completed jobs provide timing data."
    />
  );
}

function ResourceHistorySkeleton() {
  return (
    <div className="resource-history-skeleton" role="status" aria-label="Loading job resource history">
      <span className="sr-only">Loading job resource history</span>
      <div className="resource-history-skeleton-summary">
        {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
      </div>
      <div className="resource-history-skeleton-workspace">
        <span />
        <span />
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The latest resource history could not be loaded.";
}

export function TimingHistoryPage() {
  const { organizationId } = useOrganizationFromRoute();
  const [filters, setFilters] = useState<TimingFilters>(defaultTimingFilters);
  const [debouncedSearch, setDebouncedSearch] = useState(defaultTimingFilters.search);
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [requestedAt, setRequestedAt] = useState(() => new Date());

  useEffect(() => {
    if (filters.search === debouncedSearch) return;
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(filters.search);
      setRequestedAt((current) => new Date(Math.max(Date.now(), current.getTime() + 1)));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [debouncedSearch, filters.search]);

  useEffect(() => {
    setSelectedJobKey(null);
    setSelectedRunId(null);
  }, [organizationId]);

  const queryFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [debouncedSearch, filters],
  );
  const query = useInfiniteQuery(jobResourceTrendQueryOptions(
    organizationId,
    queryFilters,
    requestedAt,
  ));
  const detailQuery = useQuery(selectedJobResourceTrendQueryOptions(
    organizationId,
    queryFilters,
    selectedJobKey,
    requestedAt,
  ));
  const paginatedJobs = useMemo(() => query.data?.pages.flatMap((page) => page.jobs) ?? [], [query.data]);
  const firstPage = query.data?.pages[0];
  const requestedDetail = detailQuery.isPlaceholderData && !query.isPlaceholderData
    ? null
    : detailQuery.data?.selectedJob ?? null;
  const detailForList = selectedJobKey === null ? firstPage?.selectedJob ?? null : requestedDetail ?? firstPage?.selectedJob ?? null;
  const jobs = useMemo(
    () => resourceHistoryJobsWithSelectedSummary(paginatedJobs, detailForList),
    [detailForList, paginatedJobs],
  );
  const selectedJob = resourceHistoryDisplayedDetail(
    jobs,
    firstPage?.selectedJob ?? null,
    requestedDetail,
    selectedJobKey,
  );
  const displayedSelectedJobKey = selectedJob?.summary.jobKey ?? null;
  const refreshing = query.isFetching && !query.isFetchingNextPage || detailQuery.isFetching;
  const pageState = resourceHistoryPageState(paginatedJobs.length, queryFilters);
  const queryRefreshError = resourceHistoryRefreshError(Boolean(firstPage), query.error, query.failureReason);
  const detailRefreshError = selectedJobKey === null
    ? null
    : resourceHistoryRefreshError(Boolean(selectedJob), detailQuery.error, detailQuery.failureReason);
  const refreshError = queryRefreshError ?? detailRefreshError;
  const toolbarFacets = useMemo(
    () => resourceHistoryToolbarFacets(firstPage?.filters ?? emptyFacets, filters),
    [filters, firstPage?.filters],
  );

  useEffect(() => {
    const returnedKey = detailQuery.data?.selectedJob?.summary.jobKey;
    if (!detailQuery.isPlaceholderData && returnedKey && returnedKey !== selectedJobKey) setSelectedJobKey(returnedKey);
  }, [detailQuery.data, detailQuery.isPlaceholderData, selectedJobKey]);

  useEffect(() => {
    const points = selectedJob?.points ?? [];
    setSelectedRunId((current) => (
      current !== null && points.some((point) => point.runId === current)
        ? current
        : points.at(-1)?.runId ?? null
    ));
  }, [selectedJob]);

  const refresh = () => {
    setRequestedAt((current) => new Date(Math.max(Date.now(), current.getTime() + 1)));
  };
  const retry = () => {
    void query.refetch();
    if (selectedJobKey !== null) void detailQuery.refetch();
  };

  return (
    <div className="resource-history">
      <ResourceHistoryHeader />

      <TimingToolbar
        filters={filters}
        facets={toolbarFacets}
        generatedAt={firstPage?.generatedAt ?? null}
        refreshing={refreshing}
        onChange={setFilters}
        onRefresh={refresh}
      />

      {!firstPage && query.isLoading && <ResourceHistorySkeleton />}
      <QueryState
        error={!firstPage ? query.error : null}
        isLoading={false}
        retry={retry}
        operationLabel="job resource history"
      />

      {firstPage && (
        <div className={refreshing ? "resource-history-results is-updating" : "resource-history-results"} aria-busy={refreshing}>
          <TimingSummary summary={firstPage.summary} />

          {refreshError && (
            <div className="resource-history-banner is-error" role="alert">
              <div>
                <strong>Resource history could not be refreshed.</strong>
                <span>Showing the last successful, internally consistent response. {errorMessage(refreshError)}</span>
              </div>
              <button type="button" className="button secondary" onClick={retry}>Retry</button>
            </div>
          )}
          {!refreshError && (query.isPlaceholderData || detailQuery.isPlaceholderData) && (
            <div className="resource-history-banner is-stale" role="status">
              <strong>Updating this view.</strong>
              <span>Previous results remain visible until the latest response arrives.</span>
            </div>
          )}

          {pageState === "empty" ? (
            <ResourceHistoryEmptyState />
          ) : pageState === "no-match" ? (
            <section className="resource-history-no-match" aria-labelledby="resource-history-no-match-title">
              <p className="eyebrow">No matches</p>
              <h2 id="resource-history-no-match-title">No jobs match these filters.</h2>
              <p>Try a broader time range, remove a resource filter, or clear the job search.</p>
              <button type="button" className="button secondary" onClick={() => setFilters(defaultTimingFilters)}>Reset filters</button>
            </section>
          ) : (
            <div className="resource-history-workspace">
              <JobResourceList
                jobs={jobs}
                selectedJobKey={displayedSelectedJobKey}
                hasNextPage={query.hasNextPage}
                fetchingNextPage={query.isFetchingNextPage}
                onSelect={setSelectedJobKey}
                onLoadMore={() => void query.fetchNextPage()}
              />
              <div className="resource-history-detail-column" aria-busy={selectedJobKey !== null && detailQuery.isFetching}>
                {selectedJob ? (
                  <JobResourceDetail
                    job={selectedJob}
                    selectedRunId={selectedRunId}
                    onSelectRun={setSelectedRunId}
                  />
                ) : (
                  <section className="resource-history-detail resource-history-detail-pending" role="status">
                    <h2>Loading selected job</h2>
                    <p>The existing selection will update after its matching summary and measurements arrive.</p>
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
