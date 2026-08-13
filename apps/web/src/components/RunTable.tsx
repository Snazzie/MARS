import { Link } from "@tanstack/react-router";
import type { RunSummary } from "@whitesmith/contracts";
import { formatDuration, lifecycleMetrics } from "./RunTelemetry.tsx";

function formatDurationWithFallback(ms: number) { return formatDuration(ms || null); }
function statusLabel(run: RunSummary) { return run.conclusion ?? run.status.replace("_", " "); }
export function runDetailLink(run: RunSummary) { return { to: "/runs/$runId" as const, params: { runId: run.id }, search: { organizationId: run.organizationId } }; }

export function RunTable({ runs, allowDetails = true }: { runs: readonly RunSummary[]; allowDetails?: boolean }) {
  return (
    <section className="table-panel">
      <table>
        <caption className="sr-only">Workflow runs</caption>
        <thead>
          <tr>
            <th>Run #</th>
            <th>Commit</th>
            <th>Branch</th>
            <th>Repository</th>
            <th>Result</th>
            <th>Boundary</th>
            <th>Queued</th>
            <th>Start delay</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const metrics = lifecycleMetrics(run.queuedAt, run.startedAt, run.completedAt);
            const runCell = <><strong>#{run.runNumber}</strong><span>{run.workflowName}</span></>;
            return (
              <tr key={run.id}>
                <td>{allowDetails ? <Link {...runDetailLink(run)}>{runCell}</Link> : runCell}</td>
                <td title={run.commitSha} aria-label={`Commit ${run.commitSha}`}>{run.commitSha.slice(0, 7)}</td>
                <td>{run.branch}</td>
                <td>{run.repositoryName}<small>{run.actorLogin}</small></td>
                <td><span className={`status status-${run.conclusion ?? run.status}`}>{statusLabel(run)}</span></td>
                <td>{run.runtimeBoundary ?? "Awaiting allocation"}</td>
                <td><time dateTime={run.queuedAt}>{new Date(run.queuedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</time></td>
                <td>{run.startedAt ? formatDuration(metrics.startDelayMs) : "Waiting"}</td>
                <td>{formatDurationWithFallback(run.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
