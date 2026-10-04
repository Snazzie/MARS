 import { Link } from "@tanstack/react-router";
import type { RunSummary } from "@mars/contracts";
import { formatDuration } from "./RunTelemetry.tsx";

export type RunHistoryRange = "all" | "1h" | "2h" | "4h" | "12h" | "1d" | "2d";
export type RunHistoryRunnerFilter = "all" | "mars" | "external";
export type RunHistoryFilters = { search: string; range: RunHistoryRange; runner: RunHistoryRunnerFilter };


const RANGE_LABELS: readonly RunHistoryRange[] = ["all", "1h", "2h", "4h", "12h", "1d", "2d"];
const RUNNER_FILTER_LABELS: readonly { value: RunHistoryRunnerFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mars", label: "Mars" },
  { value: "external", label: "External" },
];


export function runDetailLink(run: RunSummary) {
  return {
    to: "/runs/$runId" as const,
    params: { runId: run.id },
    search: { organizationId: run.organizationId },
  };
}

type StatusDescriptor = { label: string; tone: "success" | "failure" | "running" | "queued" | "neutral" };
function statusDescriptor(run: RunSummary): StatusDescriptor {
  if (run.status === "queued") return { label: "Queued", tone: "queued" };
  if (run.status === "in_progress") return { label: "In progress", tone: "running" };
  if (run.conclusion === "success") return { label: "Success", tone: "success" };
  if (run.conclusion === "failure") return { label: "Failure", tone: "failure" };
  return { label: run.conclusion ?? "Completed", tone: "neutral" };
}

function ResultMark({ tone }: { tone: StatusDescriptor["tone"] }) {
  if (tone === "success") return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
  if (tone === "failure") return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
  if (tone === "running") return <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 5v3l2 1" fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
  return <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="currentColor" /></svg>;
}

function queuedTimestamp(value: string) {
  return new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function RunRow({ run, allowDetails, maxDuration }: { run: RunSummary; allowDetails: boolean; maxDuration: number }) {
  const status = statusDescriptor(run);
  const duration = run.durationMs ?? 0;
  const railWidth = duration > 0 && maxDuration > 0 ? Math.max(8, (duration / maxDuration) * 100) : 8;
  const content = (
    <div className="run-history-row-content">
      <div className={`run-result run-result-${status.tone}`}>
        <ResultMark tone={status.tone} />
        <span>{status.label}</span>
      </div>
      <div className="run-primary">
        <strong>{run.workflowName} <span>#{run.runNumber}</span></strong>
        <span className="run-meta">{run.actorLogin} · {run.runtimeBoundary ?? (run.allocationState === "external" ? "External runner" : "Awaiting allocation")} · <time dateTime={run.queuedAt}>{queuedTimestamp(run.queuedAt)}</time></span>
      </div>
      <div className="run-secondary">
        <span>{run.repositoryName} / {run.branch}</span>
        <span title={run.commitSha} aria-label={`Commit ${run.commitSha}`}>{run.commitSha.slice(0, 7)}</span>
      </div>
      <div className="run-duration">
        <span>{formatDuration(run.durationMs)}</span>
        <span className="run-duration-rail" aria-hidden="true"><span style={{ width: `${railWidth}%` }} /></span>
      </div>
    </div>
  );
  return allowDetails ? <Link className="run-history-row" {...runDetailLink(run)}>{content}</Link> : <div className="run-history-row">{content}</div>;
}

export function RunHistory({ runs, filters, onFiltersChange, allowDetails = true, resultsAvailable = true }: { runs: readonly RunSummary[]; filters: RunHistoryFilters; onFiltersChange: (filters: RunHistoryFilters) => void; allowDetails?: boolean; resultsAvailable?: boolean }) {
  const { search, range, runner: runnerFilter } = filters;
  const filtered = Boolean(search.trim() || range !== "all" || runnerFilter !== "all");
  const maxDuration = Math.max(0, ...runs.map((run) => run.durationMs ?? 0));
  const chartDescription = `${runs.length} loaded run durations, scaled to a maximum of ${formatDuration(maxDuration)}.`;

  return (
    <section className="run-history" aria-labelledby="run-history-title">
      <div className="run-history-toolbar">
        <label className="run-history-search"><span className="sr-only">Search runs</span><input type="search" maxLength={200} value={search} onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })} placeholder="Search workflow, branch, actor…" /></label>
        <div className="run-history-ranges" aria-label="Filter by queued time">
          {RANGE_LABELS.map((item) => <button key={item} type="button" aria-pressed={range === item} onClick={() => onFiltersChange({ ...filters, range: item })}>{item === "all" ? "All" : item}</button>)}
        </div>
        <div className="run-history-ranges run-history-runner-filters" aria-label="Filter by runner">
          {RUNNER_FILTER_LABELS.map((item) => <button key={item.value} type="button" aria-pressed={runnerFilter === item.value} onClick={() => onFiltersChange({ ...filters, runner: item.value })}>{item.label}</button>)}
        </div>
        {filtered && <button className="button secondary" type="button" onClick={() => onFiltersChange({ search: "", range: "all", runner: "all" })}>Clear filters</button>}
      </div>
      <p className="filter-scope" role="note">Search and filters apply across all matching runs. Charts show the loaded results.</p>
      {resultsAvailable && <>
        {runs.length > 0 && <div className="run-duration-chart" role="img" aria-label={chartDescription}>
          {runs.map((run) => <span key={run.id} className={`run-duration-bar run-duration-bar-${statusDescriptor(run).tone}`} style={{ height: `${run.durationMs && maxDuration ? Math.max(12, (run.durationMs / maxDuration) * 100) : 12}%` }} />)}
        </div>}
        <div className="run-history-list">
          {runs.length === 0 ? <p className="run-history-empty" role="status">{filtered ? "No runs match these filters. Clear the filters or try another search." : "No workflow runs yet. Runs appear after a connected repository starts a workflow."}</p> : runs.map((run) => <RunRow key={run.id} run={run} allowDetails={allowDetails} maxDuration={maxDuration} />)}
        </div>
      </>}
    </section>
  );
}
