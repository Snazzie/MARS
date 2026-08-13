import { useState } from "react";
import type { PoolResources, RunDetail, RunJob, RunStage } from "@whitesmith/contracts";
import { ActionGraph } from "./ActionGraph.tsx";
import { LogViewer } from "./LogViewer.tsx";
import { RunTelemetry, formatDuration, lifecycleMetrics } from "./RunTelemetry.tsx";
import { RunTimeline } from "./RunTimeline.tsx";

type RunDetailFacts = { started: string; repository: string; runner: string; duration: string };

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function runDetailFacts(data: RunDetail): RunDetailFacts {
  const metrics = lifecycleMetrics(data.queuedAt, data.startedAt, data.completedAt);
  return {
    started: data.startedAt ? formatTimestamp(data.startedAt) : "Not started",
    repository: data.repositoryName,
    runner: data.jobs.find((job) => job.runnerName)?.runnerName ?? "Awaiting runner",
    duration: metrics.runDurationMs === null ? "In progress" : formatDuration(metrics.runDurationMs),
  };
}

function resourceValue(value: number, bytes = false): string {
  if (!bytes) return `${value} vCPU`;
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GiB`;
  return `${Math.round(value / 1_048_576)} MiB`;
}

function ResourceTable({ job }: { job: RunJob }) {
  const rows: [string, keyof PoolResources][] = [["vCPU", "vcpu"], ["Memory", "memoryBytes"], ["Storage", "storageBytes"], ["Concurrency", "concurrency"]];
  return <table className="resource-table"><caption>Requested versus observed resources</caption><thead><tr><th>Resource</th><th>Requested</th><th>Observed</th></tr></thead><tbody>{rows.map(([label, key]) => <tr key={key}><th>{label}</th><td>{resourceValue(job.requested[key], key !== "vcpu" && key !== "concurrency")}</td><td>{job.observed ? resourceValue(job.observed[key], key !== "vcpu" && key !== "concurrency") : "Pending attestation"}</td></tr>)}</tbody></table>;
}

function statusLabel(data: RunDetail): string {
  return (data.conclusion ?? data.status).replaceAll("_", " ");
}

function jobStatusLabel(job: RunJob): string {
  return (job.conclusion ?? job.status).replaceAll("_", " ");
}

export function RunDetailView({ data, organizationId }: { data: RunDetail; organizationId: string }) {
  const [selectedTab, setSelectedTab] = useState<"logs" | "metrics">("logs");
  const facts = runDetailFacts(data);
  const stageDurations = (data as RunDetail & { stageDurations?: Partial<Record<RunStage, number>> }).stageDurations;
  const status = statusLabel(data);
  return <div className="run-detail-grid">
    <section className="detail-panel" aria-labelledby="run-detail-title">
      <nav className="detail-breadcrumb" aria-label="Workflow breadcrumb"><a href="/runs">Runs</a><span aria-hidden="true">/</span><span>{data.workflowName}</span></nav>
      <div className="detail-heading"><span className={`status status-${data.conclusion ?? data.status}`}><span className="status-icon" aria-hidden="true">●</span><span>{status}</span></span><span className="detail-run-number">Run #{data.runNumber}</span><h1 id="run-detail-title">{data.workflowName}</h1></div>
      <div className="detail-context"><span>{data.repositoryName}</span><span>{data.runtimeBoundary ?? "Runtime boundary pending"}</span><span>{data.branch}</span><span>{data.actorLogin}</span><span>commit <code>{data.commitSha.slice(0, 12)}</code></span></div>
      <dl className="detail-facts"><div><dt>Started</dt><dd>{facts.started}</dd></div><div><dt>Repository</dt><dd>{facts.repository}</dd></div><div><dt>Runner</dt><dd>{facts.runner}</dd></div><div><dt>Duration</dt><dd>{facts.duration}</dd></div></dl>
      <p className="detail-meta">{data.event} event</p>
    </section>
    <div className="detail-tabs">
      <div className="detail-tab-list" role="tablist" aria-label="Run detail views">
        <button type="button" role="tab" id="run-logs-tab" aria-selected={selectedTab === "logs"} aria-controls="run-logs-panel" tabIndex={selectedTab === "logs" ? 0 : -1} onClick={() => setSelectedTab("logs")}>Logs</button>
        <button type="button" role="tab" id="run-metrics-tab" aria-selected={selectedTab === "metrics"} aria-controls="run-metrics-panel" tabIndex={selectedTab === "metrics" ? 0 : -1} onClick={() => setSelectedTab("metrics")}>Metrics</button>
      </div>
      {selectedTab === "logs" ? <section id="run-logs-panel" role="tabpanel" aria-labelledby="run-logs-tab" className="run-tab-panel">
        {data.jobs.map((job) => <section className="run-job-logs" key={job.id}><header className="job-heading"><div><h2>{job.name}</h2><p>{job.runnerName ?? "Awaiting runner"} · {job.requestedLabels.join(", ")}</p></div><span className={`status status-${job.conclusion ?? job.status}`}>{jobStatusLabel(job)}</span></header><LogViewer organizationId={organizationId} runId={data.id} jobId={job.id} logsState={job.logsState} steps={job.steps} /></section>)}
      </section> : <section id="run-metrics-panel" role="tabpanel" aria-labelledby="run-metrics-tab" className="run-tab-panel">
        <RunTelemetry queuedAt={data.queuedAt} startedAt={data.startedAt} completedAt={data.completedAt} />
        <RunTimeline jobs={data.jobs} durations={stageDurations} />
        <ActionGraph graph={data.actionGraph} />
        {data.jobs.map((job) => <section className="job-panel" key={job.id}><header className="job-heading"><div><h2>{job.name}</h2><p>{job.runnerName ?? "Awaiting runner"}</p></div><span>{job.requestedLabels.join(", ")}</span></header><ResourceTable job={job} /></section>)}
      </section>}
    </div>
  </div>;
}
