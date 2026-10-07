import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteLlmProvider, getLlmProviders, getLlmProviderModels, getMe, getOrganizations, getRepositories, getRepositoryFailureAnalysisSettings, saveLlmProvider, saveRepositoryFailureAnalysisSettings, testLlmProvider } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { AiTokenUsage } from "../components/AiTokenUsage.tsx";
import { LlmProviderDefaultApiRoots } from "@mars/contracts";

const providerTypes = {
  "lm-studio": { label: "LM Studio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" },
  ollama: { label: "Ollama", kind: "openai-compatible", baseUrl: LlmProviderDefaultApiRoots["openai-compatible"] },
  "openai-compatible": { label: "OpenAI-compatible", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", kind: "anthropic", baseUrl: LlmProviderDefaultApiRoots.anthropic },
} as const;
type ProviderType = keyof typeof providerTypes;

function providerTypeFor(provider: { kind: "openai-compatible" | "anthropic"; baseUrl: string }): ProviderType {
  if (provider.kind === "anthropic") return "anthropic";
  const port = new URL(provider.baseUrl).port;
  return port === "1234" ? "lm-studio" : port === "11434" ? "ollama" : "openai-compatible";
}

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
  const [providerType, setProviderType] = useState<ProviderType>("lm-studio");
  const { kind, baseUrl: defaultBaseUrl } = providerTypes[providerType];
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelLookupRevision, setModelLookupRevision] = useState(0);
  const effectiveBaseUrl = baseUrl.trim() || defaultBaseUrl;
  const localProvider = providerType === "lm-studio" || providerType === "ollama";
  useEffect(() => {
    setAvailableModels([]); setModelsError(null); setModelsLoading(false);
    if (!formOpen || kind !== "openai-compatible") return;
    const controller = new AbortController();
    setModelsLoading(true);
    const timer = setTimeout(() => {
      void getLlmProviderModels({ baseUrl: effectiveBaseUrl, ...(editingId ? { providerId: editingId } : {}), ...(apiKey ? { apiKey } : clearKey ? { apiKey: null } : {}) }, controller.signal)
        .then(({ models }) => { if (!controller.signal.aborted) setAvailableModels(models); })
        .catch((reason) => { if (!controller.signal.aborted) setModelsError(errorMessage(reason, "Unable to list models. Enter a model ID manually.")); })
        .finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [formOpen, providerType, kind, effectiveBaseUrl, apiKey, clearKey, editingId, modelLookupRevision]);
  const providerRows = providers.data ?? [];
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["admin", "llm-providers"] });
    void Promise.all(organizations.map((organization) => client.invalidateQueries({ queryKey: ["failure-analysis-settings", organization.id] })));
  };
  const resetForm = () => {
    setFormOpen(false); setEditingId(null); setName(""); setProviderType("lm-studio"); setBaseUrl(""); setModel(""); setApiKey(""); setClearKey(false);
    setInputPrice(""); setOutputPrice("");
  };
  const remove = useMutation({ mutationFn: deleteLlmProvider, onSuccess: invalidate, onError: (reason) => setError(errorMessage(reason, "Unable to delete provider.")) });
  const test = useMutation({ mutationFn: testLlmProvider, onError: (reason) => setError(errorMessage(reason, "Provider test failed.")) });
  const updateSetting = useMutation({
    mutationFn: ({ organizationId, repositoryId, enabled, providerId }: { organizationId: string; repositoryId: string; enabled: boolean; providerId: string | null }) => saveRepositoryFailureAnalysisSettings(organizationId, repositoryId, { enabled, providerId }),
    onSuccess: invalidate,
    onError: (reason) => setError(errorMessage(reason, "Unable to save repository settings.")),
  });
  const repositoryRows = repositories.flatMap((query, index) => (query.data ?? []).map((row) => ({ ...row, organizationId: organizations[index].id, workspace: organizations[index].login })));
  const selectedProviderIds = new Set(repositoryRows.map(({ settings }) => settings.providerId));
  const sharedProviderId = selectedProviderIds.size === 1 ? [...selectedProviderIds][0] ?? "" : "";
  const updateRepositories = useMutation({
    mutationFn: async ({ providerId, enableAll }: { providerId: string; enableAll?: boolean }) => {
      const results = await Promise.allSettled(repositoryRows.map(({ repository, settings, organizationId }) =>
        saveRepositoryFailureAnalysisSettings(organizationId, repository.id, { providerId, enabled: enableAll && repository.available ? true : settings.enabled })));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new Error(`${failures.length} repository updates failed. Some changes may have saved; retry to apply the same provider to all repositories.`);
    },
    onSettled: invalidate,
    onError: (reason) => setError(errorMessage(reason, "Unable to update repositories.")),
  });
  const accessBlocked = updateSetting.isPending || updateRepositories.isPending || providers.isFetching || !!providers.error || organizationsQuery.isFetching || !!organizationsQuery.error || repositories.some((query) => query.isFetching || !!query.error);
  const providerReady = !!sharedProviderId && providerRows.some((provider) => provider.id === sharedProviderId) && repositoryRows.every(({ settings }) => settings.providerId === sharedProviderId);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(null); setSaving(true);
    try {
      await saveLlmProvider({ ...(editingId ? { id: editingId } : {}), name, kind, baseUrl: effectiveBaseUrl, model, inputUsdPerMillionTokens: localProvider ? 0 : inputPrice === "" ? null : Number(inputPrice), outputUsdPerMillionTokens: localProvider ? 0 : outputPrice === "" ? null : Number(outputPrice), ...(apiKey ? { apiKey } : clearKey ? { apiKey: null } : {}) });
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
        <div className="panel-heading"><h3>{provider.name}</h3><span className="ai-badge">{providerTypes[providerTypeFor(provider)].label}</span></div>
        <dl className="ai-provider-details"><div><dt>Model</dt><dd>{provider.model}</dd></div><div><dt>API root</dt><dd>{provider.baseUrl}</dd></div></dl>
        <p className="form-help">{provider.keyConfigured ? "API key configured" : "No API key configured"}</p>
        {provider.baseUrl.startsWith("http://") && <p className="ai-warning">Warning: HTTP does not encrypt traffic to this provider.</p>}
        {test.variables === provider.id && test.isSuccess && <p role="status" className="ai-success">Connection verified.</p>}
        <div className="settings-actions"><button className="button secondary" type="button" disabled={saving} onClick={() => { setEditingId(provider.id); setName(provider.name); setProviderType(providerTypeFor(provider)); setBaseUrl(provider.baseUrl); setModel(provider.model); setApiKey(""); setInputPrice(provider.inputUsdPerMillionTokens == null ? "" : String(provider.inputUsdPerMillionTokens)); setOutputPrice(provider.outputUsdPerMillionTokens == null ? "" : String(provider.outputUsdPerMillionTokens)); setClearKey(false); setFormOpen(true); }}>Edit</button><button className="button secondary" type="button" onClick={() => { setError(null); test.mutate(provider.id); }} disabled={test.isPending}>{test.isPending && test.variables === provider.id ? "Testing…" : "Test connection"}</button><button className="button secondary" type="button" onClick={() => { setError(null); remove.mutate(provider.id); }} disabled={remove.isPending || saving}>Delete</button></div>
      </article>)}</div>
      {formOpen && <form onSubmit={submit} className="ai-provider-form" aria-labelledby="ai-provider-form-title">
        <h3 id="ai-provider-form-title">{editingId ? "Edit provider" : "Add provider"}</h3>
        <div className="ai-form-grid">
          <label>Profile name<input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Local development" /></label>
          <label>Provider type<select value={providerType} onChange={(event) => { setProviderType(event.target.value as ProviderType); setBaseUrl(""); setModel(""); setApiKey(""); setInputPrice(""); setOutputPrice(""); setClearKey(!!editingId); }}>{Object.entries(providerTypes).map(([value, provider]) => <option key={value} value={value}>{provider.label}</option>)}</select></label>
          <label>API root<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={defaultBaseUrl} /><span className="form-help">Leave blank to use {defaultBaseUrl}.</span></label>
          {(kind !== "openai-compatible" || availableModels.length === 0) && <label>Model ID<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="Enter a model ID" /></label>}
          <label className="ai-form-wide">API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }} placeholder={editingId ? "Leave blank to keep current key" : kind === "anthropic" ? "Required for Anthropic" : "Optional for local servers"} /></label>
          {!localProvider && <>
            <label>Input price (USD / million tokens)<input type="number" min="0" step="any" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} placeholder="Leave blank if unknown" /></label>
            <label>Output price (USD / million tokens)<input type="number" min="0" step="any" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} placeholder="Leave blank if unknown" /></label>
          </>}
        </div>
        {kind === "openai-compatible" && <div className="ai-model-lookup">
          <div className="settings-actions"><button className="button secondary" type="button" disabled={modelsLoading} onClick={() => setModelLookupRevision((value) => value + 1)}>{modelsLoading ? "Loading models…" : "Refresh models"}</button>
            {availableModels.length > 0 && <label className="ai-provider-select">Available models<select required value={model} onChange={(event) => setModel(event.target.value)}><option value="">Choose a model</option>{model && !availableModels.includes(model) && <option value={model}>{model}</option>}{availableModels.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>}
          </div>
          {modelsLoading && <p className="form-help" role="status">Looking up models from the control plane…</p>}
          {modelsError && <p className="form-help" role="status">{modelsError} You can still enter the model ID manually.</p>}
          {modelsError && providerType === "lm-studio" && <p className="form-help">In LM Studio, open Developer and start the local server (default port 1234). If MARS runs on another host, enable “Serve on Local Network” and enter this machine’s reachable address instead of localhost.</p>}
          {modelsError && providerType === "ollama" && <p className="form-help">Start Ollama’s API server (default port 11434). If MARS runs on another host, configure Ollama to listen on a reachable network address and use that address instead of localhost.</p>}
          {!modelsLoading && !modelsError && availableModels.length === 0 && <p className="form-help">No models reported by this endpoint. Enter a model ID manually.</p>}
        </div>}
        <p className="form-help">{localProvider ? "Local providers have $0 API cost." : "Cost estimates use these prices and provider-reported token counts. Leave unknown prices blank; unpriced requests are not treated as free."}</p>
        <p className="form-help">Local endpoints must be reachable from the control-plane host or container, not your browser.</p>
        {effectiveBaseUrl.startsWith("http://") && <p className="ai-warning">Warning: HTTP traffic is not encrypted.</p>}
        {editingId && <label className="ai-checkbox"><input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); setApiKey(""); }} />Clear configured API key</label>}
        <div className="settings-actions"><button className="button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save provider"}</button><button className="button secondary" type="button" disabled={saving} onClick={resetForm}>Cancel</button></div>
      </form>}
    </section>
    <section className="ai-section" aria-labelledby="ai-repositories-title">
      <div><p className="eyebrow">02 / Enable</p><h2 id="ai-repositories-title">Repository access</h2><p className="form-help">All repositories use the same provider and model. Only newly completed failures are analyzed; successful runs are unchanged.</p></div>
      <div className="settings-actions">
        <label className="ai-provider-select">Analysis provider for all repositories<select value={sharedProviderId} disabled={accessBlocked || repositoryRows.length === 0} onChange={(event) => { setError(null); setAcknowledged(false); updateRepositories.mutate({ providerId: event.target.value }); }}><option value="" disabled>Select profile</option>{providerRows.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} — {provider.model}</option>)}</select></label>
        <button className="button" type="button" disabled={accessBlocked || !providerReady || !acknowledged || !repositoryRows.some(({ repository, settings }) => repository.available && !settings.enabled)} onClick={() => { setError(null); updateRepositories.mutate({ providerId: sharedProviderId, enableAll: true }); }}>Enable all</button>
      </div>
      {selectedProviderIds.size > 1 && <p className="ai-warning">Repositories currently use different providers. Select one profile to apply it to all repositories.</p>}
      <label className="ai-checkbox ai-consent"><input type="checkbox" checked={acknowledged} disabled={accessBlocked || !providerReady} onChange={(event) => setAcknowledged(event.target.checked)} />I acknowledge failed log excerpts will be sent to the selected endpoint and generated feedback posted on associated pull requests.</label>
      <QueryState isLoading={organizationsQuery.isLoading} error={organizationsQuery.error} retry={() => void organizationsQuery.refetch()} operationLabel="workspaces" />
      {!organizationsQuery.isLoading && !organizationsQuery.error && organizations.length === 0 && <p className="ai-empty">No accessible workspaces. Connect a GitHub installation in Settings first.</p>}
      {repositories.map((query, index) => <QueryState key={organizations[index].id} isLoading={query.isLoading} error={query.error} retry={() => void query.refetch()} operationLabel={`${organizations[index].login} repositories`} />)}
      <div className="ai-repository-table-wrap"><table className="ai-repository-table">
        <thead><tr><th scope="col">Repository</th><th scope="col">Workspace</th><th scope="col">Status</th><th scope="col">Analysis</th></tr></thead>
        <tbody>{repositoryRows.map(({ repository, settings, organizationId, workspace }) => <tr key={`${organizationId}:${repository.id}`}>
          <th scope="row">{repository.fullName ?? repository.name}</th>
          <td>{workspace}</td>
          <td>{repository.available ? settings.enabled ? "Enabled" : "Disabled" : "Unavailable"}</td>
          <td><label className="ai-checkbox"><input type="checkbox" checked={settings.enabled} disabled={accessBlocked || (!settings.enabled && (!repository.available || !providerReady || !acknowledged))} onChange={(event) => { setError(null); updateSetting.mutate({ organizationId, repositoryId: repository.id, enabled: event.target.checked, providerId: settings.enabled ? settings.providerId : sharedProviderId }); }} /><span className="sr-only">Enable analysis for {repository.fullName ?? repository.name}</span></label></td>
        </tr>)}</tbody>
      </table></div>
      {!accessBlocked && organizations.length > 0 && repositoryRows.length === 0 && <p className="form-help">No repositories available.</p>}
      <p className="form-help">Enable all applies to currently available repositories. Unavailable repositories are not newly enabled.</p>
    </section>
    <AiTokenUsage />
  </div>;
}
