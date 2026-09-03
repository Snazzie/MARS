import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { getRun } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { RunDetailView } from "../components/RunDetailView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export function RunDetailPage() {
  const { runId } = useParams({ from: "/_authenticated/runs/$runId" });
  const search = useSearch({ from: "/_authenticated/runs/$runId" });
  const { organizationId } = useOrganizationFromRoute();
  const detailOrganizationId = typeof search.organizationId === "string" ? search.organizationId : organizationId;
  const query = useQuery({
    queryKey: ["org", detailOrganizationId, "run", runId],
    queryFn: () => getRun(detailOrganizationId, runId),
    enabled: Boolean(detailOrganizationId && runId && detailOrganizationId !== "all"),
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined" || !query.data) return;
    const hash = window.location.hash;
    if (!hash.startsWith("#job-")) return;
    const encodedJobId = hash.slice(1);
    let jobId: string;
    try {
      jobId = decodeURIComponent(encodedJobId);
    } catch {
      return;
    }
    document.getElementById(jobId)?.scrollIntoView?.({ block: "start" });
  }, [query.data, runId]);

  return <>
    <Link className="back-link" to="/runs">← Back to runs</Link>
    {!query.data && <h1 className="sr-only">Loading run detail</h1>}
    <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="run detail" />
    {query.data && <RunDetailView data={query.data} organizationId={detailOrganizationId} />}
  </>;
}
