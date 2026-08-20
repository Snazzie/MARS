import { useState, type FormEvent } from "react";
import { buildWorkerImage } from "../api.ts";

const defaultDockerfile = "FROM mcr.microsoft.com/windows/servercore:ltsc2025\n\nSHELL [\"powershell.exe\", \"-NoLogo\", \"-NoProfile\", \"-NonInteractive\", \"-Command\"]\n";

export function WorkerImageBuildForm({ organizationId, workerId, onComplete, onCancel }: { organizationId: string; workerId: string; onComplete: () => void; onCancel: () => void }) {
  const [dockerfile, setDockerfile] = useState(defaultDockerfile);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true); setError(null);
    try {
      await buildWorkerImage(organizationId, workerId, { image: "whitesmith/windows-job:local", dockerfile, contextFiles: [] });
      onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Image build could not be started.");
    } finally { setPending(false); }
  }
  return <form className="worker-build-form" onSubmit={submit}>
    <p className="panel-kicker">Worker-local runtime image</p>
    <h2>Build the Windows image</h2>
    <p className="muted">The control plane sends this declarative Dockerfile to the worker. Docker build and runtime verification happen locally on the worker.</p>
    <label>Dockerfile<textarea value={dockerfile} onChange={(event) => setDockerfile(event.target.value)} rows={12} required maxLength={256 * 1024} spellCheck={false} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="control-button control-button-secondary" onClick={onCancel} disabled={pending}>Cancel</button><button type="submit" className="control-button" disabled={pending}>{pending ? "Starting build…" : "Build on worker"}</button></div>
  </form>;
}
