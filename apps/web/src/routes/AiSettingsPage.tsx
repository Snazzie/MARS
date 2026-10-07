import { useState, type FormEvent } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteLlmProvider, getLlmProviders, getMe, getOrganizations, getRepositories, getRepositoryFailureAnalysisSettings, saveLlmProvider, saveRepositoryFailureAnalysisSettings, testLlmProvider } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";

async function getAllRepositories(organizationId: string) {
  const items = [];
  let cursor: string | null = null;
  do {
    const page = await getRepositories(organizationId, { cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return Promise.all(items.map(async (repository) => ({ repository, settings: await getRepositoryFailureAnalysisSettings(organizationId, repository.id) })));
}

const errorMessage = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

export function AiSettingsPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  if (me.isLoading || me.error) return <QueryState isLoading={me.isLoading} error={me.error} retry={() => void me.refetch()} operationLabel="AI settings access" />;
  if (!me.data?.isGlobalAdmin) return <section className="ai-settings"><header className="page-header"><p className="eyebrow">Deployment configuration</p><h1>AI Settings</h1><p>Only global administrators can manage AI providers and repository access.</p></header></section>;
  return <AiSettings />;
}

function AiSettings() {
  const client = useQueryClient();
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const organizations = organizationsQuery.data ?? [];
  const providers = useQuery({ queryKey: ["admin", "llm-providers"], queryFn: getLlmProviders, staleTime: 30_000 });
  const repositories = useQueries({ queries: organizations.map((organization) => ({ queryKey: ["failure-analysis-settings", organization.id], queryFn: () => getAllRepositories(organization.id) })) });
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"openai-compatible" | "anthropic">("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const providerRows = providers.data ?? [];
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["admin", "llm-providers"] });
    void Promise.all(organizations.map((organization) => client.invalidateQueries({ queryKey: ["failure-analysis-settings", organization.id] })));
  };
  const resetForm = () => {
    setFormOpen(false); setEditingId(null); setName(""); setKind("openai-compatible"); setBaseUrl(""); setModel(""); setApiKey(""); setClearKey(false);
  };
  const remove = useMutation({ mutationFn: deleteLlmProvider, onSuccess: invalidate, onError: (reason) => setError(errorMessage(reason, "Unable to delete provider.")) });
  const test = useMutation({ mutationFn: testLlmProvider, onError: (reason) => setError(errorMessage(reason, "Provider test failed.")) });
  const updateSetting = useMutation({
    mutationFn: ({ organizationId, repositoryId, enabled, providerId }: { organizationId: string; repositoryId: string; enabled: boolean; providerId: string | null }) => saveRepositoryFailureAnalysisSettings(organizationId, repositoryId, { enabled, providerId }),
    onSuccess: invalidate,
    onError: (reason) => setError(errorMessage(reason, "Unable to save repository settings.")),
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(null); setSaving(true);
    try {
      await saveLlmProvider({ ...(editingId ? { id: editingId } : {}), name, kind, baseUrl, model, ...(apiKey ? { apiKey } : clearKey ? { apiKey: null } : {}) });
      resetForm(); invalidate();
    } catch (reason) { setError(errorMessage(reason, "Unable to save provider.")); }
    finally { setSaving(false); }
  };
  return <div className="ai-settings">
    <header className="page-header"><p className="eyebrow">Deployment configuration</p><h1>AI Settings</h1><p>Connect a model, then choose which repositories receive pipeline failure explanations and suggested fixes.</p></header>
    <div className="ai-notice"><strong>Advisory analysis, not automatic changes.</strong><span>Failed log excerpts go to your selected provider. Results appear in MARS and on associated pull requests as the installed MARS App.</span></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    <section className="ai-section" aria-labelledby="ai-providers-title">
      <div className="panel-heading"><div><p className="eyebrow">01 / Connect</p><h2 id="ai-providers-title">Model providers</h2><p className="form-help">Use a local endpoint or cloud API. Keys stay on the control plane.</p></div><button className="button" type="button" disabled={formOpen} onClick={() => { resetForm(); setFormOpen(true); }}>Add provider</button></div>
      {providers.isLoading && <p role="status">Loading providers…</p>}
      {providers.error && <p className="form-error" role="alert">{errorMessage(providers.error, "Unable to load providers.")} <button className="button secondary" onClick={() => void providers.refetch()}>Retry</button></p>}
      {!providers.isLoading && !providers.error && providerRows.length === 0 && <div className="ai-empty"><h3>No providers connected</h3><p>Add an OpenAI-compatible or Anthropic profile to get started. Local servers can run without an API key.</p></div>}
      <div className="ai-provider-grid">{providerRows.map((provider) => <article className="ai-provider-card" key={provider.id}>
        <div className="panel-heading"><h3>{provider.name}</h3><span className="ai-badge">{provider.kind === "anthropic" ? "Anthropic" : "OpenAI-compatible"}</span></div>
        <dl className="ai-provider-details"><div><dt>Model</dt><dd>{provider.model}</dd></div><div><dt>API root</dt><dd>{provider.baseUrl}</dd></div></dl>
        <p className="form-help">{provider.keyConfigured ? "API key configured" : "No API key configured"}</p>
        {provider.baseUrl.startsWith("http://") && <p className="ai-warning">Warning: HTTP does not encrypt traffic to this provider.</p>}
        {test.variables === provider.id && test.isSuccess && <p role="status" className="ai-success">Connection verified.</p>}
        <div className="settings-actions"><button className="button secondary" type="button" disabled={saving} onClick={() => { setEditingId(provider.id); setName(provider.name); setKind(provider.kind); setBaseUrl(provider.baseUrl); setModel(provider.model); setApiKey(""); setClearKey(false); setFormOpen(true); }}>Edit</button><button className="button secondary" type="button" onClick={() => { setError(null); test.mutate(provider.id); }} disabled={test.isPending}>{test.isPending && test.variables === provider.id ? "Testing…" : "Test connection"}</button><button className="button secondary" type="button" onClick={() => { setError(null); remove.mutate(provider.id); }} disabled={remove.isPending || saving}>Delete</button></div>
      </article>)}</div>
      {formOpen && <form onSubmit={submit} className="ai-provider-form" aria-labelledby="ai-provider-form-title">
        <h3 id="ai-provider-form-title">{editingId ? "Edit provider" : "Add provider"}</h3>
        <div className="ai-form-grid">
          <label>Profile name<input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Local development" /></label>
          <label>Provider type<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select></label>
          <label>API root<input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={kind === "anthropic" ? "https://api.anthropic.com/v1" : "http://localhost:11434/v1"} /></label>
          <label>Model ID<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="Exact model ID from your provider" /></label>
          <label className="ai-form-wide">API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }} placeholder={editingId ? "Leave blank to keep current key" : kind === "anthropic" ? "Required for Anthropic" : "Optional for local servers"} /></label>
        </div>
        <p className="form-help">Local endpoints must be reachable from the control-plane host or container, not your browser.</p>
        {baseUrl.startsWith("http://") && <p className="ai-warning">Warning: HTTP traffic is not encrypted.</p>}
        {editingId && <label className="ai-checkbox"><input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); setApiKey(""); }} />Clear configured API key</label>}
        <div className="settings-actions"><button className="button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save provider"}</button><button className="button secondary" type="button" disabled={saving} onClick={resetForm}>Cancel</button></div>
      </form>}
    </section>
    <section className="ai-section" aria-labelledby="ai-repositories-title">
      <div><p className="eyebrow">02 / Enable</p><h2 id="ai-repositories-title">Repository access</h2><p className="form-help">Opt in per repository. Only newly completed failures are analyzed; successful runs are unchanged.</p></div>
      <QueryState isLoading={organizationsQuery.isLoading} error={organizationsQuery.error} retry={() => void organizationsQuery.refetch()} operationLabel="workspaces" />
      {!organizationsQuery.isLoading && !organizationsQuery.error && organizations.length === 0 && <p className="ai-empty">No accessible workspaces. Connect a GitHub installation in Settings first.</p>}
      {repositories.map((query, index) => <section key={organizations[index].id} className="ai-workspace" aria-label={`${organizations[index].login} repositories`}>
        <h3>{organizations[index].login}</h3>
        {query.isLoading && <p role="status">Loading repositories…</p>}
        {query.error && <p role="alert" className="form-error">{errorMessage(query.error, "Unable to load repository settings.")} <button className="button secondary" onClick={() => void query.refetch()}>Retry</button></p>}
        {query.data?.length === 0 && <p className="form-help">No repositories available in this workspace.</p>}
        {query.data?.map(({ repository, settings }) => {
          const key = `${organizations[index].id}:${repository.id}`;
          const blocked = updateSetting.isPending || !!providers.error || providers.isLoading;
          return <div className="ai-repository" key={key}>
            <div className="ai-repository-heading"><div><h4>{repository.fullName ?? repository.name}</h4><span className="form-help">{repository.available ? settings.enabled ? "Automatic analysis enabled" : "Automatic analysis disabled" : "Repository unavailable"}</span></div><label className="ai-checkbox"><input type="checkbox" checked={settings.enabled} disabled={blocked || (!settings.enabled && (!repository.available || !settings.providerId || !acknowledged[key] || providerRows.length === 0))} onChange={(event) => updateSetting.mutate({ organizationId: organizations[index].id, repositoryId: repository.id, enabled: event.target.checked, providerId: settings.providerId })} />Enable analysis<span className="sr-only"> for {repository.fullName ?? repository.name}</span></label></div>
            <label className="ai-provider-select">Analysis provider<span className="sr-only"> for {repository.fullName ?? repository.name}</span><select value={settings.providerId ?? ""} disabled={blocked || !repository.available} onChange={(event) => { setAcknowledged((current) => ({ ...current, [key]: false })); updateSetting.mutate({ organizationId: organizations[index].id, repositoryId: repository.id, enabled: settings.enabled, providerId: event.target.value || null }); }}><option value="" disabled={settings.enabled}>Select profile</option>{providerRows.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
            {!settings.enabled && repository.available && <label className="ai-checkbox ai-consent"><input type="checkbox" checked={acknowledged[key] ?? false} onChange={(event) => setAcknowledged((current) => ({ ...current, [key]: event.target.checked }))} />I acknowledge failed log excerpts will be sent to the selected endpoint and generated feedback posted on associated pull requests.</label>}
          </div>;
        })}
      </section>)}
    </section>
  </div>;
}
