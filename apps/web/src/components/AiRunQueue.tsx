import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getPipelineAnalysisWork } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { useState } from "react";
import { AiAnalysisMetrics } from "./AiAnalysisMetrics.tsx";

const stateLabels = { pending: "Queued", running: "Running", completed: "Completed", failed: "Failed", skipped: "Skipped" } as const;

export function AiRunQueue({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<"queue" | "history">("history");
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
    <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel={view === "queue" ? "AI run queue" : "AI run history"} />
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
          {item.result && <details className="ai-run-result"><summary>Analysis result</summary><p>{item.result.summary}</p>{item.result.failures.map((failure, index) => <article key={`${failure.jobId}-${failure.stepNumber ?? "job"}-${index}`}><strong>Job {failure.jobId}{failure.stepNumber === null ? "" : ` · Step ${failure.stepNumber}`}</strong><p>{failure.explanation}</p>{failure.evidence.length > 0 && <><strong>Evidence</strong><ul>{failure.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{evidence}</pre></li>)}</ul></>}<strong>Potential fix</strong><p>{failure.suggestedFix}</p></article>)}</details>}
          {item.comments.length > 0 && <div className="ai-run-comments"><strong>Pull request feedback</strong><ul>{item.comments.map(comment => <li key={comment.prNumber}>
            PR #{comment.prNumber} · {comment.state.replaceAll("_", " ")}
            {comment.commentUrl && <> — <a href={comment.commentUrl} target="_blank" rel="noreferrer">View comment</a></>}
            {comment.commentBody ? <details><summary>{comment.state === "published" ? "Posted comment" : "Submitted comment body"}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{comment.commentBody}</pre></details> : <p>Comment body unavailable{comment.commentUrl ? "; view the GitHub comment." : "."}</p>}
            {comment.errorCode && <p>Publishing error: {comment.errorCode.replaceAll("_", " ")}</p>}
          </li>)}</ul></div>}
          {item.state === "completed" && item.comments.length === 0 && <p>No associated pull request.</p>}
        </li>)}
      </ul>}
      {query.hasNextPage && <button type="button" className="button secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "Loading…" : "Load more AI work"}</button>}
    </>}
  </section>;
}
