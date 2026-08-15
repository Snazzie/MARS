import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { beginOnboardingGithubInstall, beginOnboardingGithubManifest, createOnboardingPool, getOnboardingDetail, getOnboardingStatus, rejectPendingWorker, selectOnboardingWorker } from "../api.ts";
import { EnrollmentPanel } from "../components/EnrollmentPanel.tsx";
import { pendingWorkerQueryOptions } from "../components/PendingWorkerRequests.tsx";
import { RunnerWorkflowPrModal } from "../components/RunnerWorkflowPrModal.tsx";
import { WorkerConfigurationForm } from "../components/WorkerConfigurationForm.tsx";
import type { CreatePoolRequest, OnboardingDetail, OnboardingStatus } from "@whitesmith/contracts";

const steps = [["admin", "Admin"], ["worker", "Worker"], ["github", "GitHub"], ["labels", "Trigger labels"]] as const;
const gib = (bytes: number) => Math.max(1, Math.round(bytes / 1024 ** 3));

export function OnboardingPage() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["onboarding-status"], queryFn: getOnboardingStatus, staleTime: 1000 });
  const s = status.data as OnboardingStatus | undefined;
  const detail = useQuery({ queryKey: ["onboarding"], queryFn: getOnboardingDetail, enabled: Boolean(s?.authenticated && s.canManage), refetchInterval: s?.step === "worker" ? 2000 : false });
  const [error, setError] = useState<string | null>(null);
  const [viewStep, setViewStep] = useState<number | null>(null);
  const refresh = () => { void client.invalidateQueries({ queryKey: ["onboarding"] }); void client.invalidateQueries({ queryKey: ["onboarding-status"] }); };
  const select = useMutation({ mutationFn: selectOnboardingWorker, onSuccess: refresh, onError: (e) => setError(e instanceof Error ? e.message : "Worker selection failed") });
  const pool = useMutation({ mutationFn: createOnboardingPool, onSuccess: refresh, onError: (e) => setError(e instanceof Error ? e.message : "Pool creation failed") });
  if (status.isLoading) return <main className="onboarding"><p>Loading onboarding…</p></main>;
  if (status.error || !s) return <main className="onboarding"><h1>Onboarding unavailable</h1><p role="alert">{status.error instanceof Error ? status.error.message : "Could not load onboarding."}</p><button onClick={() => void status.refetch()}>Retry</button></main>;
  if (!s.authenticated) return <SignIn firstAdmin={!s.adminCreated} />;
  if (!s.canManage) return <main className="onboarding"><section className="onboarding-card"><h1>Administrator access required</h1><p>Your GitHub account is signed in, but it cannot configure this control plane.</p></section></main>;
  const d = detail.data;
  if (!d) return <main className="onboarding"><p>Loading setup details…</p></main>;
  if (d.step === "complete") return <Complete detail={d} />;
  const currentIndex = steps.findIndex(([id]) => id === d.step);
  const activeStep = viewStep ?? currentIndex;
  const viewingPastStep = activeStep < currentIndex;
  return <main className="onboarding"><header><p className="eyebrow">FIRST-RUN SETUP</p><h1>Get Whitesmith ready</h1><p>Complete each verified step. Progress is saved on the control plane.</p></header>{error && <p role="alert" className="form-error">{error} <button onClick={() => setError(null)}>Dismiss</button></p>}<div className="onboarding-layout"><nav aria-label="Onboarding steps"><ol className="onboarding-steps">{steps.map(([id, label], index) => <li key={id} className={index === activeStep ? "is-current" : index < currentIndex ? "is-complete" : "is-locked"}><span>{index + 1}</span><strong>{label}</strong></li>)}</ol></nav><section className="onboarding-task" aria-live="polite"><h2>{steps[activeStep]?.[1]}</h2>{activeStep === 0 ? <p>Administrator account is configured.</p> : <EditableStep detail={d} index={activeStep} onDone={() => { refresh(); setViewStep(null); }} onDiscard={() => { refresh(); setViewStep(null); }} onSelect={(id) => select.mutate({ workerId: id })} onCreate={(input) => pool.mutate({ ...input, organizationId: d.github.organizationId ?? "" })} />}{activeStep > 0 && <div className="onboarding-navigation"><button type="button" onClick={() => setViewStep(Math.max(0, activeStep - 1))} disabled={activeStep === 0}>Back</button><button type="button" onClick={() => setViewStep(Math.min(currentIndex, activeStep + 1))} disabled={!viewingPastStep}>Next</button></div>}</section></div></main>;
}
function EditableStep({ detail, index, onDone, onDiscard, onSelect, onCreate }: { detail: OnboardingDetail; index: number; onDone: () => void; onDiscard: () => void; onSelect: (id: string) => void; onCreate: (input: CreatePoolRequest) => void }) {
  if (index === 1) return <WorkerSetupStep detail={detail} edit onSelect={onSelect} onDone={onDone} onDiscard={onDiscard} />;
  if (index === 2) return <GithubStep detail={detail} edit />;
  if (index === 3) return <LabelsStep detail={detail} edit onCreate={onCreate} />;
  return <p>Administrator account is configured.</p>;
}
function ResourceStep({ detail, onDone, onDiscard, edit = false }: { detail: OnboardingDetail; onDone: () => void; onDiscard?: () => void; edit?: boolean }) { const w = detail.worker; if (!w) return <p>Select a worker first.</p>; return <><h3>Configure resources</h3>{w.configurationState === "ready" && !edit ? <p role="status">Configuring worker complete. Waiting for server progress…</p> : <WorkerConfigurationForm worker={w} onConfigured={onDone} onDiscard={onDiscard} />}</>; }

function SignIn({ firstAdmin }: { firstAdmin: boolean }) { return <main className="onboarding"><section className="onboarding-card onboarding-sign-in"><p className="eyebrow">{firstAdmin ? "WELCOME TO WHITESMITH" : "WELCOME BACK"}</p><h1>{firstAdmin ? "Create your administrator account" : "Sign in to Whitesmith"}</h1><p>Use GitHub to verify your identity and securely manage this control plane.</p><a className="button" href="/api/auth/github">{firstAdmin ? "Continue with GitHub" : "Continue with GitHub"}</a><p>{firstAdmin ? "Create administrator with GitHub" : "Sign in with GitHub"}</p><p><strong>GitHub identity</strong><br />Only your GitHub identity is used for administrator access.</p><p className="security-note">Security note: setup data is shown only after your session is authorized.</p></section></main>; }
function ReviewSummary({ detail, through, onClose }: { detail: OnboardingDetail; through: number; onClose?: () => void }) {
  const org = detail.organizations.find((item) => item.id === detail.github.organizationId);
  return <aside className="onboarding-review">
    {onClose && <button type="button" onClick={onClose}>Back to current step</button>}
    <h3>Completed setup</h3>
    {through >= 2 && detail.worker && <p>Worker enrollment<br />Worker: {detail.worker.name ?? detail.worker.vmUuid}</p>}
    {through >= 3 && detail.github.organizationId && <p>GitHub account: {org?.name ?? detail.github.organizationId}<br />Available repositories: {detail.github.repositories.filter((repository) => repository.available).length}</p>}
  </aside>;
}
function WorkerStep({ onSelect }: { onSelect: (id: string) => void }) {
  const q = useQuery(pendingWorkerQueryOptions());
  const discard = useMutation({ mutationFn: rejectPendingWorker, onSuccess: () => void q.refetch() });
  return <div><EnrollmentPanel workers={q.data ?? []} onConnected={() => void q.refetch()} showRotation={false} /><p>Choose the worker you verified. It remains unschedulable until resources are configured.</p>{q.error && <p role="alert">{q.error instanceof Error ? q.error.message : "Could not load workers."} <button type="button" onClick={() => void q.refetch()}>Retry</button></p>}{discard.error && <p role="alert">{discard.error instanceof Error ? discard.error.message : "Could not discard the pending worker."}</p>}{(q.data ?? []).map((w) => <article className="worker-choice" key={w.id}><h3>{w.vmUuid}</h3><p>{w.platform} · {w.connectionState}</p><p>Fingerprint: <code>{w.fingerprint}</code></p><button type="button" onClick={() => onSelect(w.id)}>Use this worker</button><button type="button" onClick={() => { if (window.confirm("Discard this pending worker and generate a new installation?")) discard.mutate(w.id); }} disabled={discard.isPending}>Discard and reinstall</button></article>)}</div>;
}
function submitGithubManifest(launch: { action: string; manifest: string }): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = launch.action;
  form.hidden = true;
  const manifest = document.createElement("input");
  manifest.type = "hidden";
  manifest.name = "manifest";
  manifest.value = launch.manifest;
  form.append(manifest);
  document.body.append(form);
  form.submit();
}
function GithubStep({ detail, edit = false }: { detail: OnboardingDetail; edit?: boolean }) {
  const [organizationId, setOrganizationId] = useState(detail.github.organizationId ?? "");
  const [connectError, setConnectError] = useState<string | null>(null);
  const availableRepositories = detail.github.repositories.filter((repository) => repository.available);
  const hasUsableInstallation = !edit && Boolean(detail.github.installation && availableRepositories.length > 0);
  const selectionRemediation = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("github") === "repository-selection-required";
  const connect = async () => {
    if (!organizationId) return;
    setConnectError(null);
    try {
      if (detail.github.appConfigured) {
        const result = await beginOnboardingGithubInstall({ organizationId });
        window.location.assign(result.location);
      } else {
        submitGithubManifest(await beginOnboardingGithubManifest({ organizationId }));
      }
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause.message : "GitHub App setup failed");
    }
  };
  return <div>
    <h3>Connect GitHub account</h3>
    {!hasUsableInstallation && <>
      <p>Choose the GitHub account where Whitesmith should run jobs. These are accounts available to your signed-in GitHub user, not existing Whitesmith App installations.</p>
      {!detail.github.appConfigured && <p>Whitesmith will create a GitHub App for this control plane before installing it in the selected account.</p>}
      <label>GitHub account
        <select aria-label="GitHub account" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
          <option value="">Select account</option>
          {detail.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.login}</option>)}
        </select>
      </label>
      <button type="button" disabled={!organizationId} onClick={() => void connect()}>{detail.github.appConfigured ? "Install Whitesmith GitHub App" : "Create Whitesmith GitHub App"}</button>
      {connectError && <p role="alert" className="form-error">{connectError}</p>}
    </>}
    {selectionRemediation && <p role="alert">No available repositories were returned. Update the GitHub App installation access and reconnect.</p>}
    {hasUsableInstallation && <p role="status">GitHub installation connected. Whitesmith can schedule jobs from {availableRepositories.length} available {availableRepositories.length === 1 ? "repository" : "repositories"}.</p>}
  </div>;
}
function WorkerSetupStep({ detail, onSelect, onDone, onDiscard, edit = false }: { detail: OnboardingDetail; onSelect: (id: string) => void; onDone: () => void; onDiscard?: () => void; edit?: boolean }) {
  const discard = useMutation({ mutationFn: rejectPendingWorker, onSuccess: () => onDiscard?.() });
  if (!detail.worker) return <WorkerStep onSelect={onSelect} />;
  return <div><h3>Worker enrollment</h3><p>Selected worker: {detail.worker.name ?? detail.worker.vmUuid}</p>{detail.worker.admissionState === "pending" && onDiscard && <button type="button" onClick={() => { if (window.confirm("Discard this pending worker and generate a new installation?")) discard.mutate(detail.worker!.id); }} disabled={discard.isPending}>Discard and reinstall</button>}{discard.error && <p role="alert">{discard.error instanceof Error ? discard.error.message : "Could not discard the pending worker."}</p>}<ResourceStep detail={detail} onDone={onDone} onDiscard={onDiscard} edit={edit} /></div>;
}
const canonicalRunnerLabel = (platform: "linux-x64" | "windows-x64" | "macos-arm64") => `whitesmith-${platform}`;
function LabelsStep({ detail, onCreate, edit = false }: { detail: OnboardingDetail; onCreate: (input: CreatePoolRequest) => void; edit?: boolean }) {
  const worker = detail.worker;
  const guestPlatforms = worker?.guestPlatforms ?? (worker ? [worker.platform] : []);
  const [guestPlatform, setGuestPlatform] = useState<"linux-x64" | "windows-x64" | "macos-arm64" | null>(detail.pool?.platform ?? null);
  const selectedGuest = guestPlatform ?? guestPlatforms[0] ?? null;
  const [name, setName] = useState(detail.pool?.name ?? "default");
  const [label, setLabel] = useState(detail.pool?.triggerLabel ?? canonicalRunnerLabel(selectedGuest ?? "linux-x64"));
  const digest = selectedGuest ? (detail.defaultImageDigests ?? {})[selectedGuest] ?? detail.defaultImageDigest ?? null : null;
  if (!worker || !selectedGuest || !digest) return <p role="alert">No immutable job image is configured for this guest platform.</p>;
  if (!worker.limits) return <div><p role="alert">Worker resource limits are not acknowledged yet. Return to Configure resources before creating a pool.</p><p>Configuring worker · resources in GiB</p><p>Trigger label: {label}</p><pre>runs-on: {label}</pre></div>;
  const resources = { vcpu: worker.limits.maxVcpuPerPod, memoryBytes: worker.limits.maxMemoryBytesPerPod, storageBytes: worker.limits.maxStorageBytesPerPod, concurrency: worker.limits.maxConcurrentPods };
  return <form onSubmit={(e) => { e.preventDefault(); onCreate({ poolId: edit ? detail.pool?.id : undefined, workerId: worker.id, guestPlatform: selectedGuest, name, triggerLabel: label, imageDigest: digest, resources }); }}>
    <p>Configuring worker acknowledged. Resources are acknowledged; configure resources in GiB before creating the first enabled pool.</p>
    {guestPlatforms.length > 1 && <label>Guest platform<select value={selectedGuest} onChange={(e) => { const platform = e.target.value as typeof selectedGuest; setGuestPlatform(platform); if (platform) setLabel(canonicalRunnerLabel(platform)); }}>{guestPlatforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label>}
    <label>Pool name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label>Trigger label<input value={label} onChange={(e) => setLabel(e.target.value)} pattern="[a-z0-9][a-z0-9._-]{0,62}" /></label>
    <p>Effective label: <code>{label}</code></p>
    <pre>runs-on: {label}</pre>
    <button type="submit">Create pool</button>
  </form>;
}
function Complete({ detail }: { detail: OnboardingDetail }) { const [runnerRepository, setRunnerRepository] = useState<OnboardingDetail["github"]["repositories"][number] | null>(null); const available = detail.github.repositories.find((repository) => repository.available); const org = detail.organizations.find((o) => o.id === detail.github.organizationId); return <main className="onboarding"><section className="onboarding-card"><h1>Onboarding complete</h1><p>Organization: {org?.name ?? detail.github.organizationId}</p><p>Available repositories: {detail.github.repositories.filter((repository) => repository.available).length}</p><p>Worker: {detail.worker?.name ?? "Ready"}</p><p>Pool: {detail.pool?.name ?? "default"}</p><p>Effective labels: {detail.pool?.labels?.join(", ")}</p><pre>runs-on: [{detail.pool?.labels?.join(", ")}]</pre>{available && <button type="button" className="button" onClick={() => setRunnerRepository(available)}>Use Whitesmith runners</button>}<a className="button secondary" href="/">Open dashboard</a></section>{runnerRepository && detail.github.organizationId && <RunnerWorkflowPrModal organizationId={detail.github.organizationId} repositoryId={runnerRepository.id} repositoryName={runnerRepository.fullName} open onClose={() => setRunnerRepository(null)} />}</main>; }
