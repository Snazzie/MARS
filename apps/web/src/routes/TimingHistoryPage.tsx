import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getJobResourceTrends } from "../api.ts";
import { JobResourceDetail } from "../components/JobResourceDetail.tsx";
import { JobResourceList } from "../components/JobResourceList.tsx";
import { QueryState } from "../components/StateView.tsx";
import { TimingSummary } from "../components/TimingSummary.tsx";
import { TimingToolbar } from "../components/TimingToolbar.tsx";
import { defaultTimingFilters, selectionAfterJobsChange, timingRangeBounds, type TimingFilters } from "./timing-model.ts";
import { useOrganizationFromRoute } from "./useOrganization.ts";

type ResourceTrendPage = Awaited<ReturnType<typeof getJobResourceTrends>>;
type ResourceHistoryPageState = "ready" | "empty" | "no-match";

const emptyFacets: ResourceTrendPage["filters"] = {
  platforms: [],
  vcpus: [],
  concurrencies: [],
};

export function jobResourceTrendQueryOptions(
  organizationId: string,
  filters: TimingFilters,
  selectedJobKey: string | null,
  now: Date = new Date(),
) {
  const request = {
    ...timingRangeBounds(filters.range, now),
    platform: filters.platform || undefined,
    vcpu: filters.vcpu ? Number(filters.vcpu) : undefined,
    concurrency: filters.concurrency ? Number(filters.concurrency) : undefined,
    search: filters.search.trim() || undefined,
    sort: filters.sort,
    jobKey: selectedJobKey,
  };

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

export function resourceHistorySelectionAfterRefresh(
  current: string | null,
  jobs: ResourceTrendPage["jobs"],
  selectedDetailJobKey: string | null,
): string | null {
  const summarySelection = selectionAfterJobsChange(current, jobs);
  if (summarySelection === current || selectedDetailJobKey === current) return current;
  return selectionAfterJobsChange(selectedDetailJobKey, jobs);
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

  const queryFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [debouncedSearch, filters],
  );
  const query = useInfiniteQuery(jobResourceTrendQueryOptions(
    organizationId,
    queryFilters,
    selectedJobKey,
    requestedAt,
  ));
  const jobs = useMemo(() => query.data?.pages.flatMap((page) => page.jobs) ?? [], [query.data]);
  const firstPage = query.data?.pages[0];
  const selectedJob = firstPage?.selectedJob ?? null;
  const refreshing = query.isFetching && !query.isFetchingNextPage;
  const pageState = resourceHistoryPageState(jobs.length, queryFilters);
  const refreshError = resourceHistoryRefreshError(Boolean(firstPage), query.error, query.failureReason);
  const toolbarFacets = useMemo(
    () => resourceHistoryToolbarFacets(firstPage?.filters ?? emptyFacets, filters),
    [filters, firstPage?.filters],
  );

  useEffect(() => {
    setSelectedJobKey((current) => resourceHistorySelectionAfterRefresh(current, jobs, selectedJob?.jobKey ?? null));
  }, [jobs, selectedJob?.jobKey]);

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

  return (
    <div className="resource-history">
      <header className="resource-history-header runs-heading">
        <div>
          <p className="eyebrow">Runs / Resource analysis</p>
          <h1>Job resource history</h1>
          <p className="resource-history-intro">
            Compare execution time, CPU, and memory across completed runs without losing the job context behind each measurement.
          </p>
        </div>
        <details className="resource-history-disclosure">
          <summary>How to read these metrics</summary>
          <div>
            <p>Trends are observational. A change in timing or resource use does not establish causation.</p>
            <p>CPU and memory depend on worker telemetry coverage. Missing samples remain unavailable rather than being treated as zero. Disk telemetry is not collected.</p>
          </div>
        </details>
      </header>

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
        isEmpty={Boolean(firstPage) && pageState === "empty"}
        retry={() => void query.refetch()}
        operationLabel="job resource history"
      />

      {firstPage && (
        <div className={refreshing ? "resource-history-results is-updating" : "resource-history-results"} aria-busy={refreshing}>
          <TimingSummary summary={firstPage.summary} />

          {refreshError && (
            <div className="resource-history-banner is-error" role="alert">
              <div>
                <strong>Resource history could not be refreshed.</strong>
                <span>Showing the last successful response. {errorMessage(refreshError)}</span>
              </div>
              <button type="button" className="button secondary" onClick={() => void query.refetch()}>Retry</button>
            </div>
          )}
          {!refreshError && query.isPlaceholderData && (
            <div className="resource-history-banner is-stale" role="status">
              <strong>Updating this view.</strong>
              <span>Previous results remain visible until the latest response arrives.</span>
            </div>
          )}

          {pageState === "no-match" ? (
            <section className="resource-history-no-match" aria-labelledby="resource-history-no-match-title">
              <p className="eyebrow">No matches</p>
              <h2 id="resource-history-no-match-title">No jobs match these filters.</h2>
              <p>Try a broader time range, remove a resource filter, or clear the job search.</p>
              <button type="button" className="button secondary" onClick={() => setFilters(defaultTimingFilters)}>Reset filters</button>
            </section>
          ) : pageState === "ready" ? (
            <div className="resource-history-workspace">
              <JobResourceList
                jobs={jobs}
                selectedJobKey={selectedJobKey}
                hasNextPage={query.hasNextPage}
                fetchingNextPage={query.isFetchingNextPage}
                onSelect={setSelectedJobKey}
                onLoadMore={() => void query.fetchNextPage()}
              />
              {selectedJob && (
                <JobResourceDetail
                  organizationId={organizationId}
                  job={selectedJob}
                  selectedRunId={selectedRunId}
                  onSelectRun={setSelectedRunId}
                />
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
