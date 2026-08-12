import { useQuery } from "@tanstack/react-query";
import { getRuns } from "../api.ts";
import { QueryState, WorkspaceRequired } from "../components/StateView.tsx";
import { RunTable } from "../components/RunTable.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
export function RunsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const query = useQuery({ queryKey: ["org", organizationId, "runs"], queryFn: () => getRuns(organizationId), enabled: organizationId !== "all" });
  if (organizationId === "all") return <WorkspaceRequired />;
  return <><header className="page-header"><div><p className="eyebrow">Run ledger</p><h1>Every execution, accounted for.</h1><p className="page-description">Trace GitHub work from queue to teardown without losing the boundary.</p></div></header><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} />{query.data && query.data.items.length > 0 && <RunTable runs={query.data.items} />}</>;
}
