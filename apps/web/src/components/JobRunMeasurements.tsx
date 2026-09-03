import type { JobResourceTrendPoint } from "@mars/contracts";
import { Link } from "@tanstack/react-router";
import { formatBytes, formatDate, formatDuration, formatPercent } from "../routes/timing-model.ts";

export type JobRunMeasurementsProps = {
  points: readonly JobResourceTrendPoint[];
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
};

const outcomeLabels: Record<JobResourceTrendPoint["outcome"], string> = {
  success: "Success",
  failure: "Failure",
  cancelled: "Cancelled",
  skipped: "Skipped",
  neutral: "Neutral",
};

function telemetryLabel(point: JobResourceTrendPoint): string {
  if (point.telemetryState === "unavailable") return "Unavailable";
  const sampleLabel = `${point.telemetrySampleCount} ${point.telemetrySampleCount === 1 ? "sample" : "samples"}`;
  return `${point.telemetryState === "partial" ? "Partial" : "Available"} · ${sampleLabel}`;
}

export function JobRunMeasurements({ points, selectedRunId, onSelectRun }: JobRunMeasurementsProps) {
  return (
    <section className="resource-history-measurements" aria-labelledby="resource-history-measurements-title">
      <h3 id="resource-history-measurements-title">Run measurements</h3>
      <div className="resource-history-table-scroll">
        <table>
          <caption className="sr-only">Complete measurements for each completed job run</caption>
          <thead>
            <tr>
              <th scope="col">Completed</th>
              <th scope="col">Outcome</th>
              <th scope="col">Execution duration</th>
              <th scope="col">CPU average</th>
              <th scope="col">CPU peak</th>
              <th scope="col">Memory peak</th>
              <th scope="col">Requested vCPU / memory</th>
              <th scope="col">Parallelism</th>
              <th scope="col">Telemetry</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => {
              const completed = formatDate(point.completedAt);
              const selected = point.runId === selectedRunId;
              return (
                <tr key={point.runId} className={selected ? "is-selected" : undefined}>
                  <td>
                    <button
                      type="button"
                      className="resource-history-run-select"
                      aria-pressed={selected}
                      aria-label={`Select run completed ${completed}`}
                      onClick={() => onSelectRun(point.runId)}
                    >
                      <time dateTime={point.completedAt}>{completed}</time>
                    </button>
                    <Link to="/runs/$runId" params={{ runId: point.runId }} aria-label={`Open run completed ${completed}`}>
                      Open run
                    </Link>
                  </td>
                  <td><span className={`run-status status-${point.outcome}`}>{outcomeLabels[point.outcome]}</span></td>
                  <td>{formatDuration(point.executionDurationMs)}</td>
                  <td>{formatPercent(point.cpuAveragePercent)}</td>
                  <td>{formatPercent(point.cpuPeakPercent)}</td>
                  <td>{formatBytes(point.memoryPeakBytes)}</td>
                  <td>{point.requestedVcpu} vCPU / {formatBytes(point.requestedMemoryBytes)}</td>
                  <td>{point.effectiveConcurrency} concurrent</td>
                  <td>{telemetryLabel(point)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
