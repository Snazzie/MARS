import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteLlmProvider, getGlobalFailureAnalysisSettings, getLlmProviders, getLlmProviderModels, getMe, getOrganizations, getRepositories, getRepositoryFailureAnalysisSettings, getRepositoryPrReviewSettings, getLatestPrReview, saveGlobalFailureAnalysisSettings, saveLlmProvider, saveRepositoryFailureAnalysisSettings, saveRepositoryPrReviewSettings, testLlmProvider } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { AiTokenUsage } from "../components/AiTokenUsage.tsx";
import { LlmProviderDefaultApiRoots, type LlmProviderKind } from "@mars/contracts";

const providerTypes = {
  "lm-studio": { label: "LM Studio", kind: "lm-studio", baseUrl: LlmProviderDefaultApiRoots["lm-studio"] },
  ollama: { label: "Ollama", kind: "openai-compatible", baseUrl: LlmProviderDefaultApiRoots["openai-compatible"] },
  "openai-compatible": { label: "OpenAI-compatible", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", kind: "anthropic", baseUrl: LlmProviderDefaultApiRoots.anthropic },
} as const;
type ProviderType = keyof typeof providerTypes;

function providerTypeFor(provider: { kind: LlmProviderKind; baseUrl: string }): ProviderType {
  if (provider.kind !== "openai-compatible") return provider.kind;
  return new URL(provider.baseUrl).port === "11434" ? "ollama" : "openai-compatible";
}

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
    prReview: await getRepositoryPrReviewSettings(organizationId, repository.id),
    latestPrReview: await getLatestPrReview(organizationId, repository.id),
  })));
}

const errorMessage = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
function reviewScope(source: Record<string, unknown>) {
  const rules = source.rules && typeof source.rules === "object" ? source.rules as Record<string, unknown> : {};
  const coverage = source.coverage && typeof source.coverage === "object" ? source.coverage as Record<string, unknown> : {};
  return {
    rules: rules.status ? `${rules.status} · ${rules.path ?? ".mars/pr-rules.md"} · base ${String(rules.baseSha ?? "").slice(0, 12)}${rules.blobSha ? ` · blob ${String(rules.blobSha).slice(0, 12)}` : ""}` : "Not collected",
    coverage: coverage.reviewableFiles !== undefined ? `${coverage.complete ? "Complete" : "Partial"} · ${coverage.reviewableFiles}/${coverage.changedFiles} files` : "Not collected",
    limitations: Array.isArray(coverage.limitations) ? coverage.limitations.join("; ") : "",
  };
}

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
  const globalSettings = useQuery({ queryKey: ["admin", "failure-analysis"], queryFn: getGlobalFailureAnalysisSettings });
  const enableAll = globalSettings.data?.enableAll ?? false;
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
  const [prAcknowledged, setPrAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelLookupRevision, setModelLookupRevision] = useState(0);
  const effectiveBaseUrl = baseUrl.trim() || defaultBaseUrl;
  const localProvider = providerType === "lm-studio" || providerType === "ollama";
  useEffect(() => {
    setAvailableModels([]); setModelsError(null); setModelsLoading(false);
    if (!formOpen || kind === "anthropic") return;
    const controller = new AbortController();
    setModelsLoading(true);
    const timer = setTimeout(() => {
      void getLlmProviderModels({ kind, baseUrl: effectiveBaseUrl, ...(editingId ? { providerId: editingId } : {}), ...(apiKey ? { apiKey } : clearKey ? { apiKey: null } : {}) }, controller.signal)
        .then(({ models }) => { if (!controller.signal.aborted) setAvailableModels(models); })
        .catch((reason) => { if (!controller.signal.aborted) setModelsError(errorMessage(reason, "Unable to list models. Enter a model ID manually.")); })
        .finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [formOpen, providerType, kind, effectiveBaseUrl, apiKey, clearKey, editingId, modelLookupRevision]);
  const providerRows = providers.data ?? [];
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["admin", "llm-providers"] });
    void client.invalidateQueries({ queryKey: ["admin", "failure-analysis"] });
    void Promise.all(organizations.map((organization) => client.invalidateQueries({ queryKey: ["failure-analysis-settings", organization.id] })));
    void Promise.all(organizations.map((organization) => client.invalidateQueries({ queryKey: ["pr-review-settings", organization.id] })));
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
  const updatePrReview = useMutation({
    mutationFn: ({ organizationId, repositoryId, enabled, providerId }: { organizationId: string; repositoryId: string; enabled: boolean; providerId: string | null }) => saveRepositoryPrReviewSettings(organizationId, repositoryId, { enabled, providerId }),
    onSuccess: invalidate,
    onError: (reason) => setError(errorMessage(reason, "Unable to save pull request review settings.")),
  });
  const repositoryRows = repositories.flatMap((query, index) => (query.data ?? []).map((row) => ({ ...row, organizationId: organizations[index].id, workspace: organizations[index].login, latestScope: row.latestPrReview ? reviewScope(row.latestPrReview.source) : null })));
  const selectedProviderIds = new Set(repositoryRows.map(({ settings }) => settings.providerId));
  const sharedProviderId = globalSettings.data?.providerId ?? (selectedProviderIds.size === 1 ? [...selectedProviderIds][0] ?? "" : "");
  const updateRepositories = useMutation({
    mutationFn: async ({ providerId }: { providerId: string }) => {
      await saveGlobalFailureAnalysisSettings({ enableAll, providerId });
      const results = await Promise.allSettled(repositoryRows.map(({ repository, settings, organizationId }) =>
        saveRepositoryFailureAnalysisSettings(organizationId, repository.id, { providerId, enabled: settings.enabled })));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new Error(`${failures.length} repository updates failed. Some changes may have saved; retry to apply the same provider to all repositories.`);
    },
    onSettled: invalidate,
    onError: (reason) => setError(errorMessage(reason, "Unable to update repositories.")),
  });
  const updateGlobalSetting = useMutation({
    mutationFn: (enabled: boolean) => saveGlobalFailureAnalysisSettings({ enableAll: enabled, providerId: sharedProviderId || null }),
    onSuccess: invalidate,
    onError: (reason) => setError(errorMessage(reason, "Unable to save Enable all.")),
  });
  const accessBlocked = updateSetting.isPending || updateRepositories.isPending || updateGlobalSetting.isPending || globalSettings.isFetching || !!globalSettings.error || providers.isFetching || !!providers.error || organizationsQuery.isFetching || !!organizationsQuery.error || repositories.some((query) => query.isFetching || !!query.error);
  const providerReady = !!sharedProviderId && providerRows.some((provider) => provider.id === sharedProviderId);
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
        {test.variables === provider.id && test.isSuccess && <p role="status" className="ai-success">Model verified: generated and validated a test analysis.</p>}
        {test.variables === provider.id && test.isPending && <p role="status" className="form-help">{provider.kind === "lm-studio" ? "Checking the model, loading it if needed, then generating a test analysis…" : "Generating a test analysis…"}</p>}
        <div className="settings-actions"><button className="button secondary" type="button" disabled={saving} onClick={() => { test.reset(); setEditingId(provider.id); setName(provider.name); setProviderType(providerTypeFor(provider)); setBaseUrl(provider.baseUrl); setModel(provider.model); setApiKey(""); setInputPrice(provider.inputUsdPerMillionTokens == null ? "" : String(provider.inputUsdPerMillionTokens)); setOutputPrice(provider.outputUsdPerMillionTokens == null ? "" : String(provider.outputUsdPerMillionTokens)); setClearKey(false); setFormOpen(true); }}>Edit</button><button className="button secondary" type="button" onClick={() => { setError(null); test.mutate(provider.id); }} disabled={test.isPending || saving}>{test.isPending && test.variables === provider.id ? "Testing model…" : "Test model"}</button><button className="button secondary" type="button" onClick={() => { setError(null); remove.mutate(provider.id); }} disabled={remove.isPending || saving}>Delete</button></div>
      </article>)}</div>
      {formOpen && <form onSubmit={submit} className="ai-provider-form" aria-labelledby="ai-provider-form-title">
        <h3 id="ai-provider-form-title">{editingId ? "Edit provider" : "Add provider"}</h3>
        <div className="ai-form-grid">
          <label>Profile name<input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Local development" /></label>
          <label>Provider type<select value={providerType} onChange={(event) => { setProviderType(event.target.value as ProviderType); setBaseUrl(""); setModel(""); setApiKey(""); setInputPrice(""); setOutputPrice(""); setClearKey(!!editingId); }}>{Object.entries(providerTypes).map(([value, provider]) => <option key={value} value={value}>{provider.label}</option>)}</select></label>
          <label>API root<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={defaultBaseUrl} /><span className="form-help">Leave blank to use {defaultBaseUrl}.</span></label>
          {(kind === "anthropic" || availableModels.length === 0) && <label>Model ID<input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="Enter a model ID" /></label>}
          <label className="ai-form-wide">API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); }} placeholder={editingId ? "Leave blank to keep current key" : kind === "anthropic" ? "Required for Anthropic" : "Optional for local servers"} /></label>
          {!localProvider && <>
            <label>Input price (USD / million tokens)<input type="number" min="0" step="any" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} placeholder="Leave blank if unknown" /></label>
            <label>Output price (USD / million tokens)<input type="number" min="0" step="any" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} placeholder="Leave blank if unknown" /></label>
          </>}
        </div>
        {kind !== "anthropic" && <div className="ai-model-lookup">
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
        {providerType === "lm-studio" && <p className="form-help">MARS checks loaded instances and loads this downloaded model before each analysis. JIT loading is not required. Save the provider, then use Test model to verify loading and generation. Requires LM Studio’s /api/v1 model-management API.</p>}
        {effectiveBaseUrl.startsWith("http://") && <p className="ai-warning">Warning: HTTP traffic is not encrypted.</p>}
        {editingId && <label className="ai-checkbox"><input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); setApiKey(""); }} />Clear configured API key</label>}
        <div className="settings-actions"><button className="button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save provider"}</button><button className="button secondary" type="button" disabled={saving} onClick={resetForm}>Cancel</button></div>
      </form>}
    </section>
    <section className="ai-section" aria-labelledby="ai-repositories-title">
      <div><p className="eyebrow">02 / Enable</p><h2 id="ai-repositories-title">Repository access</h2><p className="form-help">All repositories use the same provider and model. Only newly completed failures are analyzed; successful runs are unchanged.</p></div>
      <div className="settings-actions">
        <label className="ai-provider-select">Analysis provider for all repositories<select value={sharedProviderId} disabled={accessBlocked} onChange={(event) => { setError(null); setAcknowledged(false); updateRepositories.mutate({ providerId: event.target.value }); }}><option value="" disabled>Select profile</option>{providerRows.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} — {provider.model}</option>)}</select></label>
        <label className="ai-checkbox"><input type="checkbox" checked={enableAll} disabled={accessBlocked || (!enableAll && (!providerReady || !acknowledged))} onChange={(event) => { setError(null); updateGlobalSetting.mutate(event.target.checked); }} />Enable all</label>
      </div>
      {selectedProviderIds.size > 1 && <p className="ai-warning">Repositories currently use different providers. Select one profile to apply it to all repositories.</p>}
      <label className="ai-checkbox ai-consent"><input type="checkbox" checked={acknowledged} disabled={accessBlocked || !providerReady} onChange={(event) => setAcknowledged(event.target.checked)} />I acknowledge failed log excerpts will be sent to the selected endpoint and generated feedback posted on associated pull requests.</label>
      <div className="ai-warning"><strong>Pull request review is a separate opt-in.</strong> When enabled for a repository, source code and PR metadata—including private-repository content and changes originating from forks—are sent to that repository’s selected provider profile. Enabling is prospective: existing PRs are not backfilled; the next eligible PR event triggers review. MARS publishes advisory COMMENT reviews only; it never commits, pushes, applies suggestions, merges, or blocks CI.</div>
      <label className="ai-checkbox ai-consent"><input type="checkbox" checked={prAcknowledged} disabled={accessBlocked || !providerRows.length} onChange={(event) => setPrAcknowledged(event.target.checked)} />I acknowledge source code and PR metadata, including private repositories and fork changes, will be sent to the selected PR review provider.</label>
      <QueryState isLoading={globalSettings.isLoading} error={globalSettings.error} retry={() => void globalSettings.refetch()} operationLabel="Enable all settings" />
      <p className="form-help">PR review has its own opt-in and provider profile for each repository; CI failure-analysis settings do not enable it.</p>
      <QueryState isLoading={organizationsQuery.isLoading} error={organizationsQuery.error} retry={() => void organizationsQuery.refetch()} operationLabel="workspaces" />
      {!organizationsQuery.isLoading && !organizationsQuery.error && organizations.length === 0 && <p className="ai-empty">No accessible workspaces. Connect a GitHub installation in Settings first.</p>}
      {repositories.map((query, index) => <QueryState key={organizations[index].id} isLoading={query.isLoading} error={query.error} retry={() => void query.refetch()} operationLabel={`${organizations[index].login} repositories`} />)}
      <div className="ai-repository-table-wrap"><table className="ai-repository-table">
        <thead><tr><th scope="col">Repository</th><th scope="col">Workspace</th><th scope="col">Status</th><th scope="col">Analysis</th><th scope="col">PR review</th><th scope="col">Latest PR review</th></tr></thead>
        <tbody>{repositoryRows.map(({ repository, settings, prReview, latestPrReview, latestScope, organizationId, workspace }) => <tr key={`${organizationId}:${repository.id}`}>
          <th scope="row">{repository.fullName ?? repository.name}</th>
          <td>{workspace}</td>
          <td>{repository.available ? enableAll ? "Enabled by Enable all" : settings.enabled ? "Enabled" : "Disabled" : "Unavailable"}</td>
          <td><label className="ai-checkbox"><input type="checkbox" checked={settings.enabled} disabled={accessBlocked || (!settings.enabled && (!repository.available || !providerReady || !acknowledged))} onChange={(event) => { setError(null); updateSetting.mutate({ organizationId, repositoryId: repository.id, enabled: event.target.checked, providerId: settings.enabled ? settings.providerId : sharedProviderId }); }} /><span className="sr-only">Enable analysis for {repository.fullName ?? repository.name}</span></label></td>
          <td><label className="ai-checkbox"><input type="checkbox" checked={prReview.enabled} disabled={accessBlocked || updatePrReview.isPending || (!prReview.enabled && (!repository.available || !providerRows.length || !prAcknowledged))} onChange={(event) => { setError(null); updatePrReview.mutate({ organizationId, repositoryId: repository.id, enabled: event.target.checked, providerId: prReview.providerId ?? providerRows[0]?.id ?? null }); }} /><span className="sr-only">Enable pull request review for {repository.fullName ?? repository.name}</span></label><label className="ai-provider-select">Provider<select value={prReview.providerId ?? ""} disabled={accessBlocked || updatePrReview.isPending} onChange={(event) => { setPrAcknowledged(false); updatePrReview.mutate({ organizationId, repositoryId: repository.id, enabled: prReview.enabled, providerId: event.target.value || null }); }}><option value="">Select profile</option>{providerRows.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} — {provider.model}</option>)}</select></label></td>
          <td>{latestPrReview ? <><strong>PR #{latestPrReview.prNumber}</strong> · {latestPrReview.analysisState} / {latestPrReview.publicationState}<br />Revision <code>{latestPrReview.headSha.slice(0, 12)}</code><br />Rules: {latestScope?.rules} · <span title={latestScope?.limitations}>Coverage: {latestScope?.coverage}</span><br />Usage: {latestPrReview.inputTokens ?? "?"} in / {latestPrReview.outputTokens ?? "?"} out · ${latestPrReview.estimatedCostUsd?.toFixed(6) ?? "unknown"}<br />{latestPrReview.errorCode && <span role="alert">Error: {latestPrReview.errorCode}<br /></span>}{latestPrReview.reviewUrl && <a href={latestPrReview.reviewUrl} target="_blank" rel="noreferrer">View GitHub review</a>}</> : "No reviews yet"}</td>
        </tr>)}</tbody>
      </table></div>
      {!accessBlocked && organizations.length > 0 && repositoryRows.length === 0 && <p className="form-help">No repositories available.</p>}
      <p className="form-help">Enable all overrides individual selections for every available repository, including newly discovered repositories. It does not change their checkboxes. Turn it off to use the individual selections again.</p>
    </section>
    <AiTokenUsage />
  </div>;
}
