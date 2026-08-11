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
  const currentOrg = organizations.data?.find((organization) => organization.id === organizationId);
  const state = <QueryState error={me.error ?? organizations.error} isLoading={me.isLoading || organizations.isLoading} isEmpty={organizations.data?.length === 0} retry={() => { void me.refetch(); void organizations.refetch(); }} />;

  return (
    <div className="console-frame">
      <aside className="rail">
        <div className="brand-lockup"><span className="brand-pip" aria-hidden="true" /><span>WHITESMITH</span></div>
        <p className="rail-caption">Runner operations / 01</p>
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
        <header className="topbar">
          <div><span className="crumb">Workspace</span><span className="slash">/</span><span className="crumb-current">{currentOrg?.name ?? "Select an organization"}</span></div>
          <label className="org-picker">Organization
            <select aria-label="Select organization" value={organizationId ?? ""} onChange={(event) => setOrganizationId(event.target.value)} disabled={!organizations.data?.length}>
              {!organizations.data?.length && <option value="">No organizations</option>}
              {organizations.data?.map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}
            </select>
          </label>
          <div className="operator-chip" title="Authenticated operator"><span className="operator-avatar">{typeof me.data === "object" && me.data && "login" in me.data && typeof me.data.login === "string" ? me.data.login.slice(0, 1).toUpperCase() : "W"}</span><span>Operator</span></div>
        </header>
        <main className="workspace" data-path={location}>
          {state ?? (organizationId ? <Outlet /> : <QueryState error={undefined} isLoading={false} isEmpty />)}
        </main>
      </div>
    </div>
  );
}
