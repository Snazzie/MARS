import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepositorySummary } from "@whitesmith/contracts";
import { getRepositories, setRepositoryApproval } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export function RepositoriesPage() {
  const { organizationId } = useOrganizationFromRoute();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState<"all" | "private" | "internal">("all");
  const query = useQuery({ queryKey: ["org", organizationId, "repositories"], queryFn: () => getRepositories(organizationId), enabled: Boolean(organizationId) });
  const approval = useMutation({ mutationFn: ({ id, approved }: { id: string; approved: boolean }) => setRepositoryApproval(organizationId, id, approved), onSuccess: () => client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] }) });
  const repositories = useMemo(() => (query.data?.items ?? []).filter((repository) => {
    const text = search.trim().toLowerCase();
    return (!text || repository.fullName.toLowerCase().includes(text)) && (visibility === "all" || (visibility === "private" && repository.private) || (visibility === "internal" && !repository.private));
  }), [query.data, search, visibility]);
  return <><header className="page-header"><div><p className="eyebrow">Repository registry</p><h1>Choose where work can land.</h1><p className="page-description">Approved private and internal repositories are the only sources allowed to use this fleet.</p></div></header><div className="toolbar" role="search"><label>Search repositories<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="org / repository" /></label><label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option value="all">All</option><option value="private">Private</option><option value="internal">Internal</option></select></label></div><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && repositories.length === 0} retry={() => void query.refetch()} />{query.data && repositories.length > 0 && <section className="list-panel" aria-label="Repositories">{repositories.map((repository: RepositorySummary) => <article className="list-row repository-row" key={repository.id}><div><strong>{repository.fullName}</strong><p className="muted"><span className="status-pill">{repository.private ? "Private" : "Internal"}</span> · installation {repository.installationId}</p></div><button className="control-button" type="button" aria-pressed={repository.approved} disabled={approval.isPending} onClick={() => approval.mutate({ id: repository.id, approved: !repository.approved })}>{repository.approved ? "Disable routing" : "Enable routing"}</button></article>)}</section>}{approval.error && <p className="form-error" role="alert">{approval.error instanceof Error ? approval.error.message : "Repository update failed."}</p>}</>;
}
