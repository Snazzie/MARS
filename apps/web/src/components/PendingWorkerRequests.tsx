import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PendingWorkerRequestData } from "@whitesmith/contracts";
import { ApiRequestError, getPendingWorkerRequests, isUnauthorized, rejectPendingWorker } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";
type Props = { organizationId: string };
type PendingRequest = PendingWorkerRequestData & { id: string; fingerprint: string; name?: string };
export function PendingWorkerRequests({ organizationId }: Props) {
 const client = useQueryClient(); const query = useQuery({ queryKey: ["pending-workers"], queryFn: getPendingWorkerRequests, staleTime: 5000 }); const [error,setError]=useState<string|null>(null);
 const refresh=()=>{void client.invalidateQueries({queryKey:["pending-workers"]});void client.invalidateQueries({queryKey:["org",organizationId,"workers"]});};
 const reject=useMutation({mutationFn:rejectPendingWorker,onSuccess:refresh,onError:e=>setError(e instanceof Error?e.message:"Rejection failed")});
 if(query.error&&isUnauthorized(query.error))return <QueryState error={query.error} isLoading={false}/>; if(query.error&&query.error instanceof ApiRequestError&&query.error.status===403)return <section className="pending-workers state-view state-error"><h2>Authorization required</h2><p>Only global administrators can review pending workers.</p></section>; if(query.isLoading)return <QueryState error={null} isLoading/>; if(query.error)return <QueryState error={query.error} isLoading={false} retry={()=>void query.refetch()}/>;
 return <section className="pending-workers" aria-labelledby="pending-workers-title"><h2 id="pending-workers-title">Pending worker requests</h2>{error&&<p className="form-error" role="alert">{error}</p>}{(query.data??[]).length===0?<p className="pending-empty">No pending worker requests</p>:(query.data??[]).map((worker:PendingRequest)=><article className="pending-worker" key={worker.id}><h3>{worker.name ?? worker.vmUuid}</h3><p>{worker.platform} · {worker.fingerprint}</p><p>Public key: <code>{worker.publicKey}</code></p><WorkerConfigurationForm worker={worker} organizationId={organizationId} onConfigured={refresh}/><button type="button" onClick={()=>reject.mutate(worker.id)}>Reject worker</button><span>Adopt and configure</span></article>)}</section>;
}
