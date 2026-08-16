import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getHealth, getMe, getOrganizations } from "../api.ts";
import { useOrganization } from "../router.tsx";
import { QueryState } from "./StateView.tsx";
import { ContextHelp } from "./ContextHelp.tsx";

const links = [
  ["/", "Overview", "01"],
  ["/runs", "Runs", "02"],
  ["/repositories", "Repositories", "03"],
  ["/workers", "Workers", "04"],
  ["/pools", "Pools", "05"],
  ["/settings", "Settings", "06"],
] as const;
export function AppShell() {
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const location = useRouterState({ select: (state) => state.location.pathname });
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval: (query) => query.state.error ? 10_000 : 5_000, refetchIntervalInBackground: false });
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const organizations = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, enabled: !me.isLoading && !me.error });
  const { organizationId, setOrganizationId } = useOrganization(organizations.data ?? []);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const state = me.isLoading || organizations.isLoading || me.error || organizations.error
    ? <QueryState error={me.error ?? organizations.error} isLoading={me.isLoading || organizations.isLoading} retry={() => { void me.refetch(); void organizations.refetch(); }} operationLabel="workspace data" />
    : null;
  const currentLink = links.find(([to]) => to === location) ?? links.find(([to]) => location.startsWith(`${to}/`)) ?? links[0];
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
    <div className="console-frame">
      <ContextHelp label="About Whitesmith boundaries">Runtime choices are limited to released artifacts and verified worker capacity. Linux VM and unsupported runtimes remain unavailable until their native smoke gates pass.</ContextHelp>
      <aside className="rail">
        <div className="brand-lockup"><span className="brand-pip" aria-hidden="true" /><span>WHITESMITH</span></div>
        <p className="rail-caption">Runner operations / 01</p>
        <label className="rail-org-picker">Workspace
          <select aria-label="Select workspace" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
            <option value="all">All workspaces</option>
            {organizations.data?.map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}
          </select>
        </label>
        <nav aria-label="Primary navigation">
          <p className="nav-label">Navigate</p>
          {links.map(([to, label, number]) => (
            <Link key={to} to={to} className="nav-link" activeProps={{ className: "nav-link is-active" }}>
              <span className="nav-number">{number}</span><span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="rail-footer" role="status" aria-live="polite"><span className={`online-dot ${health.data?.ok ? "" : "is-offline"}`} />Control plane <strong>{health.isLoading ? "checking" : health.data?.ok ? "connected" : health.error ? "unreachable" : "degraded"}</strong>{health.data?.discovery.stale && <small> Discovery stale</small>}</div>
      </aside>
      <div className="console-body">
        <header className="mobile-header">
          <div className="mobile-header-top">
            <div className="brand-lockup"><span className="brand-pip" aria-hidden="true" /><span>WHITESMITH</span></div>
            <button ref={menuButtonRef} type="button" className="mobile-menu-button" aria-expanded={mobileMenuOpen} aria-controls="mobile-navigation" onClick={() => setMobileMenuOpen((open) => !open)}>
              {mobileMenuOpen ? "Close" : "Menu"}
            </button>
          </div>
          <div className="mobile-header-context">
            <span>{currentLink[1]}</span>
            <label className="mobile-org-picker">Workspace
              <select aria-label="Select workspace" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
                <option value="all">All workspaces</option>
                {organizations.data?.map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}
              </select>
            </label>
          </div>
          {mobileMenuOpen && <nav ref={mobileNavigationRef} id="mobile-navigation" className="mobile-navigation" aria-label="Mobile navigation">
            {links.map(([to, label, number]) => <Link key={to} to={to} className="nav-link" activeProps={{ className: "nav-link is-active" }}><span className="nav-number">{number}</span><span>{label}</span></Link>)}
          </nav>}
        </header>
        <main id="main-content" className="workspace" data-path={location}>
          {state ?? (organizationId ? <Outlet /> : <QueryState error={undefined} isLoading={false} isEmpty />)}
        </main>
      </div>
    </div>
  );
}
