import type { JobResourceTrendJob } from "@mars/contracts";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { formatBytes, formatDate, formatDeltaPercent, formatDuration, formatPercent } from "../routes/timing-model.ts";

export type JobResourceListProps = {
  jobs: readonly JobResourceTrendJob[];
  selectedJobKey: string | null;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  paginationKey: string;
  onSelect(jobKey: string): void;
  onLoadMore(): void;
};

type DeltaProps = {
  label: string;
  value: number | null;
};

function DeltaIndicator({ label, value }: DeltaProps): ReactNode {
  if (value === null) return null;
  const direction = value > 0 ? "increased" : value < 0 ? "decreased" : "unchanged";
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  return (
    <div className={`resource-history-delta is-${direction}`}>
      <dt>{label}</dt>
      <dd>
        <span aria-hidden="true">{arrow}</span>
        <span className="sr-only">{direction}</span>{" "}
        {formatDeltaPercent(value)}
      </dd>
    </div>
  );
}

export function JobResourceList({ jobs, selectedJobKey, hasNextPage, fetchingNextPage, paginationKey, onSelect, onLoadMore }: JobResourceListProps) {
  const headingId = useId();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const automaticLoadRequested = useRef(false);
  const loadedPageState = useRef({ paginationKey, jobCount: jobs.length });
  const hasSelectedJob = selectedJobKey !== null && jobs.some((job) => job.jobKey === selectedJobKey);

  useEffect(() => {
    const previous = loadedPageState.current;
    if (previous.paginationKey !== paginationKey || jobs.length > previous.jobCount) {
      automaticLoadRequested.current = false;
    }
    loadedPageState.current = { paginationKey, jobCount: jobs.length };
  }, [jobs.length, paginationKey]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || fetchingNextPage || automaticLoadRequested.current || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || automaticLoadRequested.current) return;
      automaticLoadRequested.current = true;
      observer.disconnect();
      onLoadMore();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchingNextPage, hasNextPage, onLoadMore]);

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLLIElement>, jobKey: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(jobKey);
      return;
    }

    const options = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role='option']") ?? []);
    const currentIndex = options.indexOf(event.currentTarget);
    let destination: HTMLElement | undefined;
    if (event.key === "ArrowDown") destination = options[Math.min(currentIndex + 1, options.length - 1)];
    else if (event.key === "ArrowUp") destination = options[Math.max(currentIndex - 1, 0)];
    else if (event.key === "Home") destination = options[0];
    else if (event.key === "End") destination = options.at(-1);
    else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const search = event.key.toLocaleLowerCase();
      for (let offset = 1; offset <= options.length; offset += 1) {
        const candidate = options[(currentIndex + offset) % options.length];
        if (candidate?.dataset.optionText?.startsWith(search)) {
          destination = candidate;
          break;
        }
      }
    }

    const destinationKey = destination?.dataset.jobKey;
    if (!destination || !destinationKey) return;
    event.preventDefault();
    destination.focus();
    onSelect(destinationKey);
  };

  return (
    <section className="resource-history-job-list" aria-labelledby={headingId}>
      <h2 id={headingId}>Jobs</h2>
      {jobs.length === 0 ? (
        <p className="chart-empty">No jobs match these filters.</p>
      ) : (
        <ul role="listbox" aria-labelledby={headingId} aria-label="Job resource history">
          {jobs.map((job, index) => {
            const selected = job.jobKey === selectedJobKey;
            const coverageIsPartial = job.telemetryCoveredRunCount < job.runCount;
            const itemId = `${headingId}-job-${job.jobKey}`;
            const jobNameId = `${itemId}-name`;
            const jobIdentityId = `${itemId}-identity`;
            const metricsId = `${itemId}-metrics`;
            const warningId = `${itemId}-coverage`;
            return (
              <li
                key={job.jobKey}
                role="option"
                aria-selected={selected}
                aria-labelledby={`${jobNameId} ${jobIdentityId}`}
                aria-describedby={`${metricsId}${coverageIsPartial ? ` ${warningId}` : ""}`}
                tabIndex={selected || (!hasSelectedJob && index === 0) ? 0 : -1}
                data-job-key={job.jobKey}
                data-option-text={`${job.jobName} ${job.repositoryName} ${job.workflowName}`.toLocaleLowerCase()}
                className={selected ? "resource-history-job is-selected" : "resource-history-job"}
                onClick={(event) => {
                  event.currentTarget.focus();
                  onSelect(job.jobKey);
                }}
                onKeyDown={(event) => handleOptionKeyDown(event, job.jobKey)}
              >
                <header>
                  <strong id={jobNameId}>{job.jobName}</strong>
                  <span id={jobIdentityId}>{job.repositoryName} · {job.workflowName}</span>
                  <small>{job.platform}</small>
                </header>
                <dl id={metricsId} className="resource-history-job-metrics">
                  <div><dt>Runs</dt><dd>{job.runCount} {job.runCount === 1 ? "run" : "runs"}</dd></div>
                  <div><dt>Latest completion</dt><dd><time dateTime={job.latestCompletedAt}>{formatDate(job.latestCompletedAt)}</time></dd></div>
                  <div><dt>Median duration</dt><dd>{formatDuration(job.medianExecutionDurationMs)}</dd></div>
                  <div><dt>CPU peak</dt><dd>{formatPercent(job.cpuPeakPercent)}</dd></div>
                  <div><dt>Memory peak</dt><dd>{formatBytes(job.memoryPeakBytes)}</dd></div>
                  <DeltaIndicator label="Duration change" value={job.durationChangePercent} />
                  <DeltaIndicator label="CPU peak change" value={job.cpuChangePercent} />
                  <DeltaIndicator label="Memory peak change" value={job.memoryChangePercent} />
                </dl>
                {coverageIsPartial && (
                  <p id={warningId} className="resource-history-coverage-warning" role="note">
                    Partial telemetry coverage: {job.telemetryCoveredRunCount} of {job.runCount} {job.runCount === 1 ? "run" : "runs"} include CPU and memory telemetry.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hasNextPage && (
        <div className="resource-history-pagination">
          <div ref={sentinelRef} className="resource-history-page-sentinel" aria-hidden="true" />
          <button
            type="button"
            className="button secondary load-more"
            disabled={fetchingNextPage}
            onClick={() => {
              automaticLoadRequested.current = true;
              onLoadMore();
            }}
          >
            {fetchingNextPage ? "Loading more jobs…" : "Load more jobs"}
          </button>
        </div>
      )}
      {fetchingNextPage && <p className="sr-only" role="status" aria-live="polite">Loading more jobs</p>}
    </section>
  );
}
