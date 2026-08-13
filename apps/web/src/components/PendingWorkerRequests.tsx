import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PendingWorkerRequestData } from "@whitesmith/contracts";
import { ApiRequestError, getPendingWorkerRequests, isUnauthorized, rejectPendingWorker } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";

type Props = { organizationId: string };
type PendingRequest = PendingWorkerRequestData & { id: string; fingerprint: string; name?: string };

export function pendingWorkerQueryOptions() {
  return { queryKey: ["pending-workers"], queryFn: getPendingWorkerRequests, refetchInterval: 2000, staleTime: 5000 };
}

export function PendingWorkerRequests({ organizationId }: Props) {
  const client = useQueryClient();
  const query = useQuery(pendingWorkerQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["pending-workers"] });
    void client.invalidateQueries({ queryKey: ["org", organizationId, "workers"] });
  };
  const reject = useMutation({ mutationFn: rejectPendingWorker, onSuccess: refresh, onError: (cause) => setError(cause instanceof Error ? cause.message : "Rejection failed") });
  if (query.error && isUnauthorized(query.error)) return <QueryState error={query.error} isLoading={false} />;
  if (query.error && query.error instanceof ApiRequestError && query.error.status === 403) return <section className="pending-workers state-view state-error"><h2>Authorization required</h2><p>Only global administrators can review pending workers.</p></section>;
  if (query.isLoading) return <QueryState error={null} isLoading />;
  if (query.error) return <QueryState error={query.error} isLoading={false} retry={() => void query.refetch()} />;
  const workers = (query.data ?? []) as PendingRequest[];
  return <section className="pending-workers" aria-labelledby="pending-workers-title"><div><h2 id="pending-workers-title">Workers awaiting approval</h2><p className="pending-note">Review and configure workers from <strong>All workspaces</strong>. Approval applies the resource limits and makes the worker available for scheduling.</p></div>{error && <p className="form-error" role="alert">{error}</p>}{workers.length === 0 ? <p className="pending-empty">No workers are waiting for approval.</p> : workers.map((worker) => <article className="pending-worker" key={worker.id}><h3>{worker.name ?? worker.vmUuid}</h3><p>{worker.platform} · {worker.fingerprint}</p><p><strong>Public key</strong><br /><code>{worker.publicKey}</code></p><WorkerConfigurationForm worker={worker} onConfigured={refresh} /><button className="control-button control-button-secondary" type="button" onClick={() => reject.mutate(worker.id)} disabled={reject.isPending}>{reject.isPending ? "Rejecting…" : "Reject worker"}</button></article>)}</section>;
}
