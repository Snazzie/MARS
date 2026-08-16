import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepositorySummary } from "@whitesmith/contracts";
import { beginOrganizationGithubInstall, getGithubRepositorySettings, getMe, getRepositories, recheckRepositoryDiscovery, refreshGithubConnection, uninstallOrganizationGithub } from "../api.ts";
import { Disclosure } from "../components/Disclosure.tsx";
import { QueryState } from "../components/StateView.tsx";
import { RunnerWorkflowPrModal } from "../components/RunnerWorkflowPrModal.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
export function RepositoriesPage() {
  const { organizationId, organizations } = useOrganizationFromRoute();
  const client = useQueryClient();
  const [connectOrganizationId, setConnectOrganizationId] = useState("");
  const [runnerRepository, setRunnerRepository] = useState<RepositorySummary | null>(null);
   const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
   const [search, setSearch] = useState(params.get("q") ?? "");
   const [availability, setAvailability] = useState<"available" | "unavailable">((params.get("availability") as "available" | "unavailable") ?? "available");
   const [visibility, setVisibility] = useState<"all" | "private" | "internal">((params.get("visibility") as "all" | "private" | "internal") ?? "all");
   useEffect(() => {
     if (typeof window === "undefined") return;
     const next = new URLSearchParams(window.location.search);
     if (search) next.set("q", search); else next.delete("q");
     if (availability !== "available") next.set("availability", availability); else next.delete("availability");
     if (visibility !== "all") next.set("visibility", visibility); else next.delete("visibility");
     window.history.replaceState(null, "", `${window.location.pathname}${next.toString() ? `?${next}` : ""}${window.location.hash}`);
   }, [search, availability, visibility]);
  useEffect(() => {
    const next = organizations[0]?.id ?? "";
    if (
      !connectOrganizationId ||
      !organizations.some((organization) => organization.id === connectOrganizationId)
    ) {
      setConnectOrganizationId(next);
    }
  }, [connectOrganizationId, organizationId, organizations]);

  const query = useInfiniteQuery({
    queryKey: ["org", organizationId, "repositories", search, availability, visibility],
    queryFn: ({ pageParam }: { pageParam: string | null }) => getRepositories(organizationId, { cursor: pageParam, search, availability, visibility }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId),
  });
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const connect = useMutation({
    mutationFn: () => beginOrganizationGithubInstall(connectOrganizationId),
    onSuccess: ({ location }) => window.location.assign(location),
  });
  const refreshConnection = useMutation({
    mutationFn: () => refreshGithubConnection(organizationId),
    onSuccess: () => client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] }),
  });
  const manageOrganization = useMutation({
    mutationFn: () => uninstallOrganizationGithub(organizationId),
    onSuccess: () => {
      try {
        localStorage.removeItem("whitesmith.organization");
      } catch {
        /* storage can be disabled */
      }
      window.dispatchEvent(new Event("whitesmith-org-change"));
      void client.invalidateQueries({ queryKey: ["organizations"] });
      void client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] });
    },
  });
  const manageRepository = useMutation({
    mutationFn: ({ repositoryId, workspaceId }: { repositoryId: string; workspaceId: string }) =>
      getGithubRepositorySettings(workspaceId, repositoryId),
    onSuccess: ({ location }) => window.location.assign(location),
  });
  const recheckDiscovery = useMutation({
    mutationFn: (repository: RepositorySummary) =>
      recheckRepositoryDiscovery(repository.organizationId, repository.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] }),
  });
  const repositories = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const allWorkspaces = organizationId === "all";
  const canConnect = organizations.length > 0;
  const updateError = connect.error ?? refreshConnection.error ?? manageOrganization.error ?? manageRepository.error ?? recheckDiscovery.error;
  return (
    <>
      <header className="page-header repositories-header">
        <div>
          <p className="eyebrow">Repository registry</p>
          <h1>Repositories</h1>
          <p className="page-description">
            Access follows the GitHub App installation. Manage repository scope in GitHub.
          </p>
        </div>
        <div className="repositories-actions">
          <div className="repositories-action-group repositories-connect-group">
            <label>
              Connect workspace
              <select aria-label="Workspace to connect" value={connectOrganizationId} onChange={(event) => setConnectOrganizationId(event.target.value)} disabled={!canConnect}>
                <option value="">Select workspace</option>
                {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}
              </select>
            </label>
            <button type="button" className="button" onClick={() => connect.mutate()} disabled={!canConnect || !connectOrganizationId || connect.isPending}>
              {connect.isPending ? "Connecting…" : "Connect workspace"}
            </button>
          </div>
          <Disclosure label="GitHub connection" tone="danger">
            <div className="repositories-action-group">
              <a className="button secondary" href="/api/auth/github?returnTo=%2Frepositories">Refresh GitHub connection</a>
              <button type="button" className="button secondary" onClick={() => refreshConnection.mutate()} disabled={allWorkspaces || !organizationId || refreshConnection.isPending}>
                {refreshConnection.isPending ? "Syncing…" : "Sync installed repositories"}
              </button>
              <button type="button" className="button secondary" onClick={() => { if (window.confirm("Uninstall Whitesmith from this GitHub organization?")) manageOrganization.mutate(); }} disabled={allWorkspaces || !organizationId || manageOrganization.isPending}>
                Uninstall
              </button>
            </div>
            {allWorkspaces && <p className="muted">Select one workspace to manage its GitHub connection.</p>}
          </Disclosure>
        </div>
      </header>

      {updateError && <p role="alert" className="form-error">{updateError instanceof Error ? updateError.message : "Could not update GitHub access."}</p>}

      <section className="repository-toolbar" aria-label="Repository filters">
        <div><strong>{repositories.length}</strong><span>{repositories.length === 1 ? "repository" : "repositories"} shown</span></div>
        <div className="toolbar">
          <div className="repository-availability-toggle" role="group" aria-label="Repository availability">
            {(["available", "unavailable"] as const).map((option) => <button key={option} type="button" className={`control-button ${availability === option ? "" : "control-button-secondary"}`} aria-pressed={availability === option} onClick={() => setAvailability(option)}>{option === "available" ? "Available" : "Unavailable"}</button>)}
          </div>
          <label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="org / repository" /></label>
          <Disclosure label="More filters"><label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option value="all">All visibility</option><option value="private">Private</option><option value="internal">Internal</option></select></label></Disclosure>
        </div>
      </section>
      <p className="filter-scope" role="note">Search and filters apply across all matching repositories.</p>
      <QueryState
        error={query.error}
        isLoading={query.isLoading}
        isEmpty={!query.isLoading && !query.error && repositories.length === 0}
        retry={() => void query.refetch()}
        operationLabel="repository list"
      />

      {query.data && repositories.length > 0 && (
        <section className="table-panel repository-table-panel" aria-label="Repositories">
          <table>
            <caption className="sr-only">GitHub repository availability and actions</caption>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Visibility</th>
                <th scope="col">Access</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {repositories.map((repository: RepositorySummary) => (
                <tr key={repository.id}>
                  <td>
                    <strong className="repository-name">{repository.fullName}</strong>
                    <small>{repository.organizationId}</small>
                  </td>
                  <td><span className={`status status-${repository.visibility}`}>{repository.visibility}</span></td>
                  <td>
                    <span className={`status ${repository.available ? "status-success" : "status-failure"}`}>
                      {repository.available ? "Available" : "Unavailable"}
                    </span>
                    {repository.discoveryState === "paused" && (
                      <small className="repository-discovery repository-discovery-paused">
                        Discovery paused until {new Date(repository.discoveryRetryAt!).toLocaleString()}
                      </small>
                    )}
                    {repository.discoveryState === "queued" && (
                      <small className="repository-discovery">Recheck queued</small>
                    )}
                  </td>
                  <td>
                    <div className="repository-actions">
                      {me.data?.isGlobalAdmin && repository.discoveryState !== "active" && (
                        <button
                          type="button"
                          className="control-button control-button-secondary"
                          onClick={() => recheckDiscovery.mutate(repository)}
                          disabled={repository.discoveryState === "queued" || recheckDiscovery.isPending}
                        >
                          Recheck now
                        </button>
                      )}
                      <button
                        type="button"
                        className="control-button control-button-secondary"
                        onClick={() =>
                          manageRepository.mutate({
                            repositoryId: repository.id,
                            workspaceId: repository.organizationId,
                          })
                        }
                        disabled={!repository.available || manageRepository.isPending}
                      >
                        Manage GitHub
                      </button>
                      <button type="button" className="control-button" onClick={() => setRunnerRepository(repository)} disabled={!repository.available}>Use Whitesmith runners</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {query.hasNextPage && <button type="button" className="button secondary load-more" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "Loading…" : "Load more repositories"}</button>}
      {runnerRepository && <RunnerWorkflowPrModal organizationId={runnerRepository.organizationId} repositoryId={runnerRepository.id} repositoryName={runnerRepository.fullName} open onClose={() => setRunnerRepository(null)} />}
    </>
  );
}
