import { useEffect, useState } from "react";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "./components/AppShell.tsx";
import { OverviewPage } from "./routes/OverviewPage.tsx";
import { WorkersPage } from "./routes/WorkersPage.tsx";
import { RunsPage } from "./routes/RunsPage.tsx";
import { RunDetailPage } from "./routes/RunDetailPage.tsx";
import { RepositoriesPage } from "./routes/RepositoriesPage.tsx";
import { PoolsPage } from "./routes/PoolsPage.tsx";
import { SettingsPage } from "./routes/SettingsPage.tsx";
import type { OrganizationSummary } from "@whitesmith/contracts";

export function useOrganization(organizations: OrganizationSummary[]) {
  const [organizationId, setOrganizationIdState] = useState<string | null>(() => { try { return localStorage.getItem("whitesmith.organization"); } catch { return null; } });
  useEffect(() => { const sync = () => { try { setOrganizationIdState(localStorage.getItem("whitesmith.organization")); } catch { /* storage can be disabled */ } }; window.addEventListener("whitesmith-org-change", sync); return () => window.removeEventListener("whitesmith-org-change", sync); }, []);
  useEffect(() => { if (organizations.length && !organizations.some((organization) => organization.id === organizationId)) setOrganizationIdState(organizations[0].id); }, [organizations, organizationId]);
  function setOrganizationId(value: string) { setOrganizationIdState(value); try { localStorage.setItem("whitesmith.organization", value); } catch { /* storage can be disabled */ } window.dispatchEvent(new Event("whitesmith-org-change")); }
  return { organizationId, setOrganizationId };
}
const rootRoute = createRootRoute({ component: () => <AppShell /> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage });
const runsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs", component: RunsPage });
const runDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs/$runId", component: RunDetailPage });
const repositoriesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/repositories", component: RepositoriesPage });
const workersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workers", component: WorkersPage });
const poolsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pools", component: PoolsPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const routeTree = rootRoute.addChildren([indexRoute, runsRoute, runDetailRoute, repositoriesRoute, workersRoute, poolsRoute, settingsRoute]);
export const router = createRouter({ routeTree });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
