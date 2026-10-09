import { useState } from "react";
import type { PoolResources, RunDetail, RunJob, RunStage } from "@mars/contracts";
import { Badge } from "@astryxdesign/core/Badge";
import { ActionGraph } from "./ActionGraph.tsx";
import { LogViewer } from "./LogViewer.tsx";
import { RunTelemetry, formatDuration, lifecycleMetrics } from "./RunTelemetry.tsx";
import { RunTimeline } from "./RunTimeline.tsx";
import { AiAnalysisMetrics } from "./AiAnalysisMetrics.tsx";
type RunDetailFacts = { started: string; repository: string; runner: string; duration: string };

export function jobDetailHref(runId: string, organizationId: string, jobId: string): string {
  return `/runs/${encodeURIComponent(runId)}?organizationId=${encodeURIComponent(organizationId)}#job-${encodeURIComponent(jobId)}`;
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
  if (job.failureReason) return job.failureReason.replaceAll("_", " ");
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
function RuntimeNotice({ job }: { job: RunJob }) {
  const termination = job.termination;
  const container = termination?.container;
  if (!job.failureReason && (!termination || termination.exitCode === 0)) return null;
  return <section className="detail-meta" aria-label="Runner failure evidence">
    <h3>Runner failure evidence</h3>
    {job.failureReason === "runner_lost" && <p>Runner disappeared from worker inventory or its container was removed. This does not prove a crash or an OOM kill.</p>}
    {container?.oomKilled === true && <p>Docker confirmed an OOM kill.</p>}
    {termination ? <dl>
      <div><dt>Termination observation</dt><dd>{termination.cause.replaceAll("_", " ")}</dd></div>
      <div><dt>Exit code</dt><dd>{termination.exitObserved ? termination.exitCode : "Not observed"}</dd></div>
      {container && <>
        <div><dt>Container state</dt><dd>{container.status ?? "Unavailable"}</dd></div>
        <div><dt>Docker OOM flag</dt><dd>{container.oomKilled === null ? "Unavailable" : container.oomKilled ? "Yes" : "No"}</dd></div>
        {container.memoryLimitBytes !== null && <div><dt>RAM limit</dt><dd>{formatResourceValue(container.memoryLimitBytes, "bytes")}</dd></div>}
        {container.memorySwapLimitBytes !== null && container.memorySwapLimitBytes !== 0 && <div><dt>RAM + swap limit (Linux)</dt><dd>{container.memorySwapLimitBytes === -1 ? "Unlimited" : formatResourceValue(container.memorySwapLimitBytes, "bytes")}</dd></div>}
        {container.finishedAt && <div><dt>Container finished</dt><dd>{formatTimestamp(container.finishedAt)}</dd></div>}
      </>}
      <div><dt>Resource samples</dt><dd>{termination.sampleCount ?? "Unavailable"}{termination.lastSampleOccurredAt ? `; last ${formatTimestamp(termination.lastSampleOccurredAt)}` : ""}</dd></div>
    </dl> : <p>No exit evidence was received. Check the worker diagnostic archive and host logs.</p>}
    {container?.error && <p>Docker error: {container.error}</p>}
    {container?.waitError && <p>Docker wait connection: {container.waitError}</p>}
    {container?.inspectionError && <p>Docker inspection: {container.inspectionError}</p>}
  </section>;
}


function FailureAnalysisPanel({ data }: { data: RunDetail }) {
  if (data.conclusion !== "failure" && data.conclusion !== "timed_out") return null;
  const analysis = data.failureAnalysis;
  return <section className="detail-panel" aria-labelledby="failure-analysis-title">
    <h2 id="failure-analysis-title">Failure analysis</h2>
    {!analysis ? <p>{data.failureAnalysisEnabled ? "Awaiting failure analysis" : "Automatic failure analysis is not enabled."}</p> : <>
      <p className="detail-meta">Status: {analysis.state.replaceAll("_", " ")}</p>
      <p className="detail-meta">Provider: {analysis.providerName} · {analysis.model}</p>
      <AiAnalysisMetrics metrics={analysis.metrics} />
      {analysis.result && <>
        <p>{analysis.result.summary}</p>
        {analysis.result.failures.map((failure, index) => <article className="job-panel" key={`${failure.jobId}-${failure.stepNumber ?? "job"}-${index}`}>
          <h3>Job {failure.jobId}{failure.stepNumber == null ? "" : ` · Step ${failure.stepNumber}`}</h3>
          <p>{failure.explanation}</p>
          {failure.evidence.length > 0 && <><h4>Evidence</h4><ul>{failure.evidence.map((excerpt, evidenceIndex) => <li key={evidenceIndex}><pre>{excerpt}</pre></li>)}</ul></>}
          <h4>Potential fix</h4><p>{failure.suggestedFix}</p>
        </article>)}
      </>}
      {analysis.errorCode && <p>Analysis unavailable: {analysis.errorCode.replaceAll("_", " ")}</p>}
      {analysis.state === "skipped" && <p>Analysis skipped: {analysis.errorCode?.replaceAll("_", " ") ?? "not applicable"}.</p>}
      {analysis.comments.length > 0 ? <div><h3>Pull request feedback</h3><ul>{analysis.comments.map((comment) => <li key={comment.prNumber}>
        PR #{comment.prNumber}: {comment.state.replaceAll("_", " ")}{comment.commentUrl ? <> — <a href={comment.commentUrl} target="_blank" rel="noreferrer">View comment</a></> : ""}{comment.errorCode ? ` (${comment.errorCode.replaceAll("_", " ")})` : ""}
      </li>)}</ul></div> : analysis.state === "completed" && <p>No associated pull request.</p>}
    </>}
  </section>;
}

export function RunDetailView({ data, organizationId }: { data: RunDetail; organizationId: string }) {
  const [selectedTab, setSelectedTab] = useState<"graph" | "metrics">("graph");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => {
    if (typeof window === "undefined" || !window.location.hash.startsWith("#job-")) return null;
    try {
      const jobId = decodeURIComponent(window.location.hash.slice("#job-".length));
      return data.jobs.some((job) => job.id === jobId) ? jobId : null;
    } catch {
      return null;
    }
  });
  const facts = runDetailFacts(data);
  const detail = data as RunDetail & { currentStage?: string; schedulerReason?: string; retryCount?: number; leaseCleanupState?: string; htmlUrl?: string; stageDurations?: Partial<Record<RunStage, number>> };
  const stageDurations = detail.stageDurations;
  const status = statusLabel(data);
  const selectedJob = data.jobs.find((job) => job.id === selectedJobId) ?? null;

  return <div className="run-detail-grid">
    <section className="detail-panel" aria-labelledby="run-detail-title">
      <nav className="detail-breadcrumb" aria-label="Workflow breadcrumb"><a href="/runs">Runs</a><span aria-hidden="true">/</span><span>{data.workflowName}</span></nav>
      <div className="detail-heading"><span className={`status status-${data.conclusion ?? data.status}`}><span className="status-icon" aria-hidden="true">●</span><span>{status}</span></span><span className="detail-run-number">Run #{data.runNumber}</span><h1 id="run-detail-title">{data.workflowName}</h1></div>
      <DetailBadges values={[data.repositoryName, data.runtimeBoundary ?? "Runtime boundary pending", data.branch, data.actorLogin, `commit ${data.commitSha.slice(0, 12)}`]} />
      <dl className="detail-facts"><div><dt>Started</dt><dd>{facts.started}</dd></div><div><dt>Repository</dt><dd>{facts.repository}</dd></div><div><dt>Runner</dt><dd>{facts.runner}</dd></div><div><dt>Duration</dt><dd>{facts.duration}</dd></div><div><dt>Current stage</dt><dd>{detail.currentStage ?? "Not reported"}</dd></div><div><dt>Retry count</dt><dd>{detail.retryCount ?? 0}</dd></div><div><dt>Lease cleanup</dt><dd>{detail.leaseCleanupState ?? "Not reported"}</dd></div></dl>
      {detail.schedulerReason && <p className="detail-meta">Scheduler block: {detail.schedulerReason}</p>}
    </section>
    <FailureAnalysisPanel data={data} />
    <div className="detail-tabs">
      <div className="detail-tab-list" role="tablist" aria-label="Run detail views" onKeyDown={(event) => {
        let next: "graph" | "metrics";
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = selectedTab === "graph" ? "metrics" : "graph";
        else if (event.key === "Home") next = "graph";
        else if (event.key === "End") next = "metrics";
        else return;
        event.preventDefault();
        setSelectedTab(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`#run-${next}-tab`)?.focus();
      }}>
        <button type="button" role="tab" id="run-graph-tab" aria-selected={selectedTab === "graph"} aria-controls="run-graph-panel" tabIndex={selectedTab === "graph" ? 0 : -1} onClick={() => setSelectedTab("graph")}>Graph</button>
        <button type="button" role="tab" id="run-metrics-tab" aria-selected={selectedTab === "metrics"} aria-controls="run-metrics-panel" tabIndex={selectedTab === "metrics" ? 0 : -1} onClick={() => setSelectedTab("metrics")}>Metrics</button>
      </div>
      {selectedTab === "graph" ? <section id="run-graph-panel" role="tabpanel" tabIndex={0} aria-labelledby="run-graph-tab" className="run-tab-panel">
        <div className="run-graph-layout">
          <ActionGraph graph={data.actionGraph} selectedNodeId={selectedJobId} onNodeSelect={setSelectedJobId} />
          {selectedJob ? <section className="run-job-logs" id={`job-${selectedJob.id}`}><header className="job-heading"><div><h2>{selectedJob.name}</h2><JobBadges job={selectedJob} /></div><span className={`status ${selectedJob.failureReason ? "status-failure" : `status-${selectedJob.conclusion ?? selectedJob.status}`}`}>{jobStatusLabel(selectedJob)}</span></header><OomNotice job={selectedJob} /><RuntimeNotice job={selectedJob} /><LogViewer organizationId={organizationId} runId={data.id} jobId={selectedJob.id} logsState={selectedJob.logsState} steps={selectedJob.steps} /></section> : <p className="graph-selection-hint">Select a job in the dependency graph to inspect its logs.</p>}
        </div>
      </section> : <section id="run-metrics-panel" role="tabpanel" tabIndex={0} aria-labelledby="run-metrics-tab" className="run-tab-panel">
        <RunTelemetry queuedAt={data.queuedAt} startedAt={data.startedAt} completedAt={data.completedAt} />
        <RunTimeline jobs={data.jobs} durations={stageDurations} />
        {data.jobs.map((job) => <section className="job-panel" id={`job-${job.id}`} key={job.id}><header className="job-heading"><div><h2><a href={jobDetailHref(data.id, organizationId, job.id)} target="_blank" rel="noreferrer" aria-label={`Open job ${job.name} in a new tab`}>{job.name}</a></h2><JobBadges job={job} /></div><DetailBadges values={job.requestedLabels} /></header><ResourceTable job={job} /></section>)}
      </section>}
    </div>
  </div>;
}
