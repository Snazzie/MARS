import { useQuery } from "@tanstack/react-query";
import { getLogs } from "../api.ts";
import { QueryState } from "./StateView.tsx";

export function LogViewer({ organizationId, runId, jobId }: { organizationId: string; runId: string; jobId: string }) {
  const query = useQuery({ queryKey: ["org", organizationId, "run", runId, "job", jobId, "logs"], queryFn: () => getLogs(organizationId, runId, jobId), enabled: Boolean(organizationId && runId && jobId), staleTime: 15_000 });
  return <section className="log-panel" aria-labelledby="logs-title"><div className="panel-kicker" id="logs-title">Job logs</div><QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && query.data?.items.length === 0} retry={() => void query.refetch()} />{query.data && query.data.items.length > 0 && <><pre className="log-viewer" tabIndex={0} aria-label="Bounded job log output">{query.data.items.slice(0, 200).map((chunk) => `${chunk.content}\n`).join("")}</pre><p className="log-meta">Showing up to 200 ordered chunks{query.data.nextCursor ? "; more logs are available from search." : ""}.</p></>}</section>;
}
