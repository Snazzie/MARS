import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepositorySummary } from "@whitesmith/contracts";
import { beginOrganizationGithubInstall, getGithubRepositorySettings, getRepositories, refreshGithubConnection, setRepositoryApproval, uninstallOrganizationGithub } from "../api.ts";
import { Disclosure } from "../components/Disclosure.tsx";
import { QueryState } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
export function RepositoriesPage() {
  const { organizationId, organizations } = useOrganizationFromRoute();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [availability, setAvailability] = useState<"available" | "unavailable">("available");
  const [visibility, setVisibility] = useState<"all" | "private" | "internal">("all");
  const [connectOrganizationId, setConnectOrganizationId] = useState("");

  useEffect(() => {
    const next = organizations[0]?.id ?? "";
    if (
      !connectOrganizationId ||
      !organizations.some((organization) => organization.id === connectOrganizationId)
    ) {
      setConnectOrganizationId(next);
    }
  }, [connectOrganizationId, organizationId, organizations]);

  const query = useQuery({
    queryKey: ["org", organizationId, "repositories"],
    queryFn: () => getRepositories(organizationId),
    enabled: Boolean(organizationId),
  });
  const approval = useMutation({
    mutationFn: ({ id, approved, workspaceId }: { id: string; approved: boolean; workspaceId: string }) =>
      setRepositoryApproval(workspaceId, id, approved),
    onSuccess: () => client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] }),
  });
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
  const repositories = useMemo(
    () =>
      (query.data?.items ?? []).filter((repository) => {
        const text = search.trim().toLowerCase();
        return (
          repository.available === (availability === "available") &&
          (!text || repository.fullName.toLowerCase().includes(text)) &&
          (visibility === "all" || repository.visibility === visibility)
        );
      }),
    [query.data, search, visibility, availability],
  );
  const allWorkspaces = organizationId === "all";
  const canConnect = organizations.length > 0;
  const updateError = connect.error ?? refreshConnection.error ?? manageOrganization.error ?? approval.error ?? manageRepository.error;
  return (
    <>
      <header className="page-header repositories-header">
        <div>
          <p className="eyebrow">Repository registry</p>
          <h1>Repositories</h1>
          <p className="page-description">
            Control which GitHub repositories can send work to this runner fleet.
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
            <caption className="sr-only">GitHub repositories and Whitesmith access status</caption>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Visibility</th>
                <th scope="col">GitHub access</th>
                <th scope="col">Whitesmith access</th>
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
                  </td>
                  <td>
                    <span className={`status ${repository.approved ? "status-success" : "status-muted"}`}>
                      {repository.approved ? "Approved" : "Not approved"}
                    </span>
                  </td>
                  <td>
                    <div className="repository-actions">
                      <button
                        type="button"
                        className="control-button"
                        onClick={() =>
                          approval.mutate({
                            id: repository.id,
                            approved: !repository.approved,
                            workspaceId: repository.organizationId,
                          })
                        }
                        disabled={!repository.available || approval.isPending}
                      >
                        {approval.isPending ? "Saving…" : repository.approved ? "Remove" : "Approve"}
                      </button>
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
