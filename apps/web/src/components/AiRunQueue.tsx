import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getPipelineAnalysisWork } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { useState } from "react";
import { AiAnalysisMetrics } from "./AiAnalysisMetrics.tsx";

const stateLabels = { pending: "Queued", running: "Running", completed: "Completed", failed: "Failed", skipped: "Skipped" } as const;

export function AiRunQueue({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<"queue" | "history">("queue");
  const query = useInfiniteQuery({
    queryKey: ["org", organizationId, "ai-work", view],
    queryFn: ({ pageParam }) => getPipelineAnalysisWork(organizationId, pageParam, view),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const work = query.data?.pages.flatMap(page => page.items) ?? [];
  return <section className="ai-run-queue" aria-label={view === "queue" ? "AI run queue" : "AI run history"}>
    <header className="ai-run-queue-heading"><h2>{view === "queue" ? "AI run queue" : "AI run history"}</h2><div className="run-history-ranges" aria-label="AI run view"><button type="button" aria-pressed={view === "queue"} onClick={() => setView("queue")}>Queue</button><button type="button" aria-pressed={view === "history"} onClick={() => setView("history")}>Recent runs</button></div></header>
    <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="AI run queue" />
    {!query.isLoading && !query.error && <>
      {work.length === 0 ? <p className="chart-empty" role="status">{view === "queue" ? "No queued or running AI analyses." : "No completed AI analyses yet."}</p> : <ul className="ai-run-queue-list">
        {work.map(item => <li key={item.id}>
          <Link className="ai-run-queue-row" to="/runs/$runId" params={{ runId: item.runId }} search={{ organizationId: item.organizationId }}>
            <span className="ai-run-queue-state" data-state={item.state}>{stateLabels[item.state]}</span>
            <div className="ai-run-queue-identity"><strong>{item.workflowName} <span>#{item.runNumber} · attempt {item.runAttempt}</span></strong><small>{item.repositoryName}</small></div>
            <div className="ai-run-queue-provider"><span>{item.providerName}</span><small>{item.model}</small></div>
            <time dateTime={item.metrics.finishedAt ?? item.metrics.startedAt ?? item.metrics.queuedAt} title={item.metrics.finishedAt ? "Analysis finished" : item.metrics.startedAt ? "Analysis started" : "Analysis queued"}>{new Date(item.metrics.finishedAt ?? item.metrics.startedAt ?? item.metrics.queuedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</time>
          </Link>
          <AiAnalysisMetrics metrics={item.metrics} />
          {item.errorCode && <p className="ai-run-error">{item.errorCode.replaceAll("_", " ")}</p>}
        </li>)}
      </ul>}
      {query.hasNextPage && <button type="button" className="button secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "Loading…" : "Load more AI work"}</button>}
    </>}
  </section>;
}
