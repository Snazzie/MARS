import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getHealth, getMe, getOrganizations } from "../api.ts";
import { useOrganization } from "../organization.ts";
import { QueryState } from "./StateView.tsx";
import { ContextHelp } from "./ContextHelp.tsx";
import { useDashboardInvalidations } from "../useDashboardInvalidations.ts";
import { buildRouteNavigation, type NavigationHelp, type NavigationItem } from "../navigation.ts";

function NavigationLinks({ items, current, activeRouteIds, nested = false }: { items: NavigationItem[]; current: NavigationItem | undefined; activeRouteIds: ReadonlySet<string>; nested?: boolean }) {
  return items.map((item, index) => {
    const selected = current?.routeId === item.routeId;
    return <div key={item.routeId}>
      <Link to={item.to} activeOptions={{ exact: true }} className={`nav-link${nested ? " nav-sublink" : ""}${activeRouteIds.has(item.routeId) ? " is-active" : ""}`} aria-current={selected ? "page" : undefined}>
        {!nested && <span className="nav-number">{String(index + 1).padStart(2, "0")}</span>}<span>{item.label}</span>
      </Link>
      {item.children.length > 0 && <div className="nav-subitems" role="group" aria-label={`${item.label} pages`}><NavigationLinks items={item.children} current={current} activeRouteIds={activeRouteIds} nested /></div>}
    </div>;
  });
}

export function AppShell() {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const location = useRouterState({ select: (state) => state.location.pathname });
  const router = useRouter();
  const matches = useRouterState({ select: (state) => state.matches });
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval: (query) => query.state.error ? 10_000 : 5_000, refetchIntervalInBackground: false });
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const organizations = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, enabled: !me.isLoading && !me.error });
  const { organizationId, setOrganizationId } = useOrganization(organizations.data);
  useDashboardInvalidations(organizationId);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const inSettings = matches.some(match => router.routesById[match.routeId]?.options.staticData?.navigation?.section === "settings");
  const navigation = useMemo(() => buildRouteNavigation(Object.values(router.routesById), inSettings ? "settings" : "primary", Boolean(me.data?.isGlobalAdmin)), [router, inSettings, me.data?.isGlobalAdmin]);
  const state = me.isLoading || organizations.isLoading || me.error || organizations.error
    ? <QueryState error={me.error ?? organizations.error} isLoading={me.isLoading || organizations.isLoading} retry={() => { void me.refetch(); void organizations.refetch(); }} operationLabel="workspace data" />
    : null;
  const matchedNavigation = matches.reduce<NavigationItem | undefined>((item, match) => navigation.byRouteId.get(match.routeId) ?? item, undefined);
  const currentNavigation = matchedNavigation?.children.find(child => child.to === matchedNavigation.to) ?? matchedNavigation;
  const activeRouteIds = new Set(matches.map(match => match.routeId));
  if (currentNavigation) activeRouteIds.add(currentNavigation.routeId);
  const currentHelp = matches.reduce<NavigationHelp | undefined>((help, match) => router.routesById[match.routeId]?.options.staticData?.navigation?.help ?? help, undefined) ?? navigation.items[0]?.help;
  useEffect(() => { setMobileMenuOpen(false); }, [location]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileMenuOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);
  useEffect(() => {
    if (mobileMenuOpen) mobileNavigationRef.current?.querySelector<HTMLElement>("a,button,select")?.focus();
    else menuButtonRef.current?.focus();
  }, [mobileMenuOpen]);

  return (
    <div className="console-frame text-text">
      {currentHelp && <ContextHelp label={currentHelp.label}>{currentHelp.text}</ContextHelp>}
      <aside className="rail">
        <div className="brand-lockup"><img className="brand-mark" src="/mars-icon.svg" alt="" /><span>MARS</span></div>
        <p className="rail-caption">{inSettings ? "Deployment settings" : "Runner operations / 01"}</p>
        <label className="rail-org-picker">Workspace
          <select aria-label="Select workspace" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
            <option value="all">All workspaces</option>
            {organizations.data?.map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}
          </select>
        </label>
          <nav aria-label={inSettings ? "Settings navigation" : "Primary navigation"}>
            <p className="nav-label">{inSettings ? "Settings" : "Navigate"}</p>
            <NavigationLinks items={navigation.items} current={currentNavigation} activeRouteIds={activeRouteIds} />
          </nav>
          <div className="rail-settings">{inSettings ? <Link to="/" className="nav-link"><span>Back to dashboard</span></Link> : <Link to="/settings" className="nav-link" activeProps={{ className: "nav-link is-active" }}><span>Settings</span></Link>}</div>
        <div className="rail-footer" role="status" aria-live="polite"><span className={`online-dot ${health.data ? "" : "is-offline"}`} />Control plane <strong>{health.isLoading ? "checking" : health.data ? "connected" : "unreachable"}</strong>{health.data?.discovery.stale && <small> Discovery stale</small>}</div>
      </aside>
      <div className="console-body">
        <header className="mobile-header">
          <div className="mobile-header-top">
            <div className="brand-lockup"><img className="brand-mark" src="/mars-icon.svg" alt="" /><span>MARS</span></div>
            <button ref={menuButtonRef} type="button" className="mobile-menu-button" aria-expanded={mobileMenuOpen} aria-controls="mobile-navigation" onClick={() => setMobileMenuOpen((open) => !open)}>
              {mobileMenuOpen ? "Close" : "Menu"}
            </button>
          </div>
          <div className="mobile-header-context">
            <span>{currentNavigation?.label ?? navigation.items[0]?.label}</span>
            <label className="mobile-org-picker">Workspace
              <select aria-label="Select workspace" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
                <option value="all">All workspaces</option>
                {organizations.data?.map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}
              </select>
            </label>
          </div>
          {mobileMenuOpen && <nav ref={mobileNavigationRef} id="mobile-navigation" className="mobile-navigation" aria-label="Mobile navigation">
              <NavigationLinks items={navigation.items} current={currentNavigation} activeRouteIds={activeRouteIds} />
              <div className="mobile-settings-nav">{inSettings ? <Link to="/" className="nav-link"><span>Back to dashboard</span></Link> : <Link to="/settings" className="nav-link" activeProps={{ className: "nav-link is-active" }}><span>Settings</span></Link>}</div>
          </nav>}
        </header>
        <main id="main-content" className="workspace" data-path={location}>
          {state ?? (organizationId ? <Outlet /> : <QueryState error={undefined} isLoading={false} isEmpty />)}
        </main>
      </div>
    </div>
  );
}
