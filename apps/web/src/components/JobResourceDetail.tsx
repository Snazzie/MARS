import { useId } from "react";
import type { JobResourceSample, JobResourceTrendResponse } from "@mars/contracts";
import { CpuTrendChart, DurationTrendChart, JobResourceTimelineCharts, MemoryTrendChart } from "./JobResourceCharts.tsx";
import { JobRunMeasurements } from "./JobRunMeasurements.tsx";
import { JobLabelOptimization, type JobLabelOptimizationRange, type JobLabelOptimizationRequest } from "./JobLabelOptimization.tsx";
import { formatBytes, formatDate } from "../routes/timing-model.ts";

export type JobResourceDetailProps = {
  job: NonNullable<JobResourceTrendResponse["selectedJob"]>;
  organizationId?: string;
  activeRange?: JobLabelOptimizationRange;
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
  samples: readonly JobResourceSample[];
  samplesLoading: boolean;
  samplesError: unknown | null;
  selectedPath?: string | null;
  onRequestPullRequest?: (request: JobLabelOptimizationRequest) => void;
};
export function JobResourceDetail({
  job,
  organizationId = "",
  activeRange = { from: "", to: "" },
  selectedRunId,
  onSelectRun,
  samples,
  samplesLoading,
  samplesError,
  selectedPath,
  onRequestPullRequest,
}: JobResourceDetailProps) {
  const headingId = useId();
  const points = job.points;
  const summary = job.summary;
  const selectedPoint = points.find((point) => point.runId === selectedRunId) ?? null;
  const coverageIsPartial = summary.telemetryCoveredRunCount < summary.runCount;
  const chartProps = { points, selectedRunId, onSelectRun };
  const sampleErrorMessage = samplesError instanceof Error ? samplesError.message : "Try again later.";

  return (
    <section className="resource-history-detail" aria-labelledby={headingId}>
      <header className="resource-history-detail-header">
        <div>
          <p className="eyebrow">Selected job</p>
          <h2 id={headingId}>{summary.jobName}</h2>
          <p className="detail-identity">{summary.repositoryName} · {summary.workflowName}</p>
          <p className="detail-meta">
            {summary.platform} · Latest request {summary.latestRequestedVcpu} vCPU / {formatBytes(summary.latestRequestedMemoryBytes)}
            {" · "}Parallelism {summary.latestEffectiveConcurrency}
          </p>
          <p className="detail-meta">
            {summary.runCount} completed {summary.runCount === 1 ? "run" : "runs"}
            {" · "}{points.length} sampled {points.length === 1 ? "run" : "runs"} shown
            {" · "}Latest {formatDate(summary.latestCompletedAt)}
          </p>
        </div>
        {coverageIsPartial && (
          <p className="resource-history-coverage-warning" role="note">
            Partial telemetry coverage: {summary.telemetryCoveredRunCount} of {summary.runCount} {summary.runCount === 1 ? "run" : "runs"} include CPU or memory telemetry.
          </p>
        )}
      </header>
      {organizationId && activeRange.from && activeRange.to && (
        <JobLabelOptimization
          organizationId={organizationId}
          activeRange={activeRange}
          repositoryId={summary.repositoryId}
          repositoryName={summary.repositoryName}
          workflowName={summary.workflowName}
          jobName={summary.jobName}
          selectedPath={selectedPath}
          selectedJobId={selectedPoint?.jobId ?? null}
          currentVcpu={summary.latestRequestedVcpu}
          currentMemoryGiB={Math.max(1, Math.ceil(summary.latestRequestedMemoryBytes / 1024 ** 3))}
          onRequestPullRequest={onRequestPullRequest}
        />
      )}

      <p className="resource-history-sampling-note" role="note">
        Sampled charts can miss short-lived peaks between collected observations.
      </p>
      {samplesLoading && (
        <p className="resource-history-timeline-status" role="status">Loading within-run CPU and memory samples…</p>
      )}
      {Boolean(samplesError) && (
        <p className="resource-history-timeline-status is-error" role="alert">
          Within-run telemetry could not be refreshed. {sampleErrorMessage}
        </p>
      )}
      <JobResourceTimelineCharts
        samples={samples}
        completedAt={selectedPoint?.completedAt ?? null}
        executionDurationMs={selectedPoint?.executionDurationMs ?? null}
        selectedRunId={selectedRunId}
        onSelectRun={onSelectRun}
      />
      <p className="resource-history-sampling-note" role="note">
        Across completed runs, trend charts show aggregate measurements; sampled peaks can miss short-lived peaks between observations.
      </p>

      <div className="resource-history-charts">
        <CpuTrendChart {...chartProps} />
        <MemoryTrendChart {...chartProps} />
        <DurationTrendChart {...chartProps} />
      </div>

      <JobRunMeasurements {...chartProps} />
    </section>
  );
}
