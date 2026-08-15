import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { RunSummary } from "@whitesmith/contracts";
import { formatDuration } from "./RunTelemetry.tsx";

export type RunHistoryRange = "all" | "1h" | "2h" | "4h" | "12h" | "1d" | "2d";

const RANGE_MS: Record<Exclude<RunHistoryRange, "all">, number> = {
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "2d": 172_800_000,
};

const RANGE_LABELS: readonly RunHistoryRange[] = ["all", "1h", "2h", "4h", "12h", "1d", "2d"];

export function filterRuns(
  runs: readonly RunSummary[],
  search: string,
  range: RunHistoryRange,
  nowMs: number,
): RunSummary[] {
  const query = search.trim().toLowerCase();
  const cutoff = range === "all" ? Number.NEGATIVE_INFINITY : nowMs - RANGE_MS[range];
  return runs.filter((run) => {
    const inRange = Date.parse(run.queuedAt) >= cutoff;
    const result = run.conclusion ?? run.status.replace("_", " ");
    const searchable = [
      run.workflowName,
      run.repositoryName,
      run.branch,
      run.actorLogin,
      run.commitSha,
      result,
      run.runtimeBoundary ?? "",
    ].join(" ").toLowerCase();
    return inRange && (!query || searchable.includes(query));
  });
}

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

export function RunHistory({ runs, allowDetails = true, nowMs = Date.now() }: { runs: readonly RunSummary[]; allowDetails?: boolean; nowMs?: number }) {
  const [search, setSearch] = useState("");
  const [range, setRange] = useState<RunHistoryRange>("all");
  const visibleRuns = useMemo(() => filterRuns(runs, search, range, nowMs), [runs, search, range, nowMs]);
  const maxDuration = Math.max(0, ...visibleRuns.map((run) => run.durationMs ?? 0));
  const chartDescription = visibleRuns.length === 0
    ? "No run durations match these filters."
    : `${visibleRuns.length} run durations, scaled to a maximum of ${formatDuration(maxDuration)}.`;

  return (
    <section className="run-history" aria-labelledby="run-history-title">
      <div className="run-history-toolbar">
        <label className="run-history-search"> <span className="sr-only">Search runs</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search workflow, branch, actor…" /></label>
        <div className="run-history-ranges" aria-label="Filter by queued time">
          {RANGE_LABELS.map((item) => <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item === "all" ? "All" : item}</button>)}
        </div>
      </div>
      <div className="run-duration-chart" role="img" aria-label={chartDescription}>
        {visibleRuns.map((run) => <span key={run.id} className={`run-duration-bar run-duration-bar-${statusDescriptor(run).tone}`} style={{ height: `${run.durationMs && maxDuration ? Math.max(12, (run.durationMs / maxDuration) * 100) : 12}%` }} />)}
      </div>
      <div className="run-history-list">
        {visibleRuns.length === 0 ? <p className="run-history-empty">No runs match these filters.</p> : visibleRuns.map((run) => <RunRow key={run.id} run={run} allowDetails={allowDetails} maxDuration={maxDuration} />)}
      </div>
    </section>
  );
}
