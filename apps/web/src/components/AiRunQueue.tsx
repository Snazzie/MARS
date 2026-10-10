import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import type { PipelineAnalysisWork, PrReviewWork } from "@mars/contracts";
import { getPipelineAnalysisWork, getPrReviewWork } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { AiAnalysisMetrics } from "./AiAnalysisMetrics.tsx";
import { formatDuration } from "./RunTelemetry.tsx";

const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const states: Record<string, string> = { pending: "Queued", running: "Running", completed: "Completed", failed: "Failed", skipped: "Skipped", superseded: "Superseded" };
type Row = { kind: "pipeline"; item: PipelineAnalysisWork } | { kind: "review"; item: PrReviewWork };

function ResultDetails({ row }: { row: Row }) {
  const item = row.item;
  return <>
    <AiAnalysisMetrics metrics={item.metrics} />
    {item.errorCode && <p className="ai-run-error">{item.errorCode.replaceAll("_", " ")}</p>}
    {row.kind === "pipeline" ? <>
      {row.item.result && <><p>{row.item.result.summary}</p>{row.item.result.failures.map((failure, index) => <article key={index}><strong>Job {failure.jobId}{failure.stepNumber === null ? "" : ` · Step ${failure.stepNumber}`}</strong><p>{failure.explanation}</p>{failure.evidence.length > 0 && <><strong>Evidence</strong><ul>{failure.evidence.map((evidence, i) => <li key={i}><pre>{evidence}</pre></li>)}</ul></>}<strong>Potential fix</strong><p>{failure.suggestedFix}</p></article>)}</>}
      {row.item.comments.length > 0 ? <><strong>Pull request feedback</strong><ul>{row.item.comments.map(comment => <li key={comment.prNumber}>PR #{comment.prNumber} · {comment.state.replaceAll("_", " ")}{comment.commentUrl && <> — <a href={comment.commentUrl} target="_blank" rel="noreferrer">View comment</a></>}{comment.commentBody ? <details><summary>{comment.state === "published" ? "Posted comment" : "Submitted comment body"}</summary><pre>{comment.commentBody}</pre></details> : <p>Comment body unavailable{comment.commentUrl ? "; view the GitHub comment." : "."}</p>}{comment.errorCode && <p>Publishing error: {comment.errorCode.replaceAll("_", " ")}</p>}</li>)}</ul></> : row.item.state === "completed" && <p>No pull request feedback recorded.</p>}
    </> : row.item.result && <><strong>Review analysis · {row.item.result.findings.length} findings</strong>{row.item.result.findings.map((finding, index) => <article key={index}><strong>{finding.severity} · {finding.path}:{finding.line}</strong><p>{finding.evidence}</p><p>{finding.impact}</p><p>{finding.correction}</p>{finding.suggestion && <details><summary>Suggested change</summary><pre>{finding.suggestion.replacementText}</pre><p>{finding.suggestion.rationale}</p></details>}</article>)}</>}
  </>;
}

export function AiRunQueue({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<"queue" | "history">("history");
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["org", organizationId, "ai-work", view],
    queryFn: ({ pageParam }) => getPipelineAnalysisWork(organizationId, pageParam, view),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId), refetchInterval: 5_000, refetchIntervalInBackground: false,
  });
  const reviewsQuery = useInfiniteQuery({
    queryKey: ["org", organizationId, "ai-review-work", view],
    queryFn: ({ pageParam }) => getPrReviewWork(organizationId, pageParam, view),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId), refetchInterval: 5_000, refetchIntervalInBackground: false,
  });
  const rows: Row[] = [
    ...(query.data?.pages.flatMap(page => page.items).map(item => ({ kind: "pipeline" as const, item })) ?? []),
    ...(reviewsQuery.data?.pages.flatMap(page => page.items).map(item => ({ kind: "review" as const, item })) ?? []),
  ];
  rows.sort((a, b) => (view === "queue" ? 1 : -1) * (Date.parse(a.item.metrics.queuedAt) - Date.parse(b.item.metrics.queuedAt)) || `${a.kind}:${a.item.id}`.localeCompare(`${b.kind}:${b.item.id}`));
  return <section className="ai-run-queue" aria-label={view === "queue" ? "AI run queue" : "AI run history"}>
    <header className="ai-run-queue-heading"><h2>{view === "queue" ? "AI run queue" : "Recent AI runs"}</h2><div className="run-history-ranges" aria-label="AI run view"><button type="button" aria-pressed={view === "queue"} onClick={() => setView("queue")}>Queue</button><button type="button" aria-pressed={view === "history"} onClick={() => setView("history")}>Recent runs</button></div></header>
    <QueryState error={query.error ?? reviewsQuery.error} isLoading={query.isLoading || reviewsQuery.isLoading} retry={() => { void query.refetch(); void reviewsQuery.refetch(); }} operationLabel="AI runs" />
    {rows.length === 0 ? !query.isLoading && !reviewsQuery.isLoading && !query.error && !reviewsQuery.error && <p className="chart-empty" role="status">{view === "queue" ? "No queued or running AI analyses or pull request reviews." : "No AI analyses or pull request reviews yet."}</p> : <div className="table-scroll"><table className="ai-runs-table"><thead><tr><th scope="col">Run</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Provider / model</th><th scope="col">Input tk</th><th scope="col">Output tk</th><th scope="col">tk/s</th><th scope="col">Duration</th><th scope="col">Started / queued</th><th scope="col">Details</th></tr></thead><tbody>{rows.map(row => {
      const item = row.item, metrics = item.metrics, key = `${row.kind}:${item.id}`;
      const state = row.kind === "pipeline" ? row.item.state : row.item.analysisState;
      const timestamp = metrics.startedAt ?? metrics.queuedAt;
      return <Fragment key={key}><tr>
        <td>{row.kind === "pipeline" ? <Link to="/runs/$runId" params={{ runId: row.item.runId }} search={{ organizationId: item.organizationId }}>{row.item.workflowName} #{row.item.runNumber} · attempt {row.item.runAttempt}</Link> : <a href={row.item.reviewUrl ?? `https://github.com/${item.repositoryName}/pull/${row.item.prNumber}`} target="_blank" rel="noreferrer">PR #{row.item.prNumber}</a>}<small>{item.repositoryName}</small></td>
        <td>{row.kind === "pipeline" ? "Pipeline analysis" : "PR review"}</td>
        <td><span className="ai-run-queue-state" data-state={state}>{states[state] ?? state}</span>{row.kind === "review" && <small>{row.item.publicationState.replaceAll("_", " ")}</small>}</td>
        <td>{item.providerName}<small>{item.model}</small></td>
        <td className="numeric">{metrics.usage.input === null ? "—" : count.format(metrics.usage.input)}</td>
        <td className="numeric">{metrics.usage.output === null ? "—" : count.format(metrics.usage.output)}</td>
        <td className="numeric">{metrics.tokensPerSecond === null ? "—" : count.format(metrics.tokensPerSecond)}</td>
        <td className="numeric">{formatDuration(metrics.durationMs)}</td>
        <td><time dateTime={timestamp}>{new Date(timestamp).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</time></td>
        <td><button type="button" aria-expanded={expanded === key} aria-controls={`ai-details-${key}`} onClick={() => setExpanded(expanded === key ? null : key)}>{expanded === key ? "Hide" : "View"}</button></td>
      </tr>{expanded === key && <tr id={`ai-details-${key}`}><td colSpan={10} className="ai-run-details"><ResultDetails row={row} /></td></tr>}</Fragment>;
    })}</tbody></table></div>}
    {(query.hasNextPage || reviewsQuery.hasNextPage) && <button type="button" disabled={query.isFetchingNextPage || reviewsQuery.isFetchingNextPage} onClick={() => { if (query.hasNextPage) void query.fetchNextPage(); if (reviewsQuery.hasNextPage) void reviewsQuery.fetchNextPage(); }}>Load more runs</button>}
  </section>;
}
