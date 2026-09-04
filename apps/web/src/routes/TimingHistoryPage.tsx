import type { JobResourceSample, JobResourceTrendResponse } from "@mars/contracts";
import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getJobResourceSamples, getJobResourceTrends } from "../api.ts";
import { JobResourceDetail } from "../components/JobResourceDetail.tsx";
import { RunnerWorkflowPrModal } from "../components/RunnerWorkflowPrModal.tsx";
import type { JobLabelOptimizationRequest } from "../components/JobLabelOptimization.tsx";
import { JobResourceList } from "../components/JobResourceList.tsx";
import { QueryState, StateView } from "../components/StateView.tsx";
import { TimingSummary } from "../components/TimingSummary.tsx";
import { TimingToolbar } from "../components/TimingToolbar.tsx";
import { defaultTimingFilters, timingRangeBounds, type TimingFilters } from "./timing-model.ts";
import { useOrganizationFromRoute } from "./useOrganization.ts";

type ResourceTrendPage = JobResourceTrendResponse;
type SelectedResourceTrend = NonNullable<ResourceTrendPage["selectedJob"]>;
type ResourceHistoryPageState = "ready" | "empty" | "no-match";

type JobResourceSamplePage = { items: readonly JobResourceSample[]; nextCursor: string | null };

export function flattenJobResourceSamplePages(pages: readonly JobResourceSamplePage[]): JobResourceSample[] {
  return pages.flatMap((page) => page.items).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

export function resourceSampleElapsedMs(sample: JobResourceSample, completedAt: string, executionDurationMs: number): number {
  return new Date(sample.occurredAt).getTime() - (new Date(completedAt).getTime() - executionDurationMs);
}

export function jobResourceSampleOrganizationId(
  routeOrganizationId: string,
  selectedPoint: Pick<NonNullable<JobResourceTrendResponse["selectedJob"]>["points"][number], "organizationId"> | null,
): string {
  return selectedPoint?.organizationId ?? routeOrganizationId;
}

export function jobResourceSamplesQueryOptions(
  organizationId: string,
  selectedRunId: string | null,
  selectedJobId: string | null,
) {
  return {
    queryKey: ["org", organizationId, "job-resource-samples", selectedRunId, selectedJobId] as const,
    queryFn: ({ pageParam }: { pageParam: string | null }) => getJobResourceSamples(
      organizationId,
      selectedRunId!,
      selectedJobId!,
      pageParam,
      100,
    ),
    initialPageParam: null as string | null,
    getNextPageParam: (page: JobResourceSamplePage) => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId && selectedRunId && selectedJobId),
  };
}


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
export type ResourceHistoryCommittedView = {
  organizationId: string;
  generation: string;
  filters: TimingFilters;
  pages: ResourceTrendPage[];
  selectedJob: ResourceTrendPage["selectedJob"];
};

type ResourceHistoryResponseState = {
  organizationId: string;
  generation: string;
  filters: TimingFilters;
  pages: readonly ResourceTrendPage[] | null;
  summaryPlaceholder: boolean;
  selectedJobKey: string | null;
  detailResponse: ResourceTrendPage | undefined;
  detailPlaceholder: boolean;
};

export function resourceHistoryViewAfterResponses(
  current: ResourceHistoryCommittedView | null,
  response: ResourceHistoryResponseState,
): ResourceHistoryCommittedView | null {
  const retained = current?.organizationId === response.organizationId ? current : null;
  if (!response.pages || response.summaryPlaceholder) return retained;
  let selectedJob = response.pages[0]?.selectedJob ?? null;
  if (response.selectedJobKey !== null) {
    if (!response.detailResponse || response.detailPlaceholder) {
      if (retained?.generation !== response.generation) return retained;
      return {
        ...retained,
        filters: response.filters,
        pages: [...response.pages],
      };
    }
    selectedJob = response.detailResponse.selectedJob;
  }
  return {
    organizationId: response.organizationId,
    generation: response.generation,
    filters: response.filters,
    pages: [...response.pages],
    selectedJob,
  };
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
  const [pullRequest, setPullRequest] = useState<JobLabelOptimizationRequest | null>(null);

  const [committedView, setCommittedView] = useState<ResourceHistoryCommittedView | null>(null);
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
  const generation = useMemo(
    () => JSON.stringify([organizationId, resourceTrendRequest(queryFilters, requestedAt)]),
    [organizationId, queryFilters, requestedAt],
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
  useEffect(() => {
    setCommittedView((current) => resourceHistoryViewAfterResponses(current, {
      organizationId,
      generation,
      filters: queryFilters,
      pages: query.data?.pages ?? null,
      summaryPlaceholder: query.isPlaceholderData,
      selectedJobKey,
      detailResponse: detailQuery.data,
      detailPlaceholder: detailQuery.isPlaceholderData,
    }));
  }, [
    detailQuery.data,
    detailQuery.isPlaceholderData,
    generation,
    organizationId,
    query.data?.pages,
    query.isPlaceholderData,
    queryFilters,
    selectedJobKey,
  ]);
  const view = committedView?.organizationId === organizationId ? committedView : null;
  const paginatedJobs = useMemo(() => view?.pages.flatMap((page) => page.jobs) ?? [], [view]);
  const firstPage = view?.pages[0];
  const jobs = useMemo(
    () => resourceHistoryJobsWithSelectedSummary(paginatedJobs, view?.selectedJob ?? null),
    [paginatedJobs, view?.selectedJob],
  );
  const selectedJob = view?.selectedJob ?? null;
  const displayedSelectedJobKey = selectedJob?.summary.jobKey ?? null;
  const selectedRunPoint = useMemo(
    () => selectedJob?.points.find((point) => point.runId === selectedRunId) ?? null,
    [selectedJob, selectedRunId],
  );
  const sampleQuery = useInfiniteQuery(jobResourceSamplesQueryOptions(
    jobResourceSampleOrganizationId(organizationId, selectedRunPoint),
    selectedRunId,
    selectedRunPoint?.jobId ?? null,
  ));
  useEffect(() => {
    if (!sampleQuery.hasNextPage || sampleQuery.isFetchingNextPage) return;
    void sampleQuery.fetchNextPage();
  }, [sampleQuery.fetchNextPage, sampleQuery.hasNextPage, sampleQuery.isFetchingNextPage]);
  const samples = useMemo(
    () => flattenJobResourceSamplePages(sampleQuery.data?.pages ?? []),
    [sampleQuery.data?.pages],
  );
  const refreshing = query.isFetching && !query.isFetchingNextPage || detailQuery.isFetching;
  const pageState = resourceHistoryPageState(paginatedJobs.length, view?.filters ?? queryFilters);
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
    if (selectedRunId !== null && selectedRunPoint?.jobId) void sampleQuery.refetch();
  };
  const retry = () => {
    void query.refetch();
    if (selectedJobKey !== null) void detailQuery.refetch();
    if (selectedRunId !== null && selectedRunPoint?.jobId) void sampleQuery.refetch();
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
                paginationKey={view?.generation ?? generation}
                selectedJobKey={displayedSelectedJobKey}
                hasNextPage={view?.generation === generation && query.hasNextPage}
                fetchingNextPage={view?.generation === generation && query.isFetchingNextPage}
                onSelect={setSelectedJobKey}
                onLoadMore={() => void query.fetchNextPage()}
              />
              <div className="resource-history-detail-column" aria-busy={selectedJobKey !== null && detailQuery.isFetching}>
                {selectedJob ? (
                  <JobResourceDetail
                    job={selectedJob}
                    organizationId={organizationId}
                    activeRange={timingRangeBounds(queryFilters.range, requestedAt)}
                    selectedRunId={selectedRunId}
                    onSelectRun={setSelectedRunId}
                    samples={samples}
                    samplesLoading={sampleQuery.isFetching}
                    samplesError={sampleQuery.error ?? sampleQuery.failureReason ?? null}
                    onRequestPullRequest={setPullRequest}
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
      {pullRequest && (
        <RunnerWorkflowPrModal
          organizationId={organizationId}
          repositoryId={pullRequest.repositoryId}
          repositoryName={pullRequest.repositoryName}
          workflowName={pullRequest.workflowName}
          jobName={pullRequest.jobName}
          open
          onClose={() => setPullRequest(null)}
          selectedPath={pullRequest.selectedPath}
          selectedJobId={pullRequest.selectedJobId}
          currentLabels={pullRequest.currentLabels}
          p95CpuPeakPercent={pullRequest.p95CpuPeakPercent}
          p95MemoryPeakBytes={pullRequest.p95MemoryPeakBytes}
          successfulRunCount={pullRequest.successfulRunCount}
        />
      )}
    </div>
  );
}
