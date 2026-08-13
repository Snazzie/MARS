import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { isOffline, isUnauthorized } from "../api.ts";
type StateViewProps = {
  kind: "loading" | "empty" | "error";
  title?: string;
  message?: string;
  action?: ReactNode;
};

export function StateView({ kind, title, message, action }: StateViewProps) {
  const defaults = {
    loading: { title: "Reading control-plane telemetry", message: "Fetching the latest snapshot…" },
    empty: { title: "No records yet", message: "This workspace will come alive when the first resource is connected." },
    error: { title: "The console hit a snag", message: "Try again, or check the control-plane connection." },
  }[kind];

  return (
    <section className={`state-view state-${kind}`} role={kind === "error" ? "alert" : "status"} aria-live="polite">
      <span className="state-mark" aria-hidden="true">{kind === "loading" ? "···" : kind === "empty" ? "∅" : "!"}</span>
      <div>
        <h2>{title ?? defaults.title}</h2>
        <p>{message ?? defaults.message}</p>
        {action}
      </div>
    </section>
  );
}
 
export function WorkspaceRequired() {
  return <StateView kind="empty" title="Select a workspace" message="This view operates on one workspace at a time. Choose a concrete organization from the selector above." />;
}
export function QueryState({ error, isLoading, isEmpty, retry, operationLabel }: { error: unknown; isLoading: boolean; isEmpty?: boolean; retry?: () => void; operationLabel?: string }) {
  const retryLabel = operationLabel ? `Retry ${operationLabel}` : "Retry";
  if (isLoading) return <StateView kind="loading" />;
  if (error && isUnauthorized(error)) return <StateView kind="error" title="Sign-in required" message="Your operator session is no longer valid. Sign in again to continue." action={<Button label="Sign in with GitHub" variant="secondary" href="/api/auth/github" />} />;
  if (error && isOffline(error)) return <StateView kind="error" title="Control plane unreachable" message="Whitesmith could not reach the server. Check your network, then retry." action={<Button label={operationLabel ? `Retry ${operationLabel}` : "Retry connection"} variant="secondary" clickAction={retry} />} />;
  if (error) return <StateView kind="error" title="Unable to load this view" message={error instanceof Error ? error.message : undefined} action={<Button label={retryLabel} variant="secondary" clickAction={retry} />} />;
  if (isEmpty) return <StateView kind="empty" />;
  return null;
}

