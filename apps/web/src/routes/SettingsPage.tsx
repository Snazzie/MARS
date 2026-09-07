import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { OrganizationSettings } from "@mars/contracts";
import {
  beginOrganizationGithubInstall,
  getGithubConnection,
  getGithubOrganizationSettings,
  getGithubRateLimit,
  getMe,
  getOrganizations,
  getSettings,
  logout,
  refreshGithubConnection,
  uninstallOrganizationGithub,
  updateSettings,
} from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

type SettingsValue = {
  organizationId: string;
  maxVcpuPerPod: number;
  maxMemoryBytesPerPod: number;
  maxStorageBytesPerPod: number;
  maxConcurrentPods: number;
};
type FormValues = { maxMemoryGiB: number; maxStorageGiB: number; maxConcurrentPods: number };
type Values = Omit<SettingsValue, "organizationId">;
type SaveInput = { organizationId: string; settings: Values };

export function bytesToGiB(bytes: number) { return Number((bytes / 1024 ** 3).toFixed(2)); }
export function gibToBytes(gib: number) { return Math.round(gib * 1024 ** 3); }

const fields: Array<[keyof FormValues, string, string]> = [
  ["maxMemoryGiB", "Memory per pod (GiB)", "Total guest RAM"],
  ["maxStorageGiB", "Storage per pod (GiB)", "Writable capacity"],
  ["maxConcurrentPods", "Maximum concurrent pods", "Positive whole number"],
];

function number(value: number) {
  return value.toLocaleString("en-US");
}

function githubError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formValues(settings: SettingsValue): FormValues {
  return {
    maxMemoryGiB: bytesToGiB(settings.maxMemoryBytesPerPod),
    maxStorageGiB: bytesToGiB(settings.maxStorageBytesPerPod),
    maxConcurrentPods: settings.maxConcurrentPods,
  };
}

export function buildSettingsUpdate(settings: SettingsValue, values: FormValues): Values {
  return {
    maxVcpuPerPod: settings.maxVcpuPerPod,
    maxMemoryBytesPerPod: gibToBytes(values.maxMemoryGiB),
    maxStorageBytesPerPod: gibToBytes(values.maxStorageGiB),
    maxConcurrentPods: values.maxConcurrentPods,
  };
}
export function SettingsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const signOut = useMutation({ mutationFn: logout, onSuccess: () => { client.clear(); window.location.assign("/onboarding"); } });
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const organizations = organizationsQuery.data ?? [];
  const settingsQueries = useQueries({
    queries: organizations.map((organization) => ({
      queryKey: ["org", organization.id, "settings"],
      queryFn: () => getSettings(organization.id),
    })),
  });
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
  const [values, setValues] = useState<Record<string, FormValues>>({});
  const [validation, setValidation] = useState<Record<string, string[]>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [pendingSaves, setPendingSaves] = useState<Record<string, number>>({});
  const pendingSaveIds = useRef(new Set<string>());
  const [githubActionError, setGithubActionError] = useState<unknown>(null);

  useEffect(() => {
    setValues((current) => {
      let changed = false;
      const next = { ...current };
      for (const query of settingsQueries) {
        if (query.data && !next[query.data.organizationId]) {
          next[query.data.organizationId] = formValues(query.data);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [settingsQueries]);
  useEffect(() => { setGithubActionError(null); }, [githubOrganizationId]);

  const save = useMutation({
    mutationFn: ({ organizationId: id, settings }: SaveInput) => updateSettings(id, settings),
    onMutate: ({ organizationId: id }) => {
      setPendingSaves((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
      setValidation((current) => ({ ...current, [id]: [] }));
      setSaveErrors((current) => { const next = { ...current }; delete next[id]; return next; });
    },
    onError: (error, { organizationId: id }) => setSaveErrors((current) => ({ ...current, [id]: githubError(error, "Unable to save organization settings.") })),
    onSuccess: (_, { organizationId: id }) => {
      setValidation((current) => ({ ...current, [id]: [] }));
      void client.invalidateQueries({ queryKey: ["org", id, "settings"] });
    },
    onSettled: (_, __, { organizationId: id }) => {
      pendingSaveIds.current.delete(id);
      setPendingSaves((current) => {
        const next = { ...current };
        if ((next[id] ?? 0) <= 1) delete next[id];
        else next[id] -= 1;
        return next;
      });
    },
  });

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

  function submitRow(settings: SettingsValue) {
    const id = settings.organizationId;
    if (pendingSaveIds.current.has(id)) return;
    const rowValues = values[id] ?? formValues(settings);
    const next = buildSettingsUpdate(settings, rowValues);
    const parsed = OrganizationSettings.safeParse({ organizationId: settings.organizationId, ...next });
    if (!parsed.success) {
      setValidation((current) => ({ ...current, [settings.organizationId]: parsed.error.issues.map((issue) => issue.message) }));
      return;
    }
    setValidation((current) => ({ ...current, [settings.organizationId]: [] }));
    pendingSaveIds.current.add(id);
    save.mutate({ organizationId: id, settings: next });
  }

  return (
    <>
      <header className="page-header"><div><p className="eyebrow">Deployment settings</p><h1>Set the fleet safety envelope.</h1><p className="page-description">Manage resource ceilings for every organization from one deployment-wide view.</p></div></header>
      <section className="settings-account" aria-labelledby="account-title"><h2 id="account-title">Signed-in identity</h2><p>{me.data ? `GitHub account: ${me.data.login}` : "Loading GitHub identity…"}</p><button className="button secondary" type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>{signOut.isPending ? "Signing out…" : "Sign out"}</button>{signOut.error && <p className="form-error" role="alert">{signOut.error instanceof Error ? signOut.error.message : "Sign out failed."}</p>}</section>
      <section className="settings-deployment" aria-labelledby="deployment-settings-title">
        <div className="panel-heading"><div><p className="eyebrow">All organizations</p><h2 id="deployment-settings-title">Deployment organization settings</h2></div></div>
        <p className="form-help">Set the maximum resources each runner pod may use. Memory and storage use GiB; values are converted automatically.</p>
        <QueryState error={organizationsQuery.error} isLoading={organizationsQuery.isLoading} isEmpty={!organizationsQuery.isLoading && !organizationsQuery.error && organizations.length === 0} retry={() => void organizationsQuery.refetch()} operationLabel="organizations" />
        {organizations.length > 0 && <div className="settings-table-wrap"><table className="settings-table"><caption className="sr-only">Resource limits by organization</caption><thead><tr><th scope="col">Organization</th><th scope="col">Memory per pod (GiB)</th><th scope="col">Storage per pod (GiB)</th><th scope="col">Maximum concurrent pods</th><th scope="col"><span className="sr-only">Save</span></th></tr></thead><tbody>{organizations.map((organization, index) => {
          const query = settingsQueries[index];
          const settings = query?.data as SettingsValue | undefined;
          const rowValues = settings ? values[organization.id] ?? formValues(settings) : undefined;
          const saving = (pendingSaves[organization.id] ?? 0) > 0;
          if (query?.error) return <tr key={organization.id}><th scope="row">{organization.login}</th><td colSpan={4}><div className="form-error" role="alert"><p>Unable to load organization settings: {githubError(query.error, "Try again.")}</p><button className="button secondary" type="button" onClick={() => void query.refetch()}>Retry settings</button></div></td></tr>;
          if (query?.isLoading || !settings) return <tr key={organization.id}><th scope="row">{organization.login}</th><td colSpan={4}><span className="settings-status" role="status">Loading organization settings…</span></td></tr>;
          return <tr key={organization.id}><th scope="row">{organization.login}</th>{fields.map(([name, label, description]) => <td key={name}><label className="settings-table-field"><span className="sr-only">{label} for {organization.login}</span><input aria-label={`${organization.login} ${label}`} title={description} type="number" min={1} step={name.includes("GiB") ? 0.25 : 1} required value={rowValues?.[name] ?? 1} onChange={(event) => setValues((current) => ({ ...current, [organization.id]: { ...(current[organization.id] ?? rowValues), [name]: Number(event.target.value) } }))} /></label></td>)}<td><button className="button" type="button" onClick={() => submitRow(settings)} disabled={saving}>{saving ? "Saving…" : "Save"}</button></td></tr>;
        })}</tbody></table></div>}
        {organizations.map((organization) => (validation[organization.id]?.length ?? 0) > 0 || saveErrors[organization.id] ? <div key={`${organization.id}-error`} className="form-error" role="alert"><strong>{organization.login}:</strong>{saveErrors[organization.id] && <p>{saveErrors[organization.id]}</p>}{validation[organization.id]?.length ? <ul>{validation[organization.id].map((message, index) => <li key={`${organization.id}-${index}`}>{message}</li>)}</ul> : null}</div> : null)}
      </section>
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
