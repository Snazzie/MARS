import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepositorySummary } from "@whitesmith/contracts";
import { beginOrganizationGithubInstall, getGithubRepositorySettings, getRepositories, setRepositoryApproval, uninstallOrganizationGithub } from "../api.ts";
import { QueryState, WorkspaceRequired } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
export function RepositoriesPage() {
  const { organizationId, organizations } = useOrganizationFromRoute();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState<"all" | "private" | "internal">("all");
  const [connectOrganizationId, setConnectOrganizationId] = useState("");
  useEffect(() => {
    const next = organizations.find((organization) => organization.id !== organizationId)?.id ?? "";
    if (!connectOrganizationId || connectOrganizationId === organizationId || !organizations.some((organization) => organization.id === connectOrganizationId)) setConnectOrganizationId(next);
  }, [connectOrganizationId, organizationId, organizations]);
  const query = useQuery({ queryKey: ["org", organizationId, "repositories"], queryFn: () => getRepositories(organizationId), enabled: organizationId !== "all" });
  const approval = useMutation({ mutationFn: ({ id, approved }: { id: string; approved: boolean }) => setRepositoryApproval(organizationId, id, approved), onSuccess: () => client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] }) });
  const connect = useMutation({ mutationFn: () => beginOrganizationGithubInstall(connectOrganizationId), onSuccess: ({ location }) => window.location.assign(location) });
  const manageOrganization = useMutation({ mutationFn: () => uninstallOrganizationGithub(organizationId), onSuccess: () => { try { localStorage.removeItem("whitesmith.organization"); } catch { /* storage can be disabled */ } window.dispatchEvent(new Event("whitesmith-org-change")); void client.invalidateQueries({ queryKey: ["organizations"] }); void client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] }); } });
  const manageRepository = useMutation({ mutationFn: (repositoryId: string) => getGithubRepositorySettings(organizationId, repositoryId), onSuccess: ({ location }) => window.location.assign(location) });
  const repositories = useMemo(() => (query.data?.items ?? []).filter((repository) => {
    const text = search.trim().toLowerCase();
    return (!text || repository.fullName.toLowerCase().includes(text)) && (visibility === "all" || repository.visibility === visibility);
  }), [query.data, search, visibility]);
  if (organizationId === "all") return <WorkspaceRequired />;
  return <><header className="page-header"><div><p className="eyebrow">Repository registry</p><h1>Choose where work can land.</h1><p className="page-description">Approved private and internal repositories are the only sources allowed to use this fleet.</p></div><div className="page-actions"><a className="button secondary" href="/api/auth/github?returnTo=%2Frepositories">Refresh organizations</a><label>New organization<select aria-label="Organization to connect" value={connectOrganizationId} onChange={(event) => setConnectOrganizationId(event.target.value)} disabled={!organizations.some((organization) => organization.id !== organizationId)}><option value="">Select organization</option>{organizations.filter((organization) => organization.id !== organizationId).map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}</select></label><button type="button" className="button" onClick={() => connect.mutate()} disabled={!connectOrganizationId || connect.isPending}>Connect new organization</button><button type="button" className="button secondary" onClick={() => { if (window.confirm("Uninstall Whitesmith from this GitHub organization?")) manageOrganization.mutate(); }} disabled={!organizationId || manageOrganization.isPending}>Uninstall from GitHub</button></div></header>{(connect.error || manageOrganization.error) && <p role="alert" className="form-error">{(connect.error ?? manageOrganization.error) instanceof Error ? (connect.error ?? manageOrganization.error)?.message : "Could not update GitHub access."}</p>}<div className="toolbar" role="search"><label>Search repositories<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="org / repository" /></label><label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option value="all">All</option><option value="private">Private</option><option value="internal">Internal</option></select></label></div><section className="repository-grid">{repositories.map((repository) => <article className="repository-card" key={repository.id}><div><h2>{repository.fullName}</h2><p>{repository.visibility} · {repository.available ? "available" : "unavailable"} · {repository.approved ? "approved" : "pending approval"}</p></div><div><button type="button" onClick={() => approval.mutate({ id: repository.id, approved: !repository.approved })} disabled={!repository.available}>{repository.approved ? "Remove from Whitesmith" : "Approve in Whitesmith"}</button><button type="button" className="button secondary" onClick={() => manageRepository.mutate(repository.id)} disabled={manageRepository.isPending}>Manage GitHub access</button></div></article>)}</section></>;
}
