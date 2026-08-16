import { useEffect, useMemo, useState, type CSSProperties } from "react";
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

export function stepDurationPercent(step: Pick<RunStep, "durationMs" | "startedAt" | "completedAt">, maxDurationMs: number): number {
  const duration = deriveStepDuration(step) ?? 0;
  if (duration <= 0 || maxDurationMs <= 0) return 0;
  return Math.min(100, (duration / maxDurationMs) * 100);
}

export function countLogLines(text: string): number {
  if (!text) return 0;
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
}

export function stepMatchesSearch(step: Pick<RunStep, "name">, loadedText: string, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return `${step.name}\n${loadedText}`.toLowerCase().includes(query);
}

export function filterLoadedLogChunks<T extends { content: string }>(items: readonly T[], search: string): T[] {
  const query = search.trim().toLowerCase();
  if (!query) return [...items];
  return items.filter((item) => item.content.toLowerCase().includes(query));
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
  return [...items].sort((a, b) => a.sequence - b.sequence).slice(0, DISPLAY_LOG_LIMIT).map((chunk) => `${chunk.content}\n`).join("");
}

export function stepLogEmptyMessage(logsState: RunJob["logsState"]): string {
  if (logsState === "pending") return "Logs are being synchronized from the runner and GitHub.";
  if (logsState === "unavailable") return "GitHub no longer provides logs for this job.";
  return "No log lines were attributed to this step. Review the unattributed job logs below.";
}

function StepLogRow({ organizationId, runId, jobId, logsState, step, open, maxDurationMs, onOpenChange, onLoadedTextChange }: { organizationId: string; runId: string; jobId: string; logsState: RunJob["logsState"]; step: RunStep; open: boolean; maxDurationMs: number; onOpenChange: (open: boolean) => void; onLoadedTextChange: (text: string) => void }) {
  const query = useQuery({
    queryKey: ["org", organizationId, "run", runId, "job", jobId, "step", step.id, "logs"],
    queryFn: () => getStepLogs(organizationId, runId, jobId, step.id, -1, STEP_LOG_LIMIT),
    enabled: open && Boolean(organizationId && runId && jobId && step.id),
    staleTime: 15_000,
  });
  const items = query.data?.items ?? [];
  const text = orderedLogText(items);
  useEffect(() => { if (query.data) onLoadedTextChange(text); }, [query.data, text, onLoadedTextChange]);
  const duration = deriveStepDuration(step);
  const status = normalizeStepResult(step);
  const tone = step.conclusion === "failure" ? "failure" : step.conclusion === "success" ? "success" : step.status === "in_progress" ? "running" : "muted";
  const durationPercent = stepDurationPercent(step, maxDurationMs);
  const summaryStyle = { "--step-duration": `${durationPercent}%` } as CSSProperties;
  return (
    <details className="step-log-row" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary className={`step-log-summary step-tone-${tone}`} aria-expanded={open} style={summaryStyle}>
        <span className="step-log-chevron" aria-hidden="true">{open ? "⌄" : "›"}</span>
        <span className={`status status-${step.conclusion ?? step.status}`}><span aria-hidden="true">{step.conclusion === "success" ? "✓" : step.conclusion === "failure" ? "×" : "•"}</span> <span>{status}</span></span>
        <span className="step-log-lines">{query.data ? `${countLogLines(text)} lines` : "— lines"}</span>
        <span className="step-log-name"><span className="step-number">{step.number}</span>{step.name}</span>
        <span className="step-log-duration">{formatDuration(duration)}</span>
      </summary>
      <div className="step-log-body">
        <QueryState error={query.error} isLoading={query.isLoading} isEmpty={false} retry={() => void query.refetch()} operationLabel="step logs" />
        {!query.isLoading && !query.error && items.length === 0 && <p className="log-meta">{stepLogEmptyMessage(logsState)}</p>}
        {items.length > 0 && <><pre className="log-viewer" tabIndex={0} aria-label={`${step.name} log output`}>{text}</pre><p className="log-meta">Showing up to {DISPLAY_LOG_LIMIT} ordered chunks{query.data?.nextCursor ? "; more logs are available from search." : "."}</p></>}
      </div>
    </details>
  );
}

export function LogViewer({ organizationId, runId, jobId, logsState, steps = [] }: LogViewerProps) {
  const query = useQuery({ queryKey: ["org", organizationId, "run", runId, "job", jobId, "logs"], queryFn: () => getLogs(organizationId, runId, jobId), enabled: Boolean(organizationId && runId && jobId), staleTime: 15_000 });
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [loadedTextByStep, setLoadedTextByStep] = useState<Record<string, string>>({});
  const visibleSteps = useMemo(() => steps.filter((step) => stepMatchesSearch(step, loadedTextByStep[step.id] ?? "", search)), [steps, loadedTextByStep, search]);
  const maxStepDurationMs = Math.max(0, ...visibleSteps.map((step) => deriveStepDuration(step) ?? 0));
  const setStepExpanded = (stepId: string, expanded: boolean) => setExpandedStepIds((current) => { const next = new Set(current); expanded ? next.add(stepId) : next.delete(stepId); return next; });
  const setLoadedText = (stepId: string, text: string) => setLoadedTextByStep((current) => current[stepId] === text ? current : { ...current, [stepId]: text });
  const expandVisible = (expanded: boolean) => setExpandedStepIds((current) => { const next = new Set(current); visibleSteps.forEach((step) => expanded ? next.add(step.id) : next.delete(step.id)); return next; });
  const items = query.data?.items ?? [];
  const visibleItems = useMemo(() => filterLoadedLogChunks(items, search), [items, search]);
  const emptyJobMessage = logsState === "pending" ? "Waiting for runner output or GitHub log synchronization." : logsState === "unavailable" ? "GitHub no longer provides logs for this job." : "No unattributed job output remains.";
  const noMatchingJobMessage = "No matching loaded log output in unattributed job logs.";
  return <section className="log-panel" aria-labelledby={`logs-title-${jobId}`}>
    <div className="panel-kicker" id={`logs-title-${jobId}`}>Job logs</div>
    <div className="step-log-toolbar">
      <label className="step-log-search"><span>Search job steps and loaded logs</span><input aria-label="Search job steps and loaded logs" value={search} onInput={(event) => setSearch(event.currentTarget.value)} /></label>
      <div className="step-log-actions" aria-label="Step log actions"><button type="button" onClick={() => expandVisible(true)}>Expand all</button><button type="button" onClick={() => expandVisible(false)}>Collapse all</button></div>
    </div>
    <section className="step-log-list" aria-label="Job steps">
      {steps.length === 0 ? <p className="log-meta">No attributed steps recorded.</p> : visibleSteps.length === 0 ? <p className="log-meta">No steps match this search.</p> : visibleSteps.map((step) => <StepLogRow key={step.id} organizationId={organizationId} runId={runId} jobId={jobId} logsState={logsState} step={step} open={expandedStepIds.has(step.id)} maxDurationMs={maxStepDurationMs} onOpenChange={(open) => setStepExpanded(step.id, open)} onLoadedTextChange={(text) => setLoadedText(step.id, text)} />)}
    </section>
    <section className="unattributed-log-panel" aria-labelledby={`unattributed-logs-title-${jobId}`}><div className="panel-kicker" id={`unattributed-logs-title-${jobId}`}>Unattributed job logs</div><QueryState error={query.error} isLoading={query.isLoading} isEmpty={false} retry={() => void query.refetch()} operationLabel="logs" />{!query.isLoading && !query.error && visibleItems.length === 0 && <p className="log-meta">{search.trim() ? noMatchingJobMessage : items.length === 0 ? emptyJobMessage : noMatchingJobMessage}</p>}{visibleItems.length > 0 && <><pre className="log-viewer" tabIndex={0}>{orderedLogText(visibleItems)}</pre><p className="log-meta">Showing up to {DISPLAY_LOG_LIMIT} chunks.</p></>}</section>
  </section>;
}
