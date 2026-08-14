import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkers } from "../api.ts";
import { EnrollmentPanel } from "../components/EnrollmentPanel.tsx";
import { PendingWorkerRequests, pendingWorkerQueryOptions } from "../components/PendingWorkerRequests.tsx";
import { WorkerCard } from "../components/WorkerCard.tsx";
import { QueryState } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export function WorkersPage() {
  const { organizationId } = useOrganizationFromRoute();
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["org", organizationId, "workers", includeRevoked], queryFn: () => getWorkers(organizationId, includeRevoked), enabled: Boolean(organizationId), staleTime: 10_000 });
  const pendingQuery = useQuery(pendingWorkerQueryOptions());
  function invalidate() { void queryClient.invalidateQueries({ queryKey: ["pending-workers"] }); void queryClient.invalidateQueries({ queryKey: ["org", organizationId, "workers"] }); }
  return <><header className="page-header workers-header"><div><p className="eyebrow">Worker fleet</p><h1>Know where work lands.</h1><p className="page-description">Adoption, runtime health, and hard capacity boundaries in one disciplined view.</p></div></header><EnrollmentPanel workers={pendingQuery.data ?? []} onConnected={invalidate} />{organizationId === "all" && <PendingWorkerRequests organizationId={organizationId} workers={pendingQuery.data ?? []} error={pendingQuery.error} isLoading={pendingQuery.isLoading} retry={() => void pendingQuery.refetch()} />}<div className="worker-list-toolbar"><label><input type="checkbox" checked={includeRevoked} onChange={(event) => setIncludeRevoked(event.target.checked)} /> Show revoked workers</label></div><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} operationLabel="worker fleet" />{query.data && <div className="worker-list">{query.data.items.map((worker) => <WorkerCard key={worker.id} worker={worker} organizationId={organizationId} onChange={invalidate} />)}</div>}</>;
}
