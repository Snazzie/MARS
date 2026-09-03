import { useId } from "react";
import type { JobResourceTrendResponse } from "@mars/contracts";
import { CpuTrendChart, DurationTrendChart, MemoryTrendChart } from "./JobResourceCharts.tsx";
import { JobRunMeasurements } from "./JobRunMeasurements.tsx";
import { formatBytes, formatDate } from "../routes/timing-model.ts";


export type JobResourceDetailProps = {
  job: NonNullable<JobResourceTrendResponse["selectedJob"]>;
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
};

export function JobResourceDetail({ job, selectedRunId, onSelectRun }: JobResourceDetailProps) {
  const headingId = useId();
  const points = job.points;
  const summary = job.summary;
  const coverageIsPartial = summary.telemetryCoveredRunCount < summary.runCount;
  const chartProps = { points, selectedRunId, onSelectRun };

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

      <p className="resource-history-sampling-note" role="note">
        Sampled charts can miss short-lived peaks between collected observations.
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
