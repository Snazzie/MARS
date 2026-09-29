import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOverview } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { OutcomeBars } from "../components/OutcomeBars.tsx";
import { JobActivityChart } from "../components/JobActivityChart.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
import { RunningContainers } from "../components/RunningContainers.tsx";
import { ReportingPeriodControl } from "../components/ReportingPeriodControl.tsx";
import { GithubRunnerCostDisclosure } from "../components/GithubRunnerCostDisclosure.tsx";
import { formatMinutes, formatUsdMicros } from "../format.ts";
import type { DashboardPeriod, OverviewDto } from "@mars/contracts";
export const overviewPeriodLabels: Record<DashboardPeriod, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
export type OverviewPeriod = DashboardPeriod;
export const overviewQueryOptions = (organizationId: string, period: OverviewPeriod) => ({ queryKey: ["org", organizationId, "overview", period], queryFn: () => getOverview(organizationId, period), enabled: Boolean(organizationId), refetchInterval: 5_000 });
function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action}</header>; }
export function OverviewCostMetrics({ costSavings, period }: { costSavings: OverviewDto["costSavings"]; period: DashboardPeriod }) {
  return <><Metric label="Self-hosted minutes" value={formatMinutes(costSavings.selfHostedMinutes)} detail="GitHub-equivalent billable minutes" /><Link className="metric overview-savings-link" to="/cost-center" search={{ period }}><Metric label="Estimated savings" value={formatUsdMicros(costSavings.estimatedSavingsMicros)} detail="retail GitHub-hosted compute estimate" /><span className="overview-savings-affordance">Open Cost Center ↗</span></Link><GithubRunnerCostDisclosure costSavings={costSavings} /></>;
}

const dispatchReasons: Record<string, string> = {
  no_eligible_worker_pool: "No fresh, eligible worker pool",
  no_configured_worker_for_pool: "No worker is configured for this pool's platform and driver",
  worker_not_adopted: "Worker is not approved",
  worker_draining: "Worker is draining",
  worker_doctor_stale: "Worker runtime report is older than 60 seconds",
  pool_image_mismatch: "Worker image does not match the pool image",
  worker_not_eligible: "Worker does not meet the pool eligibility checks",
  admissible: "Worker can accept this job",
  no_matching_labels: "No pool matches the job labels",
  worker_offline: "Matching worker is offline",
  worker_config_applying: "Worker configuration is applying",
  worker_not_ready: "Worker is not configured",
  worker_runtime_not_ready: "Worker runtime or image is not ready",
  worker_pickup_paused: "Worker pickup is paused",
  pool_disabled: "Pool is disabled",
  pool_concurrency: "Pool concurrency is full",
  resource_ceiling: "Job exceeds worker resource limits",
  installation_cooldown: "GitHub installation is cooling down",
  github_rate_limited: "GitHub API rate limit",
  github_job_changed: "GitHub job is no longer queued",
  capacity_exhausted: "Capacity changed during reservation",
  invalid_provision_labels: "Invalid job routing labels",
  invalid_repository: "Invalid repository identity",
  jit_failed: "Runner registration failed",
  dispatch_failed: "Lease dispatch failed",
  lease_preserved_for_debugging: "Failed lease retained for debugging",
  duplicate_job: "Duplicate queued job",
};
const dispatchPhases: Record<NonNullable<OverviewDto["controlPlane"]>["currentPhase"] & string, string> = {
  dispatching: "Matching queued jobs, reserving workers, and sending leases",
  github_lease_reconciliation: "Checking existing leases with GitHub; new dispatch waits for this check",
  lease_cleanup: "Cleaning up prior leases; new dispatch waits for cleanup",
  onboarding: "Checking worker onboarding; new dispatch waits for this check",
};

export function ControlPlaneStatus({ status, queueReasons = [], awaiting = 0 }: { status: OverviewDto["controlPlane"]; queueReasons?: OverviewDto["queueReasons"]; awaiting?: number }) {
  if (!status) return <section className="dispatch-status-panel" aria-label="Dispatcher status"><h2>Dispatcher status</h2><p>Status unavailable</p></section>;
  const label = status.state === "healthy" ? "Reconciliation healthy" : status.state === "degraded" ? "Reconciliation degraded" : "Awaiting first reconciliation";
  const readyPools = status.currentPools?.filter(pool => pool.reason === "admissible").length ?? 0;
  const eligibleJobs = queueReasons.find(item => item.code === "eligible")?.count ?? 0;
  const nextTick = status.nextScheduledAt ? new Date(status.nextScheduledAt).toLocaleString() : null;
  return <section className="dispatch-status-panel" aria-label="Dispatcher status">
    <div className="dispatch-status-heading"><h2>Dispatcher status</h2><strong data-state={status.state}>{label}</strong></div>
    <p><strong>Now:</strong> {status.currentPhase ? dispatchPhases[status.currentPhase] : !status.nextScheduledAt ? "No dispatch timer is active" : eligibleJobs && status.currentPools && readyPools === 0 ? "Waiting for an eligible worker and pool" : "Waiting for the next dispatch tick"}{status.phaseSince && <> since <time dateTime={status.phaseSince}>{new Date(status.phaseSince).toLocaleString()}</time></>}.</p>
    <p><strong>Next:</strong> {status.currentPhase && status.dispatchPending ? "Another dispatch pass is queued as soon as the current cycle finishes." : nextTick ? <>Dispatch timer every {status.intervalMs ? `${status.intervalMs / 1_000}s` : "configured interval"}; next tick <time dateTime={status.nextScheduledAt}>{nextTick}</time>{status.currentPhase ? " (or immediately after this cycle if the timer fires while it is busy)." : "."}</> : "No dispatch timer is active."}</p>
    {status.currentPools ? <div><p><strong>Worker/pool eligibility now:</strong> {readyPools} ready match{readyPools === 1 ? "" : "es"} across {status.currentPools.length} worker/pool entr{status.currentPools.length === 1 ? "y" : "ies"}{status.currentPoolsObservedAt && <> as of <time dateTime={status.currentPoolsObservedAt}>{new Date(status.currentPoolsObservedAt).toLocaleString()}</time></>}.</p>
      {status.currentPools.length ? <details><summary>Current pool checks ({status.currentPools.length})</summary><ul>{status.currentPools.map(pool => <li key={`${pool.poolId}:${pool.workerId ?? ""}`}>{pool.poolName} ({pool.platform}{pool.workerName ? ` · ${pool.workerName}` : ""}): {dispatchReasons[pool.reason] ?? pool.reason.replaceAll("_", " ")}</li>)}</ul></details> : <p>No configured pools are visible.</p>}</div> : <p>Current worker/pool eligibility is unavailable.</p>}
    {status.lastReconciledAt ? <p>Last dispatch pass completed <time dateTime={status.lastReconciledAt}>{new Date(status.lastReconciledAt).toLocaleString()}</time>.</p> : <p>No dispatch pass has completed yet.</p>}
    {status.healthReason === "reconciliation_failed" && <p>The latest dispatch pass failed{status.failureCode ? ` (${status.failureCode.replaceAll("_", " ")})` : ""}; see control-plane logs.</p>}
    {status.healthReason === "reconciliation_stale" && <p>No dispatch pass completed within the expected interval. The previous pass below is historical, not a statement of current worker availability.</p>}
    <p>{eligibleJobs} jobs qualify for dispatch now · {awaiting} awaiting dispatch total.</p>
    {queueReasons.some(item => item.code !== "eligible") && <div><h3>Why queued jobs are not inspected</h3><ul>{queueReasons.filter(item => item.code !== "eligible").map(({ code, count }) => <li key={code}><span>{({ run_not_dispatchable: "Parent run is no longer queued or in progress", repository_unavailable: "Repository is unavailable", installation_not_approved: "GitHub installation is not approved" } as Record<string, string>)[code]}</span><b>{count}</b></li>)}</ul></div>}
    <details><summary>Previous dispatch pass: {status.queued} inspected, {status.reserved} dispatched</summary>
      {status.reasons.length ? <ul>{status.reasons.map(({ code, count }) => <li key={code}><span>{dispatchReasons[code] ?? code.replaceAll("_", " ")}</span><b>{count}</b></li>)}</ul> : <p>No blockers were recorded on that pass.</p>}
    </details>
    {status.blockedJobs?.length ? <details><summary>Previous pass blocked jobs ({status.blockedJobs.length})</summary><ul>{status.blockedJobs.map(({ jobId, code, labels, pools, repository, githubRunId, jobName }) => {
      const href = repository && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository) && githubRunId && /^[0-9]+$/.test(githubRunId)
        ? `https://github.com/${repository}/actions/runs/${githubRunId}/job/${jobId}` : null;
      const title = repository && jobName ? `${repository} · ${jobName}` : `Job ${jobId}`;
      return <li key={jobId}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{title}</a> : <strong>{title}</strong>} (job {jobId}): {dispatchReasons[code] ?? code.replaceAll("_", " ")} · Requested labels: {labels.length ? labels.join(", ") : "(none)"}{code === "invalid_provision_labels" && <span> — Use a routing label such as mars-any-2vcpu-4g.</span>}{code === "lease_preserved_for_debugging" && <span> — Inspect the preserved worker diagnostics before disabling lease preservation and cleaning up the lease.</span>}
        {pools?.length ? <details><summary>Pool diagnostics (all visible pools: {pools.length})</summary><ul>{pools.map(pool => <li key={`${pool.poolId}:${pool.workerId ?? ""}`}>{pool.poolName} ({pool.platform}{pool.workerName ? ` · ${pool.workerName}` : ""}): {dispatchReasons[pool.reason] ?? pool.reason.replaceAll("_", " ")}</li>)}</ul></details> : null}</li>;
    })}</ul></details> : null}
    <small>Queue breakdown reflects current database state; dispatch decisions reflect the last completed pass. Active and pending-cleanup leases are excluded from Awaiting dispatch. An enabled pool's ceiling does not guarantee an eligible worker.</small>
  </section>;
}
function OverviewContent({ data, period }: { data: OverviewDto; period: DashboardPeriod }) {
  return <div className="overview-grid">
    <section className="signal-panel"><div className="panel-kicker">Current load</div><div className="signal-value">{data.running}<span>/ {data.concurrency || "—"}</span></div><p>allocated job slots / configured ceiling</p><div className="load-track"><span style={{ width: `${Math.round(data.utilization.pods * 100)}%` }} /></div><div className="load-meta"><span className="load-awaiting">Awaiting dispatch <b>{data.queued}</b></span></div></section>
    <section className="metric-panel"><Metric label="Queue p50" value={`${Math.round(data.queueP50Ms / 1000)}s`} detail="median wait" /><Metric label="Queue p95" value={`${Math.round(data.queueP95Ms / 1000)}s`} detail="slowest cohort" /><Metric label="Duration p50" value={`${Math.round(data.durationP50Ms / 60000)}m`} detail="median runtime" /><Metric label="Duration p95" value={`${Math.round(data.durationP95Ms / 60000)}m`} detail="slowest cohort" /><OverviewCostMetrics costSavings={data.costSavings} period={period} /></section>
    <ControlPlaneStatus status={data.controlPlane} queueReasons={data.queueReasons} awaiting={data.queued} />
    <section className="chart-panel"><div className="panel-kicker">Pending vs running</div><JobActivityChart points={data.timeseries ?? []} /></section><section className="chart-panel"><div className="panel-kicker">Job outcomes</div><OutcomeBars outcomes={data.jobOutcomes ?? []} /></section><RunningContainers containers={data.runningContainers ?? []} />
  </div>;
}
function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }

export function OverviewPage() {
  const { organizationId } = useOrganizationFromRoute();
  const [period, setPeriod] = useState<OverviewPeriod>("24h");
  const query = useQuery(overviewQueryOptions(organizationId, period));
  return <><PageHeader eyebrow={`Signal / ${overviewPeriodLabels[period]}`} title="The fleet, at a glance." description="A quiet read on demand, capacity, and the jobs that matter now." action={<div className="overview-actions"><ReportingPeriodControl value={period} onChange={setPeriod} label="Overview time window" /><Link className="button" to="/runs">Open run ledger <span>↗</span></Link></div>} /><QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="overview telemetry" />{query.data && <OverviewContent data={query.data} period={period} />}</>;
}
