import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { getRun } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { RunTimeline } from "../components/RunTimeline.tsx";
import { ActionGraph } from "../components/ActionGraph.tsx";
import { LogViewer } from "../components/LogViewer.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
import { RunTelemetry } from "../components/RunTelemetry.tsx";
import type { PoolResources, RunDetail, RunJob, RunStage } from "@whitesmith/contracts";

function resourceValue(value: number, bytes = false) { if (!bytes) return `${value} vCPU`; if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GiB`; return `${Math.round(value / 1_048_576)} MiB`; }
function ResourceTable({ job }: { job: RunJob }) { const rows: [string, keyof PoolResources][] = [["vCPU", "vcpu"], ["Memory", "memoryBytes"], ["Storage", "storageBytes"], ["Concurrency", "concurrency"]]; return <table className="resource-table"><caption>Requested versus observed resources</caption><thead><tr><th>Resource</th><th>Requested</th><th>Observed</th></tr></thead><tbody>{rows.map(([label, key]) => <tr key={key}><th>{label}</th><td>{resourceValue(job.requested[key], key !== "vcpu" && key !== "concurrency")}</td><td>{job.observed ? resourceValue(job.observed[key], key !== "vcpu" && key !== "concurrency") : "Pending attestation"}</td></tr>)}</tbody></table>; }

export function RunDetailPage() {
  const { runId } = useParams({ from: "/dashboard-gate/dashboard/runs/$runId" });
  const search = useSearch({ from: "/dashboard-gate/dashboard/runs/$runId" });
  const { organizationId } = useOrganizationFromRoute();
  const detailOrganizationId = typeof search.organizationId === "string" ? search.organizationId : organizationId;
  const query = useQuery({ queryKey: ["org", detailOrganizationId, "run", runId], queryFn: () => getRun(detailOrganizationId, runId), enabled: Boolean(detailOrganizationId && runId && detailOrganizationId !== "all") });
  return <><Link className="back-link" to="/runs">← Back to runs</Link><header className="page-header"><div><p className="eyebrow">Run detail</p><h1>{query.data ? `#${query.data.runNumber} · ${query.data.workflowName}` : "Loading run detail"}</h1><p className="page-description">A single run, including the execution boundary and job lifecycle.</p></div></header><QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="run detail" />{query.data && <RunDetailContent data={query.data} organizationId={detailOrganizationId} />}</>;
}

function RunDetailContent({ data, organizationId }: { data: RunDetail; organizationId: string }) {
  const stageDurations = (data as RunDetail & { stageDurations?: Partial<Record<RunStage, number>> }).stageDurations;
  return <div className="run-detail-grid"><section className="detail-panel"><div className="detail-summary"><span className={`status status-${data.conclusion ?? data.status}`}>{data.conclusion ?? data.status.replace("_", " ")}</span><span>{data.repositoryName} · {data.branch}</span><span>{data.runtimeBoundary ?? "Boundary pending"}</span></div><p className="detail-meta">{data.event} by {data.actorLogin} · commit <code>{data.commitSha.slice(0, 12)}</code></p></section><RunTelemetry queuedAt={data.queuedAt} startedAt={data.startedAt} completedAt={data.completedAt} /><RunTimeline jobs={data.jobs} durations={stageDurations} /><ActionGraph graph={data.actionGraph} />{data.jobs.map((job) => <section className="job-panel" key={job.id}><div className="job-heading"><div><p className="panel-kicker">Job</p><h2>{job.name}</h2></div><span className={`status status-${job.conclusion ?? job.status}`}>{job.conclusion ?? job.stage.replaceAll("_", " ")}</span></div><p>{job.runnerName ?? "Runner not assigned"} · teardown {job.stage === "reaped" ? "complete" : "in progress"}</p><ResourceTable job={job} /><LogViewer organizationId={organizationId} runId={data.id} jobId={job.id} logsState={job.logsState} steps={job.steps} /></section>)}</div>;
}
