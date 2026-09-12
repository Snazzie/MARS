import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { getMe, getWorker } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { WorkerCard } from "../components/WorkerCard.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
import { workerRefetchInterval } from "./WorkersPage.tsx";

export function WorkerDetailPage() {
  const { workerId } = useParams({ from: "/_authenticated/workers/$workerId" });
  const { organizationId } = useOrganizationFromRoute();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  const query = useQuery({
    queryKey: ["org", organizationId, "worker", workerId],
    queryFn: () => getWorker(organizationId, workerId),
    enabled: Boolean(organizationId && workerId),
    staleTime: 10_000,
    refetchInterval: (current) => workerRefetchInterval(current.state.data ? [current.state.data] : undefined),
  });
  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["org", organizationId, "worker", workerId] });
    void queryClient.invalidateQueries({ queryKey: ["org", organizationId, "workers"] });
  }
  return <>
    <Link className="back-link" to="/workers">← Back to workers</Link>
    {!query.data && <h1 className="sr-only">Loading worker detail</h1>}
    <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="worker detail" />
    {query.data && <WorkerCard worker={query.data} organizationId={organizationId} canManage={me.data?.isGlobalAdmin === true} onChange={invalidate} />}
  </>;
}
