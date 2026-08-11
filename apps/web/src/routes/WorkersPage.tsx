import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkers } from "../api.ts";
import { EnrollmentWizard } from "../components/EnrollmentWizard.tsx";
import { WorkerCard } from "../components/WorkerCard.tsx";
import { QueryState } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export function WorkersPage() {
  const { organizationId } = useOrganizationFromRoute();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["org", organizationId, "workers"], queryFn: () => getWorkers(organizationId), enabled: Boolean(organizationId), staleTime: 10_000 });
  function invalidate() { void queryClient.invalidateQueries({ queryKey: ["org", organizationId, "workers"] }); }
  return <><header className="page-header workers-header"><div><p className="eyebrow">Worker fleet</p><h1>Know where work lands.</h1><p className="page-description">Adoption, runtime health, and hard capacity boundaries in one disciplined view.</p></div><EnrollmentWizard onCreated={invalidate} /></header><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} />{query.data && organizationId && <section className="worker-list" aria-label="Workers">{query.data.items.map((worker) => <WorkerCard key={worker.id} worker={worker} organizationId={organizationId} onChange={invalidate} />)}</section>}</>;
}
