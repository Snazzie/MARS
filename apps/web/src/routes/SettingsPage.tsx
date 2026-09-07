import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  beginOrganizationGithubInstall,
  getGithubConnection,
  getGithubOrganizationSettings,
  getGithubRateLimit,
  getMe,
  getOrganizations,
  logout,
  refreshGithubConnection,
  uninstallOrganizationGithub,
} from "../api.ts";
import { useOrganizationFromRoute } from "./useOrganization.ts";


function number(value: number) {
  return value.toLocaleString("en-US");
}

function githubError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function SettingsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const signOut = useMutation({ mutationFn: logout, onSuccess: () => { client.clear(); window.location.assign("/onboarding"); } });
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const organizations = organizationsQuery.data ?? [];
  const githubOrganizationId = organizations.find((organization) => organization.id === organizationId)?.id ?? organizations[0]?.id ?? "";
  const connection = useQuery({
    queryKey: ["org", githubOrganizationId, "github-connection"],
    queryFn: () => getGithubConnection(githubOrganizationId),
    enabled: githubOrganizationId !== "",
  });
  const rateLimit = useQuery({
    queryKey: ["org", githubOrganizationId, "github-rate-limit"],
    queryFn: () => getGithubRateLimit(githubOrganizationId),
    enabled: connection.data?.connected === true,
  });
  const [githubActionError, setGithubActionError] = useState<unknown>(null);

  useEffect(() => { setGithubActionError(null); }, [githubOrganizationId]);


  const invalidateGithub = () => {
    if (!githubOrganizationId) return;
    void client.invalidateQueries({ queryKey: ["org", githubOrganizationId, "github-connection"] });
    void client.invalidateQueries({ queryKey: ["org", githubOrganizationId, "github-rate-limit"] });
    void client.invalidateQueries({ queryKey: ["org", githubOrganizationId, "repositories"] });
    void client.invalidateQueries({ queryKey: ["organizations"] });
  };
  const install = useMutation({
    mutationFn: () => beginOrganizationGithubInstall(githubOrganizationId),
    onMutate: () => setGithubActionError(null),
    onError: (error) => setGithubActionError(error),
    onSuccess: ({ location }) => { setGithubActionError(null); window.location.assign(location); },
  });
  const manageInstallation = useMutation({
    mutationFn: () => getGithubOrganizationSettings(githubOrganizationId),
    onMutate: () => setGithubActionError(null),
    onError: (error) => setGithubActionError(error),
    onSuccess: ({ location }) => { setGithubActionError(null); window.location.assign(location); },
  });
  const sync = useMutation({
    mutationFn: () => refreshGithubConnection(githubOrganizationId),
    onMutate: () => setGithubActionError(null),
    onError: (error) => setGithubActionError(error),
    onSuccess: () => { setGithubActionError(null); invalidateGithub(); },
  });
  const remove = useMutation({
    mutationFn: () => uninstallOrganizationGithub(githubOrganizationId),
    onMutate: () => setGithubActionError(null),
    onError: (error) => setGithubActionError(error),
    onSuccess: () => { setGithubActionError(null); invalidateGithub(); },
  });
  const githubMutationPending = install.isPending || manageInstallation.isPending || sync.isPending || remove.isPending;
  const githubActionMessage = githubActionError === null ? null : githubError(githubActionError, "GitHub connection action failed.");


  return (
    <>
      <header className="page-header"><div><p className="eyebrow">Deployment settings</p><h1>Manage the deployment.</h1><p className="page-description">Review signed-in access, GitHub connections, and live API quota from one deployment-wide view.</p></div></header>
      <section className="settings-account" aria-labelledby="account-title"><h2 id="account-title">Signed-in identity</h2><p>{me.data ? `GitHub account: ${me.data.login}` : "Loading GitHub identity…"}</p><button className="button secondary" type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>{signOut.isPending ? "Signing out…" : "Sign out"}</button>{signOut.error && <p className="form-error" role="alert">{signOut.error instanceof Error ? signOut.error.message : "Sign out failed."}</p>}</section>
      <section className="settings-deployment" aria-labelledby="deployment-integrations-title">
        <div className="panel-heading"><div><p className="eyebrow">Deployment integrations</p><h2 id="deployment-integrations-title">GitHub connections</h2></div></div>
        <p className="form-help">GitHub installation and API quota remain organization-scoped under the existing integration contract. The current organization is used when one is selected; otherwise the first available organization is shown.</p>
        <section className="settings-github-card" aria-labelledby="github-connection-title">
          <div className="panel-heading"><div><p className="eyebrow">Organization integration</p><h2 id="github-connection-title">GitHub connection</h2></div>{!connection.error && connection.data?.connected && <span className="status-ready">Connected</span>}</div>
          <p className="form-help">Repository access uses the GitHub App installation selected for this organization.</p>
          {!connection.error && connection.isLoading && <p className="settings-status" role="status">Loading GitHub connection…</p>}
          {connection.error && <div className="form-error" role="alert"><p>Unable to load GitHub connection: {githubError(connection.error, "Try again.")}</p><button className="button secondary" type="button" onClick={() => void connection.refetch()}>Retry connection</button></div>}
          {!connection.error && connection.data?.connected === false && <div className="settings-github-disconnected"><p>No GitHub App installation is connected to this organization.</p><button className="button" type="button" onClick={() => install.mutate()} disabled={githubMutationPending}>{install.isPending ? "Opening GitHub…" : "Add GitHub connection"}</button></div>}
          {!connection.error && connection.data?.connected && <div className="settings-github-connected"><dl className="settings-github-details"><div><dt>GitHub account</dt><dd>{connection.data.login ?? "Unavailable"}</dd></div><div><dt>Account type</dt><dd>{connection.data.accountType ?? "Unavailable"}</dd></div><div><dt>Installation</dt><dd>{connection.data.installationId ? `#${connection.data.installationId}` : "Connected"}</dd></div></dl><div className="settings-actions"><button className="button secondary" type="button" onClick={() => manageInstallation.mutate()} disabled={githubMutationPending}>{manageInstallation.isPending ? "Opening GitHub…" : "Manage installation"}</button><button className="button secondary" type="button" onClick={() => sync.mutate()} disabled={githubMutationPending}>{sync.isPending ? "Syncing…" : "Sync repositories"}</button><button className="button danger" type="button" onClick={() => { if (window.confirm("Uninstall Mars from this GitHub organization?")) remove.mutate(); }} disabled={githubMutationPending}>{remove.isPending ? "Removing…" : "Remove connection"}</button></div></div>}
          {githubActionMessage && <p className="form-error" role="alert">{githubActionMessage}</p>}
        </section>
        <section className="settings-github-card" aria-labelledby="github-rate-limit-title">
          <div className="panel-heading"><div><p className="eyebrow">Live GitHub API usage</p><h2 id="github-rate-limit-title">GitHub API rate limit</h2></div></div>
          {!connection.error && connection.data?.connected === false && <p className="settings-status" role="status">GitHub rate limit unavailable until a connection is added.</p>}
          {!connection.error && connection.isLoading && <p className="settings-status" role="status">Checking GitHub connection before loading rate limit…</p>}
          {connection.error && <p className="settings-status" role="status">GitHub rate limit unavailable because connection status could not be loaded.</p>}
          {!connection.error && connection.data?.connected && rateLimit.isLoading && <p className="settings-status" role="status">Loading GitHub rate limit…</p>}
          {!connection.error && connection.data?.connected && rateLimit.error && <div className="form-error" role="alert"><p>GitHub rate limit unavailable: {githubError(rateLimit.error, "Try again.")}</p><button className="button secondary" type="button" onClick={() => void rateLimit.refetch()}>Retry rate limit</button></div>}
          {!connection.error && connection.data?.connected && !rateLimit.error && rateLimit.data && <div className="settings-rate-limit"><dl className="settings-rate-limit-grid"><div><dt>Remaining</dt><dd className="settings-rate-limit-remaining">{number(rateLimit.data.remaining)}</dd></div><div><dt>Limit</dt><dd>{number(rateLimit.data.limit)}</dd></div><div><dt>Used</dt><dd>{number(rateLimit.data.used)}</dd></div><div><dt>Reset time</dt><dd><time dateTime={rateLimit.data.resetAt}>{new Date(rateLimit.data.resetAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></dd></div></dl><button className="button secondary" type="button" onClick={() => void rateLimit.refetch()} disabled={rateLimit.isFetching && !rateLimit.data}>Refresh rate limit</button></div>}
        </section>
      </section>
    </>
  );
}
