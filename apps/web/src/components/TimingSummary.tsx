import type { JobResourceTrendResponse } from "@mars/contracts";
import { formatDuration, formatPercent } from "../routes/timing-model.ts";

export type TimingSummaryProps = {
  summary: JobResourceTrendResponse["summary"];
};

export function TimingSummary({ summary }: TimingSummaryProps) {
  const coverageIsPartial = summary.completedRunCount > 0 && summary.telemetryCoveredRunCount < summary.completedRunCount;
  const jobLabel = summary.jobCount === 1 ? "job" : "jobs";
  const runLabel = summary.completedRunCount === 1 ? "completed run" : "completed runs";
  const coverageRunLabel = summary.completedRunCount === 1 ? "run" : "runs";

  return (
    <section className="resource-history-summary" aria-label="Timing history summary">
      <dl>
        <div>
          <dt>Jobs</dt>
          <dd>{summary.jobCount} {jobLabel}</dd>
        </div>
        <div>
          <dt>Completed runs</dt>
          <dd>{summary.completedRunCount} {runLabel}</dd>
        </div>
        <div>
          <dt>Median execution</dt>
          <dd>{formatDuration(summary.medianExecutionDurationMs)}</dd>
        </div>
        <div>
          <dt>Telemetry coverage</dt>
          <dd>{formatPercent(summary.telemetryCoveragePercent)} · {summary.telemetryCoveredRunCount} of {summary.completedRunCount} {coverageRunLabel}</dd>
        </div>
      </dl>
      {coverageIsPartial && (
        <p className="resource-history-coverage-warning" role="note">
          Partial telemetry coverage: CPU and memory measurements are available for {summary.telemetryCoveredRunCount} of {summary.completedRunCount} {coverageRunLabel}.
        </p>
      )}
    </section>
  );
}
