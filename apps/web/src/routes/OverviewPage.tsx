import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOverview } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { OutcomeBars } from "../components/OutcomeBars.tsx";
import { JobActivityChart } from "../components/JobActivityChart.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
import { RunningContainers } from "../components/RunningContainers.tsx";
import type { OverviewDto } from "@whitesmith/contracts";
export type OverviewPeriod = "24h" | "7d" | "30d";
export const overviewPeriodLabels: Record<OverviewPeriod, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const overviewPeriods: readonly OverviewPeriod[] = ["24h", "7d", "30d"];
export const overviewQueryOptions = (organizationId: string, period: OverviewPeriod) => ({ queryKey: ["org", organizationId, "overview", period], queryFn: () => getOverview(organizationId, period), enabled: Boolean(organizationId) });

export function OverviewPeriodControl({ value, onChange }: { value: OverviewPeriod; onChange: (period: OverviewPeriod) => void }) {
  return <fieldset className="overview-period-control" aria-label="Overview time window"><legend className="sr-only">Overview time window</legend>{overviewPeriods.map((period) => <label key={period} className={value === period ? "is-selected" : ""}><input type="radio" name="overview-period" value={period} checked={value === period} onChange={() => onChange(period)} /><span>{period}</span></label>)}</fieldset>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action}</header>; }
function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }

export function OverviewPage() {
  const { organizationId } = useOrganizationFromRoute();
  const [period, setPeriod] = useState<OverviewPeriod>("24h");
  const query = useQuery(overviewQueryOptions(organizationId, period));
  return <><PageHeader eyebrow={`Signal / ${overviewPeriodLabels[period]}`} title="The fleet, at a glance." description="A quiet read on demand, capacity, and the jobs that matter now." action={<div className="overview-actions"><OverviewPeriodControl value={period} onChange={setPeriod} /><Link className="button" to="/runs">Open run ledger <span>↗</span></Link></div>} /><QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="overview telemetry" />{query.data && <OverviewContent data={query.data} />}</>;
}

function OverviewContent({ data }: { data: OverviewDto }) {
  return <div className="overview-grid"><section className="signal-panel"><div className="panel-kicker">Current load</div><div className="signal-value">{data.running}<span>/ {data.concurrency || "—"}</span></div><p>active runs / concurrency ceiling</p><div className="load-track"><span style={{ width: `${Math.round(data.utilization.pods * 100)}%` }} /></div><div className="load-meta"><span>Queue <b>{data.queued}</b></span><span>Completed <b>{data.completed}</b></span><span>Failed <b>{data.failed}</b></span></div></section><section className="metric-panel"><Metric label="Queue p50" value={`${Math.round(data.queueP50Ms / 1000)}s`} detail="median wait" /><Metric label="Queue p95" value={`${Math.round(data.queueP95Ms / 1000)}s`} detail="slowest cohort" /><Metric label="Duration p50" value={`${Math.round(data.durationP50Ms / 60000)}m`} detail="median runtime" /><Metric label="Duration p95" value={`${Math.round(data.durationP95Ms / 60000)}m`} detail="slowest cohort" /></section><section className="chart-panel"><div className="panel-kicker">Pending vs running</div><JobActivityChart points={data.timeseries ?? []} /></section><section className="chart-panel"><div className="panel-kicker">Job outcomes</div><OutcomeBars outcomes={data.jobOutcomes ?? []} /></section><RunningContainers containers={data.runningContainers ?? []} /></div>;
}
