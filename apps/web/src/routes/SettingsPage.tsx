import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OrganizationSettings } from "@mars/contracts";
import {
  beginOrganizationGithubInstall,
  getGithubConnection,
  getGithubOrganizationSettings,
  getGithubRateLimit,
  getMe,
  getSettings,
  logout,
  refreshGithubConnection,
  uninstallOrganizationGithub,
  updateSettings,
} from "../api.ts";
import { QueryState, WorkspaceRequired } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

type Values = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
type FormValues = { maxVcpuPerPod: number; maxMemoryGiB: number; maxStorageGiB: number; maxConcurrentPods: number };

export function bytesToGiB(bytes: number) { return Number((bytes / 1024 ** 3).toFixed(2)); }
export function gibToBytes(gib: number) { return Math.round(gib * 1024 ** 3); }

const fields: Array<[keyof FormValues, string, string]> = [["maxVcpuPerPod", "vCPU per pod", "Whole vCPU count"], ["maxMemoryGiB", "Memory per pod (GiB)", "Total guest RAM"], ["maxStorageGiB", "Storage per pod (GiB)", "Writable capacity"], ["maxConcurrentPods", "Maximum concurrent pods", "Positive whole number"]];

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
  const query = useQuery({ queryKey: ["org", organizationId, "settings"], queryFn: () => getSettings(organizationId), enabled: organizationId !== "all" });
  const connection = useQuery({ queryKey: ["org", organizationId, "github-connection"], queryFn: () => getGithubConnection(organizationId), enabled: organizationId !== "all" });
  const rateLimit = useQuery({
    queryKey: ["org", organizationId, "github-rate-limit"],
    queryFn: () => getGithubRateLimit(organizationId),
    enabled: connection.data?.connected === true,
  });
  const [values, setValues] = useState<FormValues>({ maxVcpuPerPod: 1, maxMemoryGiB: 1, maxStorageGiB: 1, maxConcurrentPods: 1 });
  const [validation, setValidation] = useState<string[]>([]);
  useEffect(() => { if (query.data) setValues({ maxVcpuPerPod: query.data.maxVcpuPerPod, maxMemoryGiB: bytesToGiB(query.data.maxMemoryBytesPerPod), maxStorageGiB: bytesToGiB(query.data.maxStorageBytesPerPod), maxConcurrentPods: query.data.maxConcurrentPods }); }, [query.data]);
  const invalidateGithub = () => {
    void client.invalidateQueries({ queryKey: ["org", organizationId, "github-connection"] });
    void client.invalidateQueries({ queryKey: ["org", organizationId, "github-rate-limit"] });
    void client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] });
    void client.invalidateQueries({ queryKey: ["organizations"] });
  };
  const install = useMutation({
    mutationFn: () => beginOrganizationGithubInstall(organizationId),
    onSuccess: ({ location }) => window.location.assign(location),
  });
  const manageInstallation = useMutation({
    mutationFn: () => getGithubOrganizationSettings(organizationId),
    onSuccess: ({ location }) => window.location.assign(location),
  });
  const sync = useMutation({
    mutationFn: () => refreshGithubConnection(organizationId),
    onSuccess: invalidateGithub,
  });
  const remove = useMutation({
    mutationFn: () => uninstallOrganizationGithub(organizationId),
    onSuccess: invalidateGithub,
  });
  const [githubMutationError, githubMutationPending] = [
    install.error ?? manageInstallation.error ?? sync.error ?? remove.error,
    install.isPending || manageInstallation.isPending || sync.isPending || remove.isPending,
  ];
  function submit(event: FormEvent) {
    event.preventDefault();
    const next: Values = { maxVcpuPerPod: values.maxVcpuPerPod, maxMemoryBytesPerPod: gibToBytes(values.maxMemoryGiB), maxStorageBytesPerPod: gibToBytes(values.maxStorageGiB), maxConcurrentPods: values.maxConcurrentPods };
    const parsed = OrganizationSettings.safeParse({ organizationId, ...next });
    if (!parsed.success) { setValidation(parsed.error.issues.map((issue) => issue.message)); return; }
    setValidation([]);
    save.mutate(next);
  }
  const save = useMutation({ mutationFn: (next: Values) => updateSettings(organizationId, next), onSuccess: () => { setValidation([]); void client.invalidateQueries({ queryKey: ["org", organizationId, "settings"] }); } });
  if (organizationId === "all") return <WorkspaceRequired />;
  return (
    <>
      <header className="page-header"><div><p className="eyebrow">Organization settings</p><h1>Set the fleet safety envelope.</h1><p className="page-description">These hard per-pod ceilings limit every runner pool in the selected organization.</p></div></header>
      <section className="settings-account" aria-labelledby="account-title"><h2 id="account-title">Signed-in identity</h2><p>{me.data ? `GitHub account: ${me.data.login}` : "Loading GitHub identity…"}</p><button className="button secondary" type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>{signOut.isPending ? "Signing out…" : "Sign out"}</button>{signOut.error && <p className="form-error" role="alert">{signOut.error instanceof Error ? signOut.error.message : "Sign out failed."}</p>}</section>
      <section className="settings-github-card" aria-labelledby="github-connection-title">
        <div className="panel-heading"><div><p className="eyebrow">Organization integration</p><h2 id="github-connection-title">GitHub connection</h2></div>{connection.data?.connected && <span className="status-ready">Connected</span>}</div>
        <p className="form-help">Repository access uses the GitHub App installation selected for this organization.</p>
        {connection.isLoading && <p className="settings-status" role="status">Loading GitHub connection…</p>}
        {connection.error && <div className="form-error" role="alert"><p>Unable to load GitHub connection: {githubError(connection.error, "Try again.")}</p><button className="button secondary" type="button" onClick={() => void connection.refetch()}>Retry connection</button></div>}
        {connection.data?.connected === false && <div className="settings-github-disconnected"><p>No GitHub App installation is connected to this organization.</p><button className="button" type="button" onClick={() => install.mutate()} disabled={githubMutationPending}>{install.isPending ? "Opening GitHub…" : "Add GitHub connection"}</button></div>}
        {connection.data?.connected && <div className="settings-github-connected">
          <dl className="settings-github-details">
            <div><dt>GitHub account</dt><dd>{connection.data.login ?? "Unavailable"}</dd></div>
            <div><dt>Account type</dt><dd>{connection.data.accountType ?? "Unavailable"}</dd></div>
            <div><dt>Installation</dt><dd>{connection.data.installationId ? `#${connection.data.installationId}` : "Connected"}</dd></div>
          </dl>
          <div className="settings-actions"><button className="button secondary" type="button" onClick={() => manageInstallation.mutate()} disabled={githubMutationPending}>{manageInstallation.isPending ? "Opening GitHub…" : "Manage installation"}</button><button className="button secondary" type="button" onClick={() => sync.mutate()} disabled={githubMutationPending}>{sync.isPending ? "Syncing…" : "Sync repositories"}</button><button className="button danger" type="button" onClick={() => remove.mutate()} disabled={githubMutationPending}>{remove.isPending ? "Removing…" : "Remove connection"}</button></div>
        </div>}
        {githubMutationError && <p className="form-error" role="alert">{githubError(githubMutationError, "GitHub connection action failed.")}</p>}
      </section>
      <section className="settings-github-card" aria-labelledby="github-rate-limit-title">
        <div className="panel-heading"><div><p className="eyebrow">Live GitHub API usage</p><h2 id="github-rate-limit-title">GitHub API rate limit</h2></div></div>
        {connection.data?.connected === false && <p className="settings-status" role="status">GitHub rate limit unavailable until a connection is added.</p>}
        {connection.isLoading && <p className="settings-status" role="status">Checking GitHub connection before loading rate limit…</p>}
        {connection.error && <p className="settings-status" role="status">GitHub rate limit unavailable because connection status could not be loaded.</p>}
        {connection.data?.connected && rateLimit.isLoading && <p className="settings-status" role="status">Loading GitHub rate limit…</p>}
        {connection.data?.connected && rateLimit.error && <div className="form-error" role="alert"><p>GitHub rate limit unavailable: {githubError(rateLimit.error, "Try again.")}</p><button className="button secondary" type="button" onClick={() => void rateLimit.refetch()}>Retry rate limit</button></div>}
        {connection.data?.connected && rateLimit.data && <div className="settings-rate-limit">
          <dl className="settings-rate-limit-grid"><div><dt>Remaining</dt><dd className="settings-rate-limit-remaining">{number(rateLimit.data.remaining)}</dd></div><div><dt>Limit</dt><dd>{number(rateLimit.data.limit)}</dd></div><div><dt>Used</dt><dd>{number(rateLimit.data.used)}</dd></div><div><dt>Reset time</dt><dd><time dateTime={rateLimit.data.resetAt}>{new Date(rateLimit.data.resetAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></dd></div></dl>
          <button className="button secondary" type="button" onClick={() => void rateLimit.refetch()} disabled={rateLimit.isFetching && !rateLimit.data}>Refresh rate limit</button>
        </div>}
      </section>
      <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="settings" />
      {query.data && <form className="settings-form" onSubmit={submit}><fieldset disabled={save.isPending}><legend>Maximum runner resources</legend><p className="form-help">Set the maximum resources each runner pod may use. Memory and storage use GiB; values are converted automatically.</p>{fields.map(([name, label, description]) => <label key={name}>{label}<input type="number" min={1} step={name.includes("GiB") ? 0.25 : 1} required value={values[name]} onChange={(event) => setValues((current) => ({ ...current, [name]: Number(event.target.value) }))} /><small>{description}</small></label>)}</fieldset>{validation.length > 0 && <div className="form-error" role="alert"><strong>Correct these values:</strong><ul>{validation.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul></div>}{save.error && <p className="form-error" role="alert">{save.error instanceof Error ? save.error.message : "Settings update failed."}</p>}<button className="control-button" type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save settings"}</button></form>}
    </>
  );
}
