import { useEffect, useState, type FormEvent } from "react";
import { buildWorkerImage } from "../api.ts";

type RuntimeBuildState = "idle" | "building" | "ready" | "failed";

export function WorkerImageBuildForm({ workerId, runtimeBuildState = "idle", runtimeBuildMessage, onRefresh, onCancel }: { organizationId: string; workerId: string; runtimeBuildState?: RuntimeBuildState; runtimeBuildMessage?: string | null; onRefresh: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState(runtimeBuildState === "building");

  useEffect(() => {
    if (!started || runtimeBuildState === "ready" || runtimeBuildState === "failed") return;
    const timer = window.setInterval(onRefresh, 2000);
    return () => window.clearInterval(timer);
  }, [onRefresh, runtimeBuildState, started]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true); setError(null);
    try {
      await buildWorkerImage(workerId, { image: "mars/windows-job:local" });
      setStarted(true);
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Image build could not be started.");
    } finally { setPending(false); }
  }

  const state = started ? runtimeBuildState : "idle";
  const status = state === "ready" ? "Windows image build completed and passed runtime verification." : state === "failed" ? runtimeBuildMessage || "Windows image build failed." : state === "building" ? "Docker is building and verifying the image on the worker. This dialog will update automatically." : "The build has not started.";

  return <form className="worker-build-form" onSubmit={submit}>
    <p className="panel-kicker">Worker-local runtime image</p>
    <h2>Build the Windows image</h2>
    <p className="muted">The control plane sends the release-pinned Containerfile, entrypoint, verifier, and job agent with SHA-256 integrity metadata. Docker build and runtime verification happen locally on the worker.</p>
    <div className={`worker-build-status worker-build-status-${state}`} role="status" aria-live="polite">
      <strong>{state === "ready" ? "Build complete" : state === "failed" ? "Build failed" : state === "building" ? "Build in progress" : "Ready to build"}</strong>
      <p>{status}</p>
    </div>
    {state === "building" && <div className="worker-build-progress" aria-label="Windows image build in progress"><span /></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="control-button control-button-secondary" onClick={onCancel} disabled={pending || state === "building"}>Close</button>{state !== "ready" && state !== "failed" && <button type="submit" className="control-button" disabled={pending || state === "building"}>{pending ? "Starting build…" : "Build on worker"}</button>}</div>
  </form>;
}
