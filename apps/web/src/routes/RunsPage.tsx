import { useQuery } from "@tanstack/react-query";
import { getRuns } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { RunTable } from "../components/RunTable.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
export const RUNS_REFRESH_INTERVAL_MS = 2_000;
export function runsQueryOptions(organizationId: string) {
  return { queryKey: ["org", organizationId, "runs"], queryFn: () => getRuns(organizationId), enabled: Boolean(organizationId), refetchInterval: RUNS_REFRESH_INTERVAL_MS };
}
export function RunsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const query = useQuery(runsQueryOptions(organizationId));
  return <><header className="page-header"><div><p className="eyebrow">Run ledger</p><h1>Every execution, accounted for.</h1><p className="page-description">{organizationId === "all" ? "Trace workflow runs across every workspace." : "Trace GitHub work from queue to teardown without losing the boundary."}</p></div></header><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} operationLabel="run ledger" />{query.data && query.data.items.length > 0 && <RunTable runs={query.data.items} />}</>;
}
export const runsQueryRefreshInterval = RUNS_REFRESH_INTERVAL_MS;
