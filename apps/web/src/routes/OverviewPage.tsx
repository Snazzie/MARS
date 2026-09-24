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
  duplicate_job: "Duplicate queued job",
};
export function ControlPlaneStatus({ status }: { status: OverviewDto["controlPlane"] }) {
  if (!status) return <section className="dispatch-status-panel"><h2>Control plane</h2><p>Status unavailable</p></section>;
  const label = status.state === "healthy" ? "Reconciliation healthy" : status.state === "degraded" ? "Reconciliation degraded" : "Awaiting first reconciliation";
  return <section className="dispatch-status-panel" aria-label="Control plane dispatch status">
    <div className="dispatch-status-heading"><h2>Control plane</h2><strong data-state={status.state}>{label}</strong></div>
    <p>{status.lastReconciledAt ? <>Last successful reconciliation <time dateTime={status.lastReconciledAt}>{new Date(status.lastReconciledAt).toLocaleString()}</time></> : "No successful reconciliation yet"}</p>
    <p>{status.queued} queued jobs inspected · {status.reserved} {status.reserved === 1 ? "lease" : "leases"} dispatched on last pass</p>
    {status.reasons.length ? <ul>{status.reasons.map(({ code, count }) => <li key={code}><span>{dispatchReasons[code] ?? code.replaceAll("_", " ")}</span><b>{count}</b></li>)}</ul> : <p>{status.queued ? "No dispatch blockers reported on the last pass." : "No eligible queued jobs were inspected on the last pass."}</p>}
    <small>Only jobs eligible for reconciliation are counted; unavailable repositories, unapproved installations, or existing leases are excluded.</small>
  </section>;
}
function OverviewContent({ data, period }: { data: OverviewDto; period: DashboardPeriod }) {
  return <div className="overview-grid">
    <section className="signal-panel"><div className="panel-kicker">Current load</div><div className="signal-value">{data.running}<span>/ {data.concurrency || "—"}</span></div><p>allocated job slots / configured ceiling</p><div className="load-track"><span style={{ width: `${Math.round(data.utilization.pods * 100)}%` }} /></div><div className="load-meta"><span className="load-awaiting">Awaiting dispatch <b>{data.queued}</b></span></div></section>
    <section className="metric-panel"><Metric label="Queue p50" value={`${Math.round(data.queueP50Ms / 1000)}s`} detail="median wait" /><Metric label="Queue p95" value={`${Math.round(data.queueP95Ms / 1000)}s`} detail="slowest cohort" /><Metric label="Duration p50" value={`${Math.round(data.durationP50Ms / 60000)}m`} detail="median runtime" /><Metric label="Duration p95" value={`${Math.round(data.durationP95Ms / 60000)}m`} detail="slowest cohort" /><OverviewCostMetrics costSavings={data.costSavings} period={period} /></section>
    <ControlPlaneStatus status={data.controlPlane} />
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
