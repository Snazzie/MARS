import { useQuery } from "@tanstack/react-query";
import { getRuns } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { RunHistory } from "../components/RunHistory.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export const RUNS_REFRESH_INTERVAL_MS = 2_000;

export function runsQueryOptions(organizationId: string) {
  return { queryKey: ["org", organizationId, "runs"], queryFn: () => getRuns(organizationId), enabled: Boolean(organizationId), refetchInterval: RUNS_REFRESH_INTERVAL_MS };
}

export function RunsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const query = useQuery(runsQueryOptions(organizationId));
  return <>
    <header className="runs-heading">
      <div>
        <p className="eyebrow">Runs</p>
        <h1 id="run-history-title">Job Run History</h1>
      </div>
    </header>
    <QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} operationLabel="run history" />
    {query.data && query.data.items.length > 0 && <RunHistory runs={query.data.items} />}
  </>;
}

export const runsQueryRefreshInterval = RUNS_REFRESH_INTERVAL_MS;
