import { useEffect, useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getMe, getOrganizations } from "../api.ts";
import { useOrganization } from "../router.tsx";
import { QueryState } from "./StateView.tsx";

const links = [
  ["/", "Overview", "01"],
  ["/runs", "Runs", "02"],
  ["/repositories", "Repositories", "03"],
  ["/workers", "Workers", "04"],
  ["/pools", "Pools", "05"],
  ["/settings", "Settings", "06"],
] as const;

export function AppShell() {
  const location = useRouterState({ select: (state) => state.location.pathname });
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

  return (
    <div className="console-frame">
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
        <div className="rail-footer"><span className="online-dot" />Control plane <strong>connected</strong></div>
      </aside>
      <div className="console-body">
        <header className="mobile-header">
          <div className="mobile-header-top">
            <div className="brand-lockup"><span className="brand-pip" aria-hidden="true" /><span>WHITESMITH</span></div>
            <button type="button" className="mobile-menu-button" aria-expanded={mobileMenuOpen} aria-controls="mobile-navigation" onClick={() => setMobileMenuOpen((open) => !open)}>
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
          {mobileMenuOpen && <nav id="mobile-navigation" className="mobile-navigation" aria-label="Mobile navigation">
            {links.map(([to, label, number]) => <Link key={to} to={to} className="nav-link" activeProps={{ className: "nav-link is-active" }}><span className="nav-number">{number}</span><span>{label}</span></Link>)}
          </nav>}
        </header>
        <main className="workspace" data-path={location}>
          {state ?? (organizationId ? <Outlet /> : <QueryState error={undefined} isLoading={false} isEmpty />)}
        </main>
      </div>
    </div>
  );
}
