import { useQueryClient } from "@tanstack/react-query";
import type { PendingWorkerRequestData } from "@mars/contracts";
import { ApiRequestError, getPendingWorkerRequests, isUnauthorized } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";

type PendingRequest = PendingWorkerRequestData & { id: string; fingerprint: string; name?: string };
type Props = { organizationId: string; workers: readonly PendingRequest[]; error: Error | null; isLoading: boolean; retry: () => void };

export function pendingWorkerQueryOptions() {
  return { queryKey: ["pending-workers"], queryFn: getPendingWorkerRequests, refetchInterval: 2000, staleTime: 5000 };
}

export function PendingWorkerRequests({ organizationId, workers, error, isLoading, retry }: Props) {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["pending-workers"] });
    void client.invalidateQueries({ queryKey: ["org", organizationId, "workers"] });
  };
  if (error && isUnauthorized(error)) return <QueryState error={error} isLoading={false} />;
  if (error instanceof ApiRequestError && error.status === 403) return <section className="pending-workers state-view state-error"><h2>Authorization required</h2><p>Only global administrators can review pending workers.</p></section>;
  if (isLoading && workers.length === 0) return <QueryState error={null} isLoading />;
  return <section className="pending-workers" aria-labelledby="pending-workers-title">
    <div><h2 id="pending-workers-title">Workers awaiting approval</h2><p className="pending-note">Review each worker's identity and limits before making it available for scheduling.</p></div>
    {error && <QueryState error={error} isLoading={false} retry={retry} />}
    {workers.length === 0 ? <p className="pending-empty">No workers are waiting for approval.</p> : workers.map((worker) =>
      <article className="pending-worker" key={worker.id}>
        <div className="pending-worker-heading"><div><h3>{worker.name ?? worker.computerName}</h3><p>{worker.platform} · {worker.vmUuid}</p></div><span className="status-pill status-pending">Awaiting approval</span></div>
        <details className="pending-worker-review">
          <summary>Review and approve <span aria-hidden="true">→</span></summary>
          <div className="pending-worker-details">
            <p className="field-help">Verify this identity against the host before approving.</p>
            <dl><div><dt>Fingerprint</dt><dd><code>{worker.fingerprint}</code></dd></div><div><dt>Public key</dt><dd><code>{worker.publicKey}</code></dd></div></dl>
            <WorkerConfigurationForm worker={{ ...worker, selectedDriver: null, capabilities: worker.doctor.capabilities }} onConfigured={refresh} onDiscard={refresh} />
          </div>
        </details>
      </article>)}
  </section>;
}
