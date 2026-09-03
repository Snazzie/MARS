import { useState } from "react";
import type { PoolResources, RunDetail, RunJob, RunStage } from "@mars/contracts";
import { Badge } from "@astryxdesign/core/Badge";
import { ActionGraph } from "./ActionGraph.tsx";
import { LogViewer } from "./LogViewer.tsx";
import { RunTelemetry, formatDuration, lifecycleMetrics } from "./RunTelemetry.tsx";
import { RunTimeline } from "./RunTimeline.tsx";
type RunDetailFacts = { started: string; repository: string; runner: string; duration: string };

export function jobDetailHref(runId: string, jobId: string): string {
  return `/runs/${encodeURIComponent(runId)}#job-${encodeURIComponent(jobId)}`;
}

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

export function formatResourceValue(value: number, unit: "bytes" | "vcpu" | "slots" = "vcpu"): string {
  if (unit === "slots") return `${value} slots`;
  if (unit === "vcpu") return `${value} vCPU`;
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GiB`;
  return `${Math.round(value / 1_048_576)} MiB`;
}

function ResourceTable({ job }: { job: RunJob }) {
  const rows: [string, keyof PoolResources][] = [["vCPU", "vcpu"], ["Memory", "memoryBytes"], ["Storage", "storageBytes"], ["Concurrency", "concurrency"]];
  return <table className="resource-table"><caption>Requested versus observed resources</caption><thead><tr><th>Resource</th><th>Requested</th><th>Observed</th></tr></thead><tbody>{rows.map(([label, key]) => { const unit = key === "concurrency" ? "slots" : key === "vcpu" ? "vcpu" : "bytes"; return <tr key={key}><th>{label}</th><td>{formatResourceValue(job.requested[key], unit)}</td><td>{job.observed ? formatResourceValue(job.observed[key], unit) : "Pending attestation"}</td></tr>; })}</tbody></table>;
}

function statusLabel(data: RunDetail): string {
  return (data.conclusion ?? data.status).replaceAll("_", " ");
}

function jobStatusLabel(job: RunJob): string {
  if (job.failureReason === "out_of_memory") return "out of memory";
  return (job.conclusion ?? job.status).replaceAll("_", " ");
}
function DetailBadges({ values }: { values: readonly string[] }) {
  return <div className="detail-labels">{values.map((value, index) => <Badge key={`${value}-${index}`} label={value} />)}</div>;
}

function JobBadges({ job }: { job: RunJob }) {
  const labels = [job.runnerName ?? "Awaiting runner", ...job.requestedLabels];
  return <div className="detail-labels">{labels.map((label, index) => <Badge key={`${label}-${index}`} label={label} />)}</div>;
}

function OomNotice({ job }: { job: RunJob }) {
  if (job.failureReason !== "out_of_memory" || !job.oom) return null;
  const peak = formatResourceValue(job.oom.memoryWorkingSetBytes, "bytes");
  const limit = formatResourceValue(job.oom.memoryLimitBytes, "bytes");
  return <p className="detail-meta" role="status">Memory limit exceeded: {peak} used of {limit}. {job.oom.gracefulStopAcknowledged ? "Runner stopped gracefully." : "Runner was terminated after memory pressure."}</p>;
}


 export function RunDetailView({ data, organizationId }: { data: RunDetail; organizationId: string }) {
   const [selectedTab, setSelectedTab] = useState<"logs" | "metrics">("logs");
   const facts = runDetailFacts(data);
   const detail = data as RunDetail & { currentStage?: string; schedulerReason?: string; retryCount?: number; leaseCleanupState?: string; htmlUrl?: string; stageDurations?: Partial<Record<RunStage, number>> };
   const stageDurations = detail.stageDurations;
   const status = statusLabel(data);
   return <div className="run-detail-grid">
    <section className="detail-panel" aria-labelledby="run-detail-title">
      <nav className="detail-breadcrumb" aria-label="Workflow breadcrumb"><a href="/runs">Runs</a><span aria-hidden="true">/</span><span>{data.workflowName}</span></nav>
      <div className="detail-heading"><span className={`status status-${data.conclusion ?? data.status}`}><span className="status-icon" aria-hidden="true">●</span><span>{status}</span></span><span className="detail-run-number">Run #{data.runNumber}</span><h1 id="run-detail-title">{data.workflowName}</h1></div>
      <DetailBadges values={[data.repositoryName, data.runtimeBoundary ?? "Runtime boundary pending", data.branch, data.actorLogin, `commit ${data.commitSha.slice(0, 12)}`]} />
      <dl className="detail-facts"><div><dt>Started</dt><dd>{facts.started}</dd></div><div><dt>Repository</dt><dd>{facts.repository}</dd></div><div><dt>Runner</dt><dd>{facts.runner}</dd></div><div><dt>Duration</dt><dd>{facts.duration}</dd></div><div><dt>Current stage</dt><dd>{detail.currentStage ?? "Not reported"}</dd></div><div><dt>Retry count</dt><dd>{detail.retryCount ?? 0}</dd></div><div><dt>Lease cleanup</dt><dd>{detail.leaseCleanupState ?? "Not reported"}</dd></div></dl>
      {detail.schedulerReason && <p className="detail-meta">Scheduler block: {detail.schedulerReason}</p>}
    </section>
    <div className="detail-tabs">
      <div className="detail-tab-list" role="tablist" aria-label="Run detail views">
        <button type="button" role="tab" id="run-logs-tab" aria-selected={selectedTab === "logs"} aria-controls="run-logs-panel" tabIndex={selectedTab === "logs" ? 0 : -1} onClick={() => setSelectedTab("logs")}>Logs</button>
        <button type="button" role="tab" id="run-metrics-tab" aria-selected={selectedTab === "metrics"} aria-controls="run-metrics-panel" tabIndex={selectedTab === "metrics" ? 0 : -1} onClick={() => setSelectedTab("metrics")}>Metrics</button>
      </div>
      {selectedTab === "logs" ? <section id="run-logs-panel" role="tabpanel" aria-labelledby="run-logs-tab" className="run-tab-panel">
        {data.jobs.map((job) => <section className="run-job-logs" id={`job-${job.id}`} key={job.id}><header className="job-heading"><div><h2><a href={jobDetailHref(data.id, job.id)} target="_blank" rel="noreferrer" aria-label={`Open job ${job.name} in a new tab`}>{job.name}</a></h2><JobBadges job={job} /></div><span className={`status ${job.failureReason === "out_of_memory" ? "status-failure" : `status-${job.conclusion ?? job.status}`}`}>{jobStatusLabel(job)}</span></header><OomNotice job={job} /><LogViewer organizationId={organizationId} runId={data.id} jobId={job.id} logsState={job.logsState} steps={job.steps} /></section>)}
      </section> : <section id="run-metrics-panel" role="tabpanel" aria-labelledby="run-metrics-tab" className="run-tab-panel">
        <RunTelemetry queuedAt={data.queuedAt} startedAt={data.startedAt} completedAt={data.completedAt} />
        <RunTimeline jobs={data.jobs} durations={stageDurations} />
        <ActionGraph graph={data.actionGraph} />
        {data.jobs.map((job) => <section className="job-panel" id={`job-${job.id}`} key={job.id}><header className="job-heading"><div><h2><a href={jobDetailHref(data.id, job.id)} target="_blank" rel="noreferrer" aria-label={`Open job ${job.name} in a new tab`}>{job.name}</a></h2><JobBadges job={job} /></div><DetailBadges values={job.requestedLabels} /></header><ResourceTable job={job} /></section>)}
      </section>}
    </div>
  </div>;
}
