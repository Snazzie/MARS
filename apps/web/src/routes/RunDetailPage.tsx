import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { getRun } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { RunDetailView } from "../components/RunDetailView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export function RunDetailPage() {
  const { runId } = useParams({ from: "/dashboard-gate/dashboard/runs/$runId" });
  const search = useSearch({ from: "/dashboard-gate/dashboard/runs/$runId" });
  const { organizationId } = useOrganizationFromRoute();
  const detailOrganizationId = typeof search.organizationId === "string" ? search.organizationId : organizationId;
  const query = useQuery({
    queryKey: ["org", detailOrganizationId, "run", runId],
    queryFn: () => getRun(detailOrganizationId, runId),
    enabled: Boolean(detailOrganizationId && runId && detailOrganizationId !== "all"),
  });

  return <>
    <Link className="back-link" to="/runs">← Back to runs</Link>
    <header className="page-header"><div>
      <p className="eyebrow">Run detail</p>
      <h1>{query.data ? `#${query.data.runNumber} · ${query.data.workflowName}` : "Loading run detail"}</h1>
      <p className="page-description">A single run, including the execution boundary and job lifecycle.</p>
    </div></header>
    <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="run detail" />
    {query.data && <RunDetailView data={query.data} organizationId={detailOrganizationId} />}
  </>;
}
