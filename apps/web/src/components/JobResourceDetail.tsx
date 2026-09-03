import { useId } from "react";
import type { JobResourceTrendPoint } from "@mars/contracts";
import { CpuTrendChart, DurationTrendChart, MemoryTrendChart } from "./JobResourceCharts.tsx";
import { JobRunMeasurements } from "./JobRunMeasurements.tsx";
import { formatDate } from "../routes/timing-model.ts";


export type JobResourceDetailProps = {
  organizationId: string;
  job: { jobKey: string; points: readonly JobResourceTrendPoint[] };
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
};

export function JobResourceDetail({ job, selectedRunId, onSelectRun }: JobResourceDetailProps) {
  const headingId = useId();
  const points = job.points;
  const coveredRunCount = points.filter((point) => point.telemetryState !== "unavailable").length;
  const coverageIsPartial = coveredRunCount < points.length;
  const latestPoint = points.at(-1);
  const chartProps = { points, selectedRunId, onSelectRun };

  return (
    <section className="resource-history-detail" aria-labelledby={headingId}>
      <header className="resource-history-detail-header">
        <div>
          <p className="eyebrow">Selected job</p>
          <h2 id={headingId}>Resource history</h2>
          <p className="detail-meta">
            {points.length} completed {points.length === 1 ? "run" : "runs"}
            {latestPoint ? <> · Latest {formatDate(latestPoint.completedAt)}</> : null}
          </p>
        </div>
        {coverageIsPartial && (
          <p className="resource-history-coverage-warning" role="note">
            Partial telemetry coverage: {coveredRunCount} of {points.length} {points.length === 1 ? "run" : "runs"} include CPU or memory telemetry.
          </p>
        )}
      </header>

      <div className="resource-history-charts">
        <CpuTrendChart {...chartProps} />
        <MemoryTrendChart {...chartProps} requestedMemoryBytes={latestPoint?.requestedMemoryBytes ?? null} />
        <DurationTrendChart {...chartProps} />
      </div>

      <JobRunMeasurements {...chartProps} />
    </section>
  );
}
