import { Link } from "@tanstack/react-router";
import type { RunSummary } from "@whitesmith/contracts";

function formatDuration(ms: number) { if (!ms) return "—"; if (ms < 60_000) return `${Math.round(ms / 1000)}s`; return `${Math.round(ms / 60_000)}m`; }
function statusLabel(run: RunSummary) { return run.conclusion ?? run.status.replace("_", " "); }

export function RunTable({ runs, allowDetails = true }: { runs: readonly RunSummary[]; allowDetails?: boolean }) {
  return <section className="table-panel"><table><caption className="sr-only">Workflow runs</caption><thead><tr><th>Run</th><th>Repository</th><th>Result</th><th>Boundary</th><th>Duration</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{allowDetails ? <Link to="/runs/$runId" params={{ runId: run.id }}><strong>#{run.runNumber}</strong><span>{run.workflowName}</span></Link> : <><strong>#{run.runNumber}</strong><span>{run.workflowName}</span></>}</td><td>{run.repositoryName}<small>{run.branch} · {run.actorLogin}</small></td><td><span className={`status status-${run.conclusion ?? run.status}`}>{statusLabel(run)}</span></td><td>{run.runtimeBoundary ?? "Awaiting allocation"}</td><td>{formatDuration(run.durationMs)}</td></tr>)}</tbody></table></section>;
}
