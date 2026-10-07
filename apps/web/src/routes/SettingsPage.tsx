import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  beginOrganizationGithubInstall,
  deleteLlmProvider,
  getControlPlaneLogs,
  getGithubConnection,
  getGithubOrganizationSettings,
  getGithubRateLimit,
  getLlmProviders,
  getMe,
  getOrganizations,
  getRepositories,
  getRepositoryFailureAnalysisSettings,
  logout,
  refreshGithubConnection,
  saveLlmProvider,
  saveRepositoryFailureAnalysisSettings,
  testLlmProvider,
  uninstallOrganizationGithub,
} from "../api.ts";
import type { ControlPlaneLogLevel } from "../api.ts";
import { useTheme, themeOptions } from "../theme.ts";
import { useOrganization } from "../organization.ts";


async function getAllRepositories(organizationId: string) {
  const items = [];
  let cursor: string | null = null;
  do {
    const page = await getRepositories(organizationId, { cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return Promise.all(items.map(async (repository) => ({
    repository,
    settings: await getRepositoryFailureAnalysisSettings(organizationId, repository.id),
  })));
}

function LlmSettings({ organizations }: { organizations: Array<{ id: string; login: string }> }) {
  const client = useQueryClient();
  const providers = useQuery({ queryKey: ["admin", "llm-providers"], queryFn: getLlmProviders, staleTime: 30_000 });
  const repositories = useQueries({ queries: organizations.map((organization) => ({
    queryKey: ["failure-analysis-settings", organization.id],
    queryFn: () => getAllRepositories(organization.id),
  })) });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"openai-compatible" | "anthropic">("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const providerRows = providers.data ?? [];
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["admin", "llm-providers"] });
    void Promise.all(organizations.map((organization) => client.invalidateQueries({ queryKey: ["failure-analysis-settings", organization.id] })));
  };
  const [saving, setSaving] = useState(false);
  const remove = useMutation({ mutationFn: deleteLlmProvider, onSuccess: invalidate, onError: (reason) => setError(githubError(reason, "Unable to delete provider.")) });
  const test = useMutation({ mutationFn: testLlmProvider, onError: (reason) => setError(githubError(reason, "Provider test failed.")) });
  const updateSetting = useMutation({
    mutationFn: ({ organizationId, repositoryId, enabled, providerId }: { organizationId: string; repositoryId: string; enabled: boolean; providerId: string | null }) =>
      saveRepositoryFailureAnalysisSettings(organizationId, repositoryId, { enabled, providerId }),
    onSuccess: invalidate,
    onError: (reason) => setError(githubError(reason, "Unable to save repository settings.")),
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(null); setSaving(true);
    try {
      await saveLlmProvider({ ...(editingId ? { id: editingId } : {}), name, kind, baseUrl, model, ...(apiKey ? { apiKey } : clearKey ? { apiKey: null } : {}) });
      setApiKey(""); setClearKey(false); setEditingId(null); setName(""); setBaseUrl(""); setModel(""); invalidate();
    } catch (reason) { setError(githubError(reason, "Unable to save provider.")); }
    finally { setSaving(false); }
  };
  const edit = (provider: typeof providerRows[number]) => {
    setEditingId(provider.id); setName(provider.name); setKind(provider.kind);
    setBaseUrl(provider.baseUrl); setModel(provider.model); setApiKey(""); setClearKey(false);
  };
  return <section className="settings-deployment" aria-labelledby="llm-settings-title">
    <div className="panel-heading"><div><p className="eyebrow">Failure analysis</p><h2 id="llm-settings-title">LLM providers and repository opt-in</h2></div></div>
    <p className="form-help">Provider keys are sent only from the control plane. Local endpoints must be reachable from that host/container.</p>
    {providers.error && <p className="form-error" role="alert">{githubError(providers.error, "Unable to load LLM providers.")}</p>}
    {providerRows.map((provider) => <article className="settings-github-card" key={provider.id}>
      <h3>{provider.name}</h3><p>{provider.kind} · {provider.baseUrl} · {provider.model}</p>
      <p>{provider.keyConfigured ? "API key configured" : "No API key configured"}</p>
      {provider.baseUrl.startsWith("http://") && <p className="form-error">Warning: HTTP does not encrypt traffic to this provider.</p>}
      <div className="settings-actions"><button className="button secondary" type="button" onClick={() => edit(provider)}>Edit</button>
        <button className="button secondary" type="button" onClick={() => test.mutate(provider.id)} disabled={test.isPending}>{test.isPending ? "Testing…" : "Test connection"}</button>
        <button className="button secondary" type="button" onClick={() => remove.mutate(provider.id)} disabled={remove.isPending}>Delete</button></div>
    </article>)}
    <form onSubmit={submit} className="settings-github-card">
      <h3>{editingId ? "Edit provider" : "Add provider"}</h3>
      <label>Profile name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Provider kind<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
      <label>API root<input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://localhost:11434/v1" /></label>
      {baseUrl.startsWith("http://") && <p className="form-error">Warning: HTTP traffic is not encrypted.</p>}
      <label>Model ID<input required value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <label>API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }} placeholder={editingId ? "Leave blank to keep current key" : "Optional for OpenAI-compatible local servers"} /></label>
      {editingId && <label><input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); setApiKey(""); }} /> Clear configured API key</label>}
      <div className="settings-actions"><button className="button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save provider"}</button>{editingId && <button className="button secondary" type="button" onClick={() => { setEditingId(null); setApiKey(""); setClearKey(false); setName(""); setBaseUrl(""); setModel(""); }}>Cancel</button>}</div>
    </form>
    {error && <p role="alert" className="form-error">{error}</p>}
    {test.data && <p role="status">Provider connection succeeded.</p>}
    <h3>Repository opt-in</h3>
    {repositories.map((query, index) => <section key={organizations[index].id} className="settings-github-card">
      <h4>{organizations[index].login}</h4>
      {query.isLoading && <p role="status">Loading repositories…</p>}
      {query.error && <p role="alert" className="form-error">Unable to load repository settings: {githubError(query.error, "Try again.")}</p>}
      {query.data?.map(({ repository, settings }) => {
        const key = `${organizations[index].id}:${repository.id}`;
        return <div key={key}>
          <label><input type="checkbox" checked={settings.enabled} disabled={updateSetting.isPending || (!settings.enabled && (!settings.providerId || providerRows.length === 0))} onChange={(event) => {
            const enabled = event.target.checked;
            if (enabled && !acknowledged[key]) return;
            updateSetting.mutate({ organizationId: organizations[index].id, repositoryId: repository.id, enabled, providerId: settings.providerId });
          }} /> {repository.fullName ?? repository.name}</label>
          <label>Analysis provider<select value={settings.providerId ?? ""} disabled={updateSetting.isPending} onChange={(event) => updateSetting.mutate({ organizationId: organizations[index].id, repositoryId: repository.id, enabled: settings.enabled, providerId: event.target.value || null })}>
            <option value="">Select profile</option>{providerRows.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select></label>
          {!settings.enabled && <label><input type="checkbox" checked={acknowledged[key] ?? false} onChange={(event) => setAcknowledged({ ...acknowledged, [key]: event.target.checked })} /> I acknowledge failed log excerpts will be sent to the selected endpoint and generated feedback posted on associated pull requests.</label>}
          {settings.enabled && !settings.providerId && <p className="form-error">Select a saved profile before enabling analysis.</p>}
        </div>;
      })}
    </section>)}
  </section>;
}

function number(value: number) {
  return value.toLocaleString("en-US");
}

function githubError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
function ControlPlaneLogs() {
  const [level, setLevel] = useState<ControlPlaneLogLevel | "">("");
  const [search, setSearch] = useState("");
  const [contains, setContains] = useState("");
  const logs = useQuery({
    queryKey: ["control-plane-logs", level, contains],
    queryFn: () => getControlPlaneLogs({ level: level || undefined, contains: contains || undefined }),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setContains(search.trim());
  };

  return <section className="settings-deployment" aria-labelledby="control-plane-logs-title">
    <div className="panel-heading"><div><p className="eyebrow">Deployment diagnostics</p><h2 id="control-plane-logs-title">Control-plane logs</h2></div><button className="button secondary" type="button" onClick={() => void logs.refetch()} disabled={logs.isFetching}>Refresh</button></div>
    <p className="form-help">Recent logs from this control-plane process, retained in memory until restart. Showing the latest 200 matching entries; updates every 5 seconds.</p>
    <form className="control-plane-log-filters" onSubmit={submit}>
      <label>Level <select value={level} onChange={(event) => setLevel(event.target.value as ControlPlaneLogLevel | "")}><option value="">All levels</option><option value="log">Log</option><option value="warn">Warning</option><option value="error">Error</option></select></label>
      <label>Contains <input type="search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search messages" /></label>
      <button className="button secondary" type="submit">Search logs</button>
    </form>
    {logs.isLoading && <p className="settings-status" role="status">Loading control-plane logs…</p>}
    {logs.error && <div className="form-error" role="alert">Unable to load control-plane logs: {logs.error instanceof Error ? logs.error.message : "Try again."} <button className="button secondary" type="button" onClick={() => void logs.refetch()}>Retry logs</button></div>}
    {!logs.error && logs.data && (logs.data.items.length === 0
      ? <p className="settings-status">No matching logs in this process.</p>
      : <div className="control-plane-log-output" role="log" aria-label="Control-plane log output" tabIndex={0}>{logs.data.items.map((entry) =>
        <div className={`control-plane-log-line control-plane-log-${entry.level}`} key={entry.sequence}><time dateTime={entry.occurredAt}>{entry.occurredAt}</time> <span className="control-plane-log-level">{entry.level}</span> <span>{entry.message}</span></div>,
      )}</div>)}
  </section>;
}


export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const signOut = useMutation({ mutationFn: logout, onSuccess: () => { client.clear(); window.location.assign("/onboarding"); } });
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const organizations = organizationsQuery.data ?? [];
  const { organizationId, setOrganizationId } = useOrganization(organizationsQuery.data);
  const githubOrganization = organizations.find((organization) => organization.id === organizationId);
  const githubOrganizationId = githubOrganization?.id ?? "";
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
      <section className="settings-theme" aria-labelledby="theme-title">
        <div className="panel-heading"><div><p className="eyebrow">Interface appearance</p><h2 id="theme-title">Colour palette</h2></div></div>
        <p className="form-help">Choose the accessible MARS palette used across the console. Default is the neutral accessible palette; Martian restores the warm orange-and-purple MARS treatment. Your choice is saved on this device.</p>
        <label className="settings-theme-select">Theme
          <select value={theme} onChange={(event) => setTheme(event.target.value as typeof theme)}>
            {themeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
      </section>
      <section className="settings-account" aria-labelledby="account-title"><h2 id="account-title">Signed-in identity</h2><p>{me.data ? `GitHub account: ${me.data.login}` : "Loading GitHub identity…"}</p><button className="button secondary" type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>{signOut.isPending ? "Signing out…" : "Sign out"}</button>{signOut.error && <p className="form-error" role="alert">{signOut.error instanceof Error ? signOut.error.message : "Sign out failed."}</p>}</section>
      <section className="settings-deployment" aria-labelledby="deployment-integrations-title">
        <div className="panel-heading"><div><p className="eyebrow">Deployment integrations</p><h2 id="deployment-integrations-title">GitHub connections</h2></div></div>
        <p className="form-help">Select the workspace whose GitHub installation and API quota you want to manage.</p>
        <label className="settings-theme-select">GitHub workspace
          <select aria-label="Select GitHub workspace" value={githubOrganizationId} disabled={githubMutationPending} onChange={(event) => setOrganizationId(event.target.value || "all")}>
            <option value="">Select a workspace</option>
            {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}
          </select>
        </label>
        {!githubOrganizationId && <p className="settings-status" role="status">Choose a workspace to view or change its GitHub connection.</p>}
        {githubOrganizationId && <>
        <section className="settings-github-card" aria-labelledby="github-connection-title">
          <div className="panel-heading"><div><p className="eyebrow">Organization integration</p><h2 id="github-connection-title">GitHub connection</h2></div>{!connection.error && connection.data?.connected && <span className="status-ready">Connected</span>}</div>
          <p className="form-help">Managing the GitHub App installation for <strong>{githubOrganization?.login}</strong>.</p>
          {!connection.error && connection.isLoading && <p className="settings-status" role="status">Loading GitHub connection…</p>}
          {connection.error && <div className="form-error" role="alert"><p>Unable to load GitHub connection: {githubError(connection.error, "Try again.")}</p><button className="button secondary" type="button" onClick={() => void connection.refetch()}>Retry connection</button></div>}
          {!connection.error && connection.data?.connected === false && <div className="settings-github-disconnected"><p>No GitHub App installation is connected to this organization.</p><button className="button" type="button" onClick={() => install.mutate()} disabled={githubMutationPending}>{install.isPending ? "Opening GitHub…" : "Add GitHub connection"}</button></div>}
          {!connection.error && connection.data?.connected && <div className="settings-github-connected"><dl className="settings-github-details"><div><dt>GitHub account</dt><dd>{connection.data.login ?? "Unavailable"}</dd></div><div><dt>Account type</dt><dd>{connection.data.accountType ?? "Unavailable"}</dd></div><div><dt>Installation</dt><dd>{connection.data.installationId ? `#${connection.data.installationId}` : "Connected"}</dd></div></dl><div className="settings-actions"><button className="button secondary" type="button" onClick={() => manageInstallation.mutate()} disabled={githubMutationPending}>{manageInstallation.isPending ? "Opening GitHub…" : "Manage installation"}</button><button className="button secondary" type="button" onClick={() => sync.mutate()} disabled={githubMutationPending}>{sync.isPending ? "Syncing…" : "Sync repositories"}</button><button className="button destructive" type="button" onClick={() => { if (window.confirm(`Uninstall Mars from ${githubOrganization?.login}? Its repositories will no longer receive Mars jobs.`)) remove.mutate(); }} disabled={githubMutationPending}>{remove.isPending ? "Removing…" : "Remove connection"}</button></div></div>}
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
        </>}
      </section>
      {me.data?.isGlobalAdmin && <><LlmSettings organizations={organizations} /><ControlPlaneLogs /></>}
    </>
  );
}
