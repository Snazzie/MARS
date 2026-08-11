import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOverview } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { OutcomeBars } from "../components/OutcomeBars.tsx";
import { TrendChart } from "../components/TrendChart.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
import type { OverviewDto } from "@whitesmith/contracts";

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action}</header>; }
function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }

export function OverviewPage() {
  const { organizationId } = useOrganizationFromRoute();
  const query = useQuery({ queryKey: ["org", organizationId, "overview", "24h"], queryFn: () => getOverview(organizationId, "24h"), enabled: Boolean(organizationId) });
  return <><PageHeader eyebrow="Signal / 24 hours" title="The fleet, at a glance." description="A quiet read on demand, capacity, and the jobs that matter now." action={<Link className="button" to="/runs">Open run ledger <span>↗</span></Link>} /><QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} />{query.data && <OverviewContent data={query.data} />}</>;
}

function OverviewContent({ data }: { data: OverviewDto }) {
  const outcomes = [{ label: "Completed", value: data.completed }, { label: "Failed", value: data.failed }, { label: "Running", value: data.running }, { label: "Queued", value: data.queued }];
  const utilization = [{ label: "vCPU", value: Math.round(data.utilization.vcpu * 100) }, { label: "Memory", value: Math.round(data.utilization.memory * 100) }, { label: "Storage", value: Math.round(data.utilization.storage * 100) }, { label: "Pods", value: Math.round(data.utilization.pods * 100) }];
  return <div className="overview-grid"><section className="signal-panel"><div className="panel-kicker">Current load</div><div className="signal-value">{data.running}<span>/ {data.concurrency || "—"}</span></div><p>active runs / concurrency ceiling</p><div className="load-track"><span style={{ width: `${Math.round(data.utilization.pods * 100)}%` }} /></div><div className="load-meta"><span>Queue <b>{data.queued}</b></span><span>Completed <b>{data.completed}</b></span><span>Failed <b>{data.failed}</b></span></div></section><section className="metric-panel"><Metric label="Queue p50" value={`${Math.round(data.queueP50Ms / 1000)}s`} detail="median wait" /><Metric label="Queue p95" value={`${Math.round(data.queueP95Ms / 1000)}s`} detail="slowest cohort" /><Metric label="Duration p50" value={`${Math.round(data.durationP50Ms / 60000)}m`} detail="median runtime" /><Metric label="Duration p95" value={`${Math.round(data.durationP95Ms / 60000)}m`} detail="slowest cohort" /></section><section className="chart-panel"><div className="panel-kicker">Capacity pressure</div><TrendChart points={utilization} label="Utilization percent" /></section><section className="chart-panel"><div className="panel-kicker">Run outcomes</div><OutcomeBars outcomes={outcomes} /></section></div>;
}
