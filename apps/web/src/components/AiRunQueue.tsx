import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getPipelineAnalysisWork } from "../api.ts";
import { QueryState } from "./StateView.tsx";

export function AiRunQueue({ organizationId }: { organizationId: string }) {
  const query = useInfiniteQuery({
    queryKey: ["org", organizationId, "ai-work"],
    queryFn: ({ pageParam }) => getPipelineAnalysisWork(organizationId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const work = query.data?.pages.flatMap(page => page.items) ?? [];
  return <section className="ai-run-queue" aria-label="AI run queue">
    <header className="ai-run-queue-heading"><h2>AI run queue</h2><span className="muted">Failure analysis</span></header>
    <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="AI run queue" />
    {!query.isLoading && !query.error && <>
      {work.length === 0 ? <p className="chart-empty" role="status">No queued or running AI analyses.</p> : <ul className="ai-run-queue-list">
        {work.map(item => <li key={item.id}>
          <Link className="ai-run-queue-row" to="/runs/$runId" params={{ runId: item.runId }} search={{ organizationId: item.organizationId }}>
            <span className="ai-run-queue-state" data-state={item.state}>{item.state === "running" ? "Running" : "Queued"}</span>
            <div className="ai-run-queue-identity"><strong>{item.workflowName} <span>#{item.runNumber} · attempt {item.runAttempt}</span></strong><small>{item.repositoryName}</small></div>
            <div className="ai-run-queue-provider"><span>{item.providerName}</span><small>{item.model}</small></div>
            <time dateTime={item.startedAt ?? item.queuedAt} title={item.state === "running" ? "Analysis started" : "Analysis queued"}>{new Date(item.startedAt ?? item.queuedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</time>
          </Link>
        </li>)}
      </ul>}
      {query.hasNextPage && <button type="button" className="button secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "Loading…" : "Load more AI work"}</button>}
    </>}
  </section>;
}
