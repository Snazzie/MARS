import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOverview } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { OutcomeBars } from "../components/OutcomeBars.tsx";
import { JobActivityChart } from "../components/JobActivityChart.tsx";
import { TimeToStartChart } from "../components/TimeToStartChart.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
import { RunningContainers } from "../components/RunningContainers.tsx";
import { ReportingPeriodControl } from "../components/ReportingPeriodControl.tsx";
import { GithubRunnerCostDisclosure } from "../components/GithubRunnerCostDisclosure.tsx";
import { formatMinutes, formatUsdMicros } from "../format.ts";
import type { DashboardPeriod, OverviewDto } from "@mars/contracts";
export const overviewPeriodLabels: Record<DashboardPeriod, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
export type OverviewPeriod = DashboardPeriod;
export const overviewQueryOptions = (organizationId: string, period: OverviewPeriod) => ({ queryKey: ["org", organizationId, "overview", period], queryFn: () => getOverview(organizationId, period), enabled: Boolean(organizationId), refetchInterval: 5_000 });
function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <header className="page-header overview-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action}</header>; }
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
  admissible: "Pool matches job; worker-wide capacity may still be full",
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

type DispatcherLoad = Pick<OverviewDto, "running" | "concurrency" | "utilization">;
function CurrentLoad({ load }: { load: DispatcherLoad }) {
  const utilization = Math.round(load.utilization.pods * 100);
  return <div className="dispatch-load"><dt>Current load</dt><dd>{load.running}<span> / {load.concurrency || "—"}</span></dd><small>Allocated job slots / configured ceiling</small><div className="dispatch-load-track" aria-hidden="true"><span style={{ width: `${utilization}%` }} /></div><small>{utilization}% slot utilization</small></div>;
}

export function ControlPlaneStatus({ status, load, queueReasons = [], awaiting = 0 }: { status: OverviewDto["controlPlane"]; load: DispatcherLoad; queueReasons?: OverviewDto["queueReasons"]; awaiting?: number }) {
  if (!status) return <section className="dispatch-status-panel" aria-label="Dispatcher status"><div className="dispatch-status-heading"><div><span className="dispatch-kicker">Control plane / service</span><h2>Dispatcher status</h2></div><span className="dispatch-health" data-state="starting">Unavailable</span></div><div className="dispatch-overview"><div className="dispatch-current"><span className="dispatch-kicker">Current activity</span><h3>Telemetry unavailable</h3><p>Live load and queue counts are shown independently of dispatcher health.</p></div><dl className="dispatch-metrics dispatch-metrics-partial"><CurrentLoad load={load} /><div><dt>Awaiting dispatch</dt><dd>{awaiting}</dd><small>Total queued jobs</small></div></dl></div></section>;
  const label = status.state === "healthy" ? "Reconciliation healthy" : status.state === "degraded" ? "Reconciliation degraded" : "Awaiting first reconciliation";
  const readyPools = status.currentPools?.filter(pool => pool.reason === "admissible").length ?? 0;
  const eligibleJobs = queueReasons.find(item => item.code === "eligible")?.count ?? 0;
  const nextTick = status.nextScheduledAt ? new Date(status.nextScheduledAt).toLocaleString() : null;
  const phaseTitle = status.currentPhase ? ({ dispatching: "Dispatching jobs", github_lease_reconciliation: "Checking GitHub leases", lease_cleanup: "Cleaning up leases", onboarding: "Checking onboarding" })[status.currentPhase] : !status.nextScheduledAt ? "Timer inactive" : eligibleJobs && status.currentPools && readyPools === 0 ? "Waiting for capacity" : "Standing by";
  return <section className="dispatch-status-panel" aria-label="Dispatcher status">
    <div className="dispatch-status-heading"><div className="dispatch-title"><span className="dispatch-service-icon" aria-hidden="true">⇄</span><div><span className="dispatch-kicker">Control plane / service</span><h2>Dispatcher status</h2></div></div><span className="dispatch-health" data-state={status.state}><span aria-hidden="true" />{label}</span></div>
    <div className="dispatch-overview">
      <div className="dispatch-current"><span className="dispatch-kicker">Current activity</span><h3>{phaseTitle}</h3><p>{status.currentPhase ? dispatchPhases[status.currentPhase] : !status.nextScheduledAt ? "No dispatch timer is active" : eligibleJobs && status.currentPools && readyPools === 0 ? "Waiting for an eligible worker and pool" : "Waiting for the next dispatch tick"}.</p>{status.phaseSince && <small>Since <time dateTime={status.phaseSince}>{new Date(status.phaseSince).toLocaleString()}</time></small>}</div>
      <dl className="dispatch-metrics">
        <CurrentLoad load={load} />
        <div><dt>Awaiting dispatch</dt><dd>{awaiting}</dd><small>Total queued jobs</small></div>
        <div><dt>Qualify now</dt><dd>{eligibleJobs}</dd><small>Jobs eligible for inspection</small></div>
        <div><dt>Ready pool entries</dt><dd>{status.currentPools ? readyPools : "—"}<span> / {status.currentPools?.length ?? "—"}</span></dd><small>Before labels &amp; capacity checks</small></div>
      </dl>
    </div>
    <div className="dispatch-schedule">
      <div><span className="dispatch-kicker">Next dispatch</span><strong>{status.currentPhase && status.dispatchPending ? "Rerun queued" : nextTick ? <>Every {status.intervalMs ? `${status.intervalMs / 1_000}s` : "configured interval"}</> : "Timer inactive"}</strong><p>{status.currentPhase && status.dispatchPending ? "Another dispatch pass is queued as soon as the current cycle finishes." : nextTick ? <>Next tick <time dateTime={status.nextScheduledAt}>{nextTick}</time>{status.currentPhase ? " · Runs after this cycle if the timer fires while busy." : "."}</> : "No dispatch timer is active."}</p></div>
      <div><span className="dispatch-kicker">Last completed pass</span><strong>{status.lastReconciledAt ? <time dateTime={status.lastReconciledAt}>{new Date(status.lastReconciledAt).toLocaleString()}</time> : "No completed pass yet"}</strong><p>{status.queued} inspected · {status.reserved} dispatched</p></div>
    </div>
    {status.healthReason === "reconciliation_failed" && <p className="dispatch-alert">The latest dispatch pass failed{status.failureCode ? ` (${status.failureCode.replaceAll("_", " ")})` : ""}; see control-plane logs.</p>}
    {status.healthReason === "reconciliation_stale" && <p className="dispatch-alert">No dispatch pass completed within the expected interval. The previous pass below is historical, not a statement of current worker availability.</p>}
    <div className="dispatch-diagnostics">
      {queueReasons.some(item => item.code !== "eligible") && <div className="dispatch-exclusions"><div className="dispatch-section-heading"><h3>Queue exclusions</h3><span>Not inspected by the dispatcher</span></div><ul className="dispatch-reason-list">{queueReasons.filter(item => item.code !== "eligible").map(({ code, count }) => <li key={code}><span>{({ run_not_dispatchable: "Parent run is no longer queued or in progress", repository_unavailable: "Repository is unavailable", installation_not_approved: "GitHub installation is not approved" } as Record<string, string>)[code]}</span><b>{count}</b></li>)}</ul></div>}
      <details className="dispatch-disclosure"><summary><span>Current pool checks <small>Live worker eligibility</small></span><b>{status.currentPools?.length ?? "—"}</b></summary><div className="dispatch-disclosure-content">{status.currentPools ? <>{status.currentPoolsObservedAt && <p>Observed <time dateTime={status.currentPoolsObservedAt}>{new Date(status.currentPoolsObservedAt).toLocaleString()}</time></p>}{status.currentPools.length ? <ul className="dispatch-pool-list">{status.currentPools.map(pool => <li key={`${pool.poolId}:${pool.workerId ?? ""}`}><div><strong>{pool.poolName}</strong><small>{pool.platform}{pool.workerName ? ` · ${pool.workerName}` : ""}</small></div><span className="dispatch-pool-result" data-ready={pool.reason === "admissible"}>{pool.reason === "admissible" ? "Worker and pool ready; job labels and shared capacity not checked" : dispatchReasons[pool.reason] ?? pool.reason.replaceAll("_", " ")}</span></li>)}</ul> : <p>No configured pools are visible.</p>}</> : <p>Current worker/pool eligibility is unavailable.</p>}</div></details>
      <details className="dispatch-disclosure"><summary><span>Previous dispatch pass <small>{status.queued} inspected · {status.reserved} dispatched</small></span><span className="dispatch-history-tag">Historical</span></summary><div className="dispatch-disclosure-content">
        {status.reasons.length ? <ul className="dispatch-reason-list">{status.reasons.map(({ code, count }) => <li key={code}><span>{dispatchReasons[code] ?? code.replaceAll("_", " ")}</span><b>{count}</b></li>)}</ul> : <p>No blockers were recorded on that pass.</p>}
      </div></details>
      {status.blockedJobs?.length ? <details className="dispatch-disclosure"><summary><span>Previous pass blocked jobs <small>Job-level routing diagnostics</small></span><b>{status.blockedJobs.length}</b></summary><ul className="dispatch-blocked-jobs">{status.blockedJobs.map(({ jobId, code, labels, pools, repository, githubRunId, jobName }) => {
      const href = repository && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository) && githubRunId && /^[0-9]+$/.test(githubRunId)
        ? `https://github.com/${repository}/actions/runs/${githubRunId}/job/${jobId}` : null;
      const title = repository && jobName ? `${repository} · ${jobName}` : `Job ${jobId}`;
      return <li key={jobId}><div className="dispatch-job-heading">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{title} ↗</a> : <strong>{title}</strong>}<small>Job {jobId}</small></div><p className="dispatch-job-reason">{dispatchReasons[code] ?? code.replaceAll("_", " ")}</p><div className="dispatch-job-labels"><span>Requested labels</span>{labels.length ? labels.map(value => <code key={value}>{value}</code>) : <small>(none)</small>}</div>{code === "invalid_provision_labels" && <p>Use a routing label such as <code>mars-any-2vcpu-4g</code>.</p>}{code === "lease_preserved_for_debugging" && <p>Inspect the preserved worker diagnostics before disabling lease preservation and cleaning up the lease.</p>}
        {pools?.length ? <details className="dispatch-job-pools"><summary>Pool diagnostics (all visible pools: {pools.length})</summary><ul className="dispatch-pool-list">{pools.map(pool => <li key={`${pool.poolId}:${pool.workerId ?? ""}`}><div><strong>{pool.poolName}</strong><small>{pool.platform}{pool.workerName ? ` · ${pool.workerName}` : ""}</small></div><span className="dispatch-pool-result" data-ready={pool.reason === "admissible"}>{dispatchReasons[pool.reason] ?? pool.reason.replaceAll("_", " ")}</span></li>)}</ul></details> : null}</li>;
      })}</ul></details> : null}
    </div>
    <p className="dispatch-footnote">Queue counts are live; previous-pass decisions are historical. Active and pending-cleanup leases are excluded. Ready pool entries still require matching job labels and available shared capacity.</p>
  </section>;
}
function OverviewContent({ data, period }: { data: OverviewDto; period: DashboardPeriod }) {
  return <div className="overview-grid">
    <ControlPlaneStatus status={data.controlPlane} load={data} queueReasons={data.queueReasons} awaiting={data.queued} />
    <section className="metric-panel"><Metric label="Queue p50" value={`${Math.round(data.queueP50Ms / 1000)}s`} detail="median wait" /><Metric label="Queue p95" value={`${Math.round(data.queueP95Ms / 1000)}s`} detail="slowest cohort" /><Metric label="Duration p50" value={`${Math.round(data.durationP50Ms / 60000)}m`} detail="median runtime" /><Metric label="Duration p95" value={`${Math.round(data.durationP95Ms / 60000)}m`} detail="slowest cohort" /><OverviewCostMetrics costSavings={data.costSavings} period={period} /></section>
    <section className="chart-panel time-to-start-panel" aria-label="Time to start"><div className="panel-kicker">Time to start</div><p className="chart-empty">Queued to running · p50 median and p95 wait by job start time · {period === "24h" ? "hourly" : "daily"} buckets. Gaps mean no jobs started.</p><TimeToStartChart points={data.timeToStart} period={period} /></section>
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
