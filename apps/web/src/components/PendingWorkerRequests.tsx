import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApproveWorkerRequest, type ApproveWorkerRequestData, type PendingWorkerRequestData } from "@whitesmith/contracts";
import { approvePendingWorker, ApiRequestError, getPendingWorkerRequests, isUnauthorized, rejectPendingWorker } from "../api.ts";
import { QueryState } from "./StateView.tsx";

type Props = { organizationId: string };
type PendingRequest = PendingWorkerRequestData & { id: string; fingerprint: string };
type Limits = ApproveWorkerRequestData["limits"];
function limitFields(limits: Limits) {
  return Object.entries(limits).map(([name, value]) => <label key={name}>{name}<input name={name} type="number" min="1" step="1" defaultValue={value} required /></label>);
}

export function PendingWorkerRequests({ organizationId }: Props) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["pending-workers"], queryFn: getPendingWorkerRequests, staleTime: 5_000 });
  const [actionError, setActionError] = useState<string | null>(null);
  const refresh = () => { void client.invalidateQueries({ queryKey: ["pending-workers"] }); void client.invalidateQueries({ queryKey: ["org", organizationId, "workers"] }); };
  const approve = useMutation({ mutationFn: ({ workerId, limits }: { workerId: string; limits: Limits }) => approvePendingWorker(workerId, { organizationId, limits }), onSuccess: refresh, onError: (error) => setActionError(error instanceof Error ? error.message : "Approval failed") });
  const reject = useMutation({ mutationFn: rejectPendingWorker, onSuccess: refresh, onError: (error) => setActionError(error instanceof Error ? error.message : "Rejection failed") });
  if (query.error && isUnauthorized(query.error)) return <QueryState error={query.error} isLoading={false} />;
  if (query.error && query.error instanceof ApiRequestError && query.error.status === 403) return <section className="pending-workers state-view state-error"><h2>Authorization required</h2><p>Only global administrators can review pending workers.</p></section>;
  if (query.isLoading) return <QueryState error={null} isLoading />;
  if (query.error) return <QueryState error={query.error} isLoading={false} retry={() => void query.refetch()} />;
  const requests = query.data ?? [];
  return <section className="pending-workers" aria-labelledby="pending-workers-title">
    <h2 id="pending-workers-title">Pending worker requests</h2>
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {requests.length === 0 ? <p className="pending-empty">No pending worker requests</p> : requests.map((worker: PendingRequest) => <article className="pending-worker-card" key={worker.id}>
      <header><h3>{worker.platform}</h3><p>Fingerprint <code>{worker.fingerprint}</code> <button type="button" onClick={() => void navigator.clipboard?.writeText(worker.fingerprint)}>Copy</button></p></header>
      <dl><div key="public-key"><dt>Public key</dt><dd><code>{worker.publicKey}</code></dd></div><div key="vm-uuid"><dt>VM UUID</dt><dd>{worker.vmUuid}</dd></div><div key="machine-uuid"><dt>Machine UUID</dt><dd>{worker.machineUuid}</dd></div><div key="capacity"><dt>Reported capacity</dt><dd>{worker.capacity.actualVcpu} vCPU · {worker.capacity.actualMemoryBytes} bytes RAM · {worker.capacity.actualStorageBytes} bytes storage</dd></div></dl>
      <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const limits = Object.fromEntries(["maxVcpuPerPod", "maxMemoryBytesPerPod", "maxStorageBytesPerPod", "maxConcurrentPods"].map((name) => [name, Number(form.get(name))])) as Limits; const parsed = ApproveWorkerRequest.safeParse({ organizationId, limits }); if (!parsed.success || Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) { setActionError("Limits must be positive safe integers."); return; } if (limits.maxVcpuPerPod > worker.capacity.actualVcpu || limits.maxMemoryBytesPerPod > worker.capacity.actualMemoryBytes || limits.maxStorageBytesPerPod > worker.capacity.actualStorageBytes) { setActionError("Limits cannot exceed reported worker capacity."); return; } setActionError(null); approve.mutate({ workerId: worker.id, limits }); }}>
        <p className="form-help">Organization target: <code>{organizationId}</code></p>
        <div className="limit-grid">{limitFields(worker.limits)}</div>
        <button type="submit" disabled={approve.isPending}>Approve</button>
        <button type="button" disabled={reject.isPending} onClick={() => reject.mutate(worker.id)}>Reject</button>
</form>
    </article>)}
  </section>;
}
