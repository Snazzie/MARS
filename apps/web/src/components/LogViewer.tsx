import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunJob, RunStep } from "@whitesmith/contracts";
import { getLogs, getStepLogs } from "../api.ts";
import { QueryState } from "./StateView.tsx";

const STEP_LOG_LIMIT = 100;
const DISPLAY_LOG_LIMIT = 200;

type LogViewerProps = {
  organizationId: string;
  runId: string;
  jobId: string;
  steps?: readonly RunStep[];
  logsState: RunJob["logsState"];
};

export function normalizeStepResult(step: Pick<RunStep, "status" | "conclusion">): string {
  return (step.conclusion ?? step.status).replaceAll("_", " ");
}

export function deriveStepDuration(step: Pick<RunStep, "durationMs" | "startedAt" | "completedAt">): number | null {
  if (step.durationMs > 0) return step.durationMs;
  if (!step.startedAt || !step.completedAt) return null;
  const duration = Date.parse(step.completedAt) - Date.parse(step.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function orderedLogText(items: readonly { sequence: number; content: string }[]): string {
  return [...items]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, DISPLAY_LOG_LIMIT)
    .map((chunk) => `${chunk.content}\n`)
    .join("");
}
export function stepLogEmptyMessage(logsState: RunJob["logsState"]): string {
  if (logsState === "pending") return "Logs are being synchronized from the runner and GitHub.";
  if (logsState === "unavailable") return "GitHub no longer provides logs for this job.";
  return "No log lines were attributed to this step. Review the unattributed job logs below.";
}


function StepLogRow({ organizationId, runId, jobId, logsState, step }: { organizationId: string; runId: string; jobId: string; logsState: RunJob["logsState"]; step: RunStep }) {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["org", organizationId, "run", runId, "job", jobId, "step", step.id, "logs"],
    queryFn: () => getStepLogs(organizationId, runId, jobId, step.id, -1, STEP_LOG_LIMIT),
    enabled: expanded && Boolean(organizationId && runId && jobId && step.id),
    staleTime: 15_000,
  });
  const items = query.data?.items ?? [];
  const duration = deriveStepDuration(step);
  return (
    <details className="step-log-row" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="step-log-summary" aria-expanded={expanded}>
        <span className="step-log-name"><span className="step-number">{step.number}</span>{step.name}</span>
        <span className={`status status-${step.conclusion ?? step.status}`}>{normalizeStepResult(step)}</span>
        <span className="step-log-duration">{formatDuration(duration)}</span>
      </summary>
      <div className="step-log-body">
        <QueryState error={query.error} isLoading={query.isLoading} isEmpty={false} retry={() => void query.refetch()} operationLabel="step logs" />
        {!query.isLoading && !query.error && items.length === 0 && <p className="log-meta">{stepLogEmptyMessage(logsState)}</p>}
        {items.length > 0 && <><pre className="log-viewer" tabIndex={0} aria-label={`${step.name} log output`}>{orderedLogText(items)}</pre><p className="log-meta">Showing up to {DISPLAY_LOG_LIMIT} ordered chunks{query.data?.nextCursor ? "; more logs are available from search." : "."}</p></>}
      </div>
    </details>
  );
}

export function LogViewer({ organizationId, runId, jobId, logsState, steps = [] }: LogViewerProps) {
  const query = useQuery({ queryKey: ["org", organizationId, "run", runId, "job", jobId, "logs"], queryFn: () => getLogs(organizationId, runId, jobId), enabled: Boolean(organizationId && runId && jobId), staleTime: 15_000 });
  const items = query.data?.items ?? [];
  const emptyJobMessage = logsState === "pending"
    ? "Waiting for runner output or GitHub log synchronization."
    : logsState === "unavailable"
      ? "GitHub no longer provides logs for this job."
      : "No unattributed job output remains.";
  return (
    <section className="log-panel" aria-labelledby={`logs-title-${jobId}`}>
      <div className="panel-kicker" id={`logs-title-${jobId}`}>Job logs</div>
      <section className="step-log-list" aria-label="Job steps">
        {steps.length === 0 ? <p className="log-meta">No attributed steps recorded.</p> : steps.map((step) => <StepLogRow key={step.id} organizationId={organizationId} runId={runId} jobId={jobId} logsState={logsState} step={step} />)}
      </section>
      <section className="unattributed-log-panel" aria-labelledby={`unattributed-logs-title-${jobId}`}>
        <div className="panel-kicker" id={`unattributed-logs-title-${jobId}`}>Unattributed job logs</div>
        <QueryState error={query.error} isLoading={query.isLoading} isEmpty={false} retry={() => void query.refetch()} operationLabel="logs" />
        {!query.isLoading && !query.error && items.length === 0 && <p className="log-meta">{emptyJobMessage}</p>}
        {items.length > 0 && <><pre className="log-viewer" tabIndex={0}>{orderedLogText(items)}</pre><p className="log-meta">Showing up to {DISPLAY_LOG_LIMIT} chunks.</p></>}
      </section>
    </section>
  );
}
