import { useEffect, useState } from "react";
import { createRootRoute, createRoute, createRouter, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations, getRepositories, getWorkers } from "./api.ts";
import { AppShell } from "./components/AppShell.tsx";
import { QueryState, StateView } from "./components/StateView.tsx";
import { OverviewPage } from "./routes/OverviewPage.tsx";
import { RunsPage } from "./routes/RunsPage.tsx";
import { RunDetailPage } from "./routes/RunDetailPage.tsx";
import { useOrganizationFromRoute } from "./routes/useOrganization.ts";
import type { OrganizationSummary, RepositorySummary, WorkerDetail } from "@whitesmith/contracts";

export function useOrganization(organizations: OrganizationSummary[]) {
  const [organizationId, setOrganizationIdState] = useState<string | null>(() => { try { return localStorage.getItem("whitesmith.organization"); } catch { return null; } });
  useEffect(() => { const sync = () => { try { setOrganizationIdState(localStorage.getItem("whitesmith.organization")); } catch { /* storage can be disabled */ } }; window.addEventListener("whitesmith-org-change", sync); return () => window.removeEventListener("whitesmith-org-change", sync); }, []);
  useEffect(() => { if (organizations.length && !organizations.some((organization) => organization.id === organizationId)) setOrganizationIdState(organizations[0].id); }, [organizations, organizationId]);
  function setOrganizationId(value: string) { setOrganizationIdState(value); try { localStorage.setItem("whitesmith.organization", value); } catch { /* storage can be disabled */ } window.dispatchEvent(new Event("whitesmith-org-change")); }
  return { organizationId, setOrganizationId };
}
function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div></header>; }
function RepositoryPage() { const { organizationId } = useOrganizationFromRoute(); const query = useQuery({ queryKey: ["org", organizationId, "repositories"], queryFn: () => getRepositories(organizationId), enabled: Boolean(organizationId) }); return <><PageHeader eyebrow="Repository registry" title="Repositories with a route." description="Only approved sources can place work on this fleet." /><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} />{query.data && <section className="list-panel">{query.data.items.map((repository: RepositorySummary) => <div className="list-row" key={repository.id}><div><strong>{repository.fullName}</strong><span>{repository.private ? "Private" : "Public"} · installation {repository.installationId}</span></div><span className={`status ${repository.approved ? "status-success" : "status-muted"}`}>{repository.approved ? "Approved" : "Pending approval"}</span></div>)}</section>}</>; }
function WorkersPage() { const { organizationId } = useOrganizationFromRoute(); const query = useQuery({ queryKey: ["org", organizationId, "workers"], queryFn: () => getWorkers(organizationId), enabled: Boolean(organizationId) }); return <><PageHeader eyebrow="Worker fleet" title="Know where work lands." description="Adoption, connection, doctor state, and capacity in one disciplined view." /><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} />{query.data && <section className="list-panel">{query.data.items.map((worker: WorkerDetail) => <div className="list-row" key={worker.id}><div><strong>{worker.name}</strong><span>{worker.platform} · {worker.driver} · {worker.fingerprint}</span></div><span className={`status status-${worker.connectionState}`}>{worker.admissionState} / {worker.connectionState}</span></div>)}</section>}</>; }
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
