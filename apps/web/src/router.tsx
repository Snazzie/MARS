import { useEffect, useState } from "react";
import { createRootRoute, createRoute, createRouter, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations, getOverview, getRepositories, getRun, getRuns, getWorkers } from "./api.ts";
import { AppShell } from "./components/AppShell.tsx";
import { QueryState, StateView } from "./components/StateView.tsx";
import type { OrganizationSummary, OverviewDto, RepositorySummary, RunSummary, WorkerDetail } from "@whitesmith/contracts";

export function useOrganization(organizations: OrganizationSummary[]) {
  const [organizationId, setOrganizationIdState] = useState<string | null>(() => {
    try { return localStorage.getItem("whitesmith.organization"); } catch { return null; }
  });
  useEffect(() => {
    const sync = () => {
      try { setOrganizationIdState(localStorage.getItem("whitesmith.organization")); } catch { /* storage can be disabled */ }
    };
    window.addEventListener("whitesmith-org-change", sync);
    return () => window.removeEventListener("whitesmith-org-change", sync);
  }, []);
  useEffect(() => {
    if (organizations.length && !organizations.some((organization) => organization.id === organizationId)) setOrganizationIdState(organizations[0].id);
  }, [organizations, organizationId]);
  function setOrganizationId(value: string) {
    setOrganizationIdState(value);
    try { localStorage.setItem("whitesmith.organization", value); } catch { /* storage can be disabled */ }
    window.dispatchEvent(new Event("whitesmith-org-change"));
  }
  return { organizationId, setOrganizationId };
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{action}</header>;
}
function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function OverviewPage() {
  const { organizationId } = useOrganizationFromRoute();
  const query = useQuery({ queryKey: ["org", organizationId, "overview", "24h"], queryFn: () => getOverview(organizationId, "24h") });
  return <><PageHeader eyebrow="Signal / 24 hours" title="The fleet, at a glance." description="A quiet read on demand, capacity, and the jobs that matter now." action={<Link className="button" to="/runs">Open run ledger <span>↗</span></Link>} />
    <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} />{query.data && <OverviewContent data={query.data} />}</>;
}
function OverviewContent({ data }: { data: OverviewDto }) {
  return <div className="overview-grid"><section className="signal-panel"><div className="panel-kicker">Current load</div><div className="signal-value">{data.running}<span>/ {data.concurrency || "—"}</span></div><p>active runs / concurrency ceiling</p><div className="load-track"><span style={{ width: `${Math.round(data.utilization.pods * 100)}%` }} /></div><div className="load-meta"><span>Queue <b>{data.queued}</b></span><span>Completed <b>{data.completed}</b></span><span>Failed <b>{data.failed}</b></span></div></section><section className="metric-panel"><Metric label="Queue p50" value={`${Math.round(data.queueP50Ms / 1000)}s`} detail="median wait" /><Metric label="Queue p95" value={`${Math.round(data.queueP95Ms / 1000)}s`} detail="slowest cohort" /><Metric label="Run p50" value={`${Math.round(data.durationP50Ms / 60000)}m`} detail="median duration" /><Metric label="Run p95" value={`${Math.round(data.durationP95Ms / 60000)}m`} detail="long tail" /></section><section className="utilization-panel"><div className="panel-kicker">Resource utilization</div>{([['vCPU', data.utilization.vcpu], ['Memory', data.utilization.memory], ['Storage', data.utilization.storage], ['Pods', data.utilization.pods]] as const).map(([label, value]) => <div className="util-row" key={label}><span>{label}</span><div className="util-track"><i style={{ width: `${Math.round(value * 100)}%` }} /></div><b>{Math.round(value * 100)}%</b></div>)}</section></div>;
}
function useOrganizationFromRoute() {
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const [organizationId, setOrganizationId] = useState(() => {
    try { return localStorage.getItem("whitesmith.organization") ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    const sync = () => {
      try { setOrganizationId(localStorage.getItem("whitesmith.organization") ?? ""); } catch { /* storage can be disabled */ }
    };
    window.addEventListener("whitesmith-org-change", sync);
    return () => window.removeEventListener("whitesmith-org-change", sync);
  }, []);
  useEffect(() => {
    if (!organizationId && organizationsQuery.data?.[0]) setOrganizationId(organizationsQuery.data[0].id);
  }, [organizationId, organizationsQuery.data]);
  return { organizationId };
}
function RunsPage() { const { organizationId } = useOrganizationFromRoute(); const query = useQuery({ queryKey: ["org", organizationId, "runs"], queryFn: () => getRuns(organizationId), enabled: Boolean(organizationId) }); return <><PageHeader eyebrow="Run ledger" title="Every execution, accounted for." description="Trace GitHub work from queue to teardown without losing the boundary." /><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} />{query.data && query.data.items.length > 0 && <RunTable runs={query.data.items} />}</>; }
function RunTable({ runs }: { runs: RunSummary[] }) { return <section className="table-panel"><table><caption className="sr-only">Recent workflow runs</caption><thead><tr><th>Run</th><th>Repository</th><th>Status</th><th>Boundary</th><th>Duration</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td><Link to="/runs/$runId" params={{ runId: run.id }}><strong>#{run.runNumber}</strong><span>{run.workflowName}</span></Link></td><td>{run.repositoryName}<small>{run.branch}</small></td><td><span className={`status status-${run.status}`}>{run.conclusion ?? run.status.replace("_", " ")}</span></td><td>{run.runtimeBoundary ?? "Pending allocation"}</td><td>{Math.round(run.durationMs / 60000)}m</td></tr>)}</tbody></table></section>; }
function RunDetailPage() { const { runId } = useParams({ from: "/runs/$runId" }); const { organizationId } = useOrganizationFromRoute(); const query = useQuery({ queryKey: ["org", organizationId, "run", runId], queryFn: () => getRun(organizationId, runId), enabled: Boolean(organizationId) }); return <><Link className="back-link" to="/runs">← Back to runs</Link><PageHeader eyebrow="Run detail" title={query.data ? `#${query.data.runNumber} · ${query.data.workflowName}` : "Loading run detail"} description="A single run, including the execution boundary and job lifecycle." /><QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} />{query.data && <section className="detail-panel"><div className="detail-summary"><span className={`status status-${query.data.status}`}>{query.data.conclusion ?? query.data.status}</span><span>{query.data.repositoryName}</span><span>{query.data.runtimeBoundary ?? "Boundary pending"}</span></div>{query.data.jobs.map((job) => <div className="job-row" key={job.id}><span className="job-stage">{job.stage.replaceAll("_", " ")}</span><strong>{job.name}</strong><span>{job.runnerName ?? "Awaiting runner"}</span></div>)}</section>}</>; }
function RepositoryPage() { const { organizationId } = useOrganizationFromRoute(); const query = useQuery({ queryKey: ["org", organizationId, "repositories"], queryFn: () => getRepositories(organizationId), enabled: Boolean(organizationId) }); return <CollectionPage eyebrow="Repository registry" title="Repositories with a route." description="Only approved sources can place work on this fleet." error={query.error} loading={query.isLoading} empty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()}>{query.data?.items.map((repository: RepositorySummary) => <div className="list-row" key={repository.id}><div><strong>{repository.fullName}</strong><span>{repository.private ? "Private" : "Public"} · installation {repository.installationId}</span></div><span className={`status ${repository.approved ? "status-success" : "status-muted"}`}>{repository.approved ? "Approved" : "Pending approval"}</span></div>)}</CollectionPage>; }
function WorkersPage() { const { organizationId } = useOrganizationFromRoute(); const query = useQuery({ queryKey: ["org", organizationId, "workers"], queryFn: () => getWorkers(organizationId), enabled: Boolean(organizationId) }); return <CollectionPage eyebrow="Worker fleet" title="Know where work lands." description="Adoption, connection, doctor state, and capacity in one disciplined view." error={query.error} loading={query.isLoading} empty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()}>{query.data?.items.map((worker: WorkerDetail) => <div className="list-row" key={worker.id}><div><strong>{worker.name}</strong><span>{worker.platform} · {worker.driver} · {worker.fingerprint}</span></div><span className={`status status-${worker.connectionState}`}>{worker.admissionState} / {worker.connectionState}</span></div>)}</CollectionPage>; }
function CollectionPage({ eyebrow, title, description, error, loading, empty, retry, children }: { eyebrow: string; title: string; description: string; error: unknown; loading: boolean; empty: boolean; retry: () => void; children: React.ReactNode }) { return <><PageHeader eyebrow={eyebrow} title={title} description={description} /><QueryState error={error} isLoading={loading} isEmpty={empty} retry={retry} />{!loading && !error && !empty && <section className="list-panel">{children}</section>}</>; }
function PlaceholderPage({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <><PageHeader eyebrow={eyebrow} title={title} description={description} /><StateView kind="empty" title="Nothing configured here yet" message="The route is ready for the next control-plane capability." /></>; }

const rootRoute = createRootRoute({ component: () => <AppShell /> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });
const runsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs", component: RunsPage });
const runDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs/$runId", component: RunDetailPage });
const repositoriesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/repositories", component: RepositoryPage });
const workersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workers", component: WorkersPage });
const poolsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pools", component: () => <PlaceholderPage eyebrow="Runner pools" title="Shape capacity with intent." description="Pool labels and ceilings keep every job honest." /> });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => <PlaceholderPage eyebrow="Organization settings" title="Make the defaults explicit." description="Retention, access, and routing controls will live here." /> });
const routeTree = rootRoute.addChildren([indexRoute, runsRoute, runDetailRoute, repositoriesRoute, workersRoute, poolsRoute, settingsRoute]);
export const router = createRouter({ routeTree });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
