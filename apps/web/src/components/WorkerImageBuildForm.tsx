import { useState, type FormEvent } from "react";
import { buildWorkerImage } from "../api.ts";


export function WorkerImageBuildForm({ organizationId, workerId, onComplete, onCancel }: { organizationId: string; workerId: string; onComplete: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true); setError(null);
    try {
      await buildWorkerImage(workerId, { image: "mars/windows-job:local" });
      onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Image build could not be started.");
    } finally { setPending(false); }
  }
  return <form className="worker-build-form" onSubmit={submit}>
    <p className="panel-kicker">Worker-local runtime image</p>
    <h2>Build the Windows image</h2>
    <p className="muted">The control plane sends the release-pinned Containerfile, entrypoint, verifier, and job agent to the worker with SHA-256 integrity metadata. Docker build and runtime verification happen locally on the worker.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="control-button control-button-secondary" onClick={onCancel} disabled={pending}>Cancel</button><button type="submit" className="control-button" disabled={pending}>{pending ? "Starting build…" : "Build on worker"}</button></div>
  </form>;
}
