import { useEffect, useState } from "react";
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { OnboardingGate } from "./components/OnboardingGate.tsx";
import { AppShell } from "./components/AppShell.tsx";
import { OnboardingPage } from "./routes/OnboardingPage.tsx";
import { OverviewPage } from "./routes/OverviewPage.tsx";
import { WorkersPage } from "./routes/WorkersPage.tsx";
import { RunsPage } from "./routes/RunsPage.tsx";
import { TimingHistoryPage } from "./routes/TimingHistoryPage.tsx";
import { RunDetailPage } from "./routes/RunDetailPage.tsx";
import { RepositoriesPage } from "./routes/RepositoriesPage.tsx";
import { PoolsPage } from "./routes/PoolsPage.tsx";
import { SettingsPage } from "./routes/SettingsPage.tsx";
import type { OrganizationSummary } from "@whitesmith/contracts";
import { z } from "zod";

export function useOrganization(organizations: OrganizationSummary[]) {
  const [organizationId, setOrganizationIdState] = useState<string>(() => { try { return localStorage.getItem("whitesmith.organization") ?? "all"; } catch { return "all"; } });
  useEffect(() => { const sync = () => { try { setOrganizationIdState(localStorage.getItem("whitesmith.organization") ?? "all"); } catch { setOrganizationIdState("all"); } }; window.addEventListener("whitesmith-org-change", sync); return () => window.removeEventListener("whitesmith-org-change", sync); }, []);
  useEffect(() => { if (organizationId === "all" || organizations.some((organization) => organization.id === organizationId)) return; setOrganizationIdState("all"); try { localStorage.setItem("whitesmith.organization", "all"); } catch { /* storage can be disabled */ } }, [organizations, organizationId]);
  function setOrganizationId(value: string) { setOrganizationIdState(value); try { localStorage.setItem("whitesmith.organization", value); } catch { /* storage can be disabled */ } window.dispatchEvent(new Event("whitesmith-org-change")); }
  return { organizationId, setOrganizationId };
}
const rootRoute = createRootRoute({ component: () => <Outlet /> });
const onboardingRoute = createRoute({ getParentRoute: () => rootRoute, path: "/onboarding", component: OnboardingPage });
const dashboardGateRoute = createRoute({ getParentRoute: () => rootRoute, id: "dashboard-gate", component: OnboardingGate });
const dashboardRoute = createRoute({ getParentRoute: () => dashboardGateRoute, id: "dashboard", component: AppShell });
const indexRoute = createRoute({ getParentRoute: () => dashboardRoute, path: "/", component: OverviewPage });
const runsRoute = createRoute({ getParentRoute: () => dashboardRoute, path: "/runs", component: RunsPage });
const timingHistoryRoute = createRoute({ getParentRoute: () => dashboardRoute, path: "/runs/timing", component: TimingHistoryPage });
const runDetailRoute = createRoute({ getParentRoute: () => dashboardRoute, path: "/runs/$runId", validateSearch: z.object({ organizationId: z.string().optional() }), component: RunDetailPage });
const repositoriesRoute = createRoute({ getParentRoute: () => dashboardRoute, path: "/repositories", component: RepositoriesPage });
const workersRoute = createRoute({ getParentRoute: () => dashboardRoute, path: "/workers", component: WorkersPage });
const poolsRoute = createRoute({ getParentRoute: () => dashboardRoute, path: "/pools", component: PoolsPage });
const settingsRoute = createRoute({ getParentRoute: () => dashboardRoute, path: "/settings", component: SettingsPage });
const routeTree = rootRoute.addChildren([onboardingRoute, dashboardGateRoute.addChildren([dashboardRoute.addChildren([indexRoute, runsRoute, timingHistoryRoute, runDetailRoute, repositoriesRoute, workersRoute, poolsRoute, settingsRoute])])]);
export const router = createRouter({ routeTree });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
