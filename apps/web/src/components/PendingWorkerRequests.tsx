import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PendingWorkerRequestData } from "@mars/contracts";
import { ApiRequestError, getPendingWorkerRequests, isUnauthorized, rejectPendingWorker } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";

type PendingRequest = PendingWorkerRequestData & { id: string; fingerprint: string; name?: string };
type Props = { organizationId: string; workers: readonly PendingRequest[]; error: Error | null; isLoading: boolean; retry: () => void };

export function pendingWorkerQueryOptions() {
  return { queryKey: ["pending-workers"], queryFn: getPendingWorkerRequests, refetchInterval: 2000, staleTime: 5000 };
}

export function PendingWorkerRequests({ organizationId, workers, error, isLoading, retry }: Props) {
  const client = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["pending-workers"] });
    void client.invalidateQueries({ queryKey: ["org", organizationId, "workers"] });
  };
  const reject = useMutation({ mutationFn: rejectPendingWorker, onSuccess: refresh, onError: (cause) => setMutationError(cause instanceof Error ? cause.message : "Rejection failed") });
  if (error && isUnauthorized(error)) return <QueryState error={error} isLoading={false} />;
  if (error instanceof ApiRequestError && error.status === 403) return <section className="pending-workers state-view state-error"><h2>Authorization required</h2><p>Only global administrators can review pending workers.</p></section>;
  if (isLoading && workers.length === 0) return <QueryState error={null} isLoading />;
  return <section className="pending-workers" aria-labelledby="pending-workers-title"><div><h2 id="pending-workers-title">Workers awaiting approval</h2><p className="pending-note">Review and configure workers from <strong>All workspaces</strong>. Approval applies the resource limits and makes the worker available for scheduling.</p></div>{error && <QueryState error={error} isLoading={false} retry={retry} />}{mutationError && <p className="form-error" role="alert">{mutationError}</p>}{workers.length === 0 ? <p className="pending-empty">No workers are waiting for approval.</p> : workers.map((worker) => <article className="pending-worker" key={worker.id}><h3>{worker.name ?? worker.vmUuid}</h3><p>{worker.platform} · {worker.fingerprint}</p><p><strong>Public key</strong><br /><code>{worker.publicKey}</code></p><WorkerConfigurationForm worker={worker} onConfigured={refresh} /><button type="button" disabled={reject.isPending} onClick={() => reject.mutate(worker.id)}>Reject worker</button></article>)}</section>;
}
