import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getJobTimingAggregates, getJobTimingHistory } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export function TimingHistoryPage() {
  const { organizationId } = useOrganizationFromRoute();
  const [platform, setPlatform] = useState("");
  const [vcpu, setVcpu] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const filters = { platform: platform || undefined, vcpu: vcpu ? Number(vcpu) : undefined, concurrency: concurrency ? Number(concurrency) : undefined };
  const history = useInfiniteQuery({
    queryKey: ["org", organizationId, "job-timings", filters],
    queryFn: ({ pageParam }: { pageParam: string | null }) => getJobTimingHistory(organizationId, { ...filters, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId),
  });
  const aggregates = useQuery({ queryKey: ["org", organizationId, "job-timing-aggregates", filters], queryFn: () => getJobTimingAggregates(organizationId, filters), enabled: Boolean(organizationId) });
  const items = history.data?.pages.flatMap(page => page.items) ?? [];
  return <>
    <header className="runs-heading"><div><p className="eyebrow">Runs</p><h1>Completed job timing history</h1><p>Correlation only; timing differences do not establish causation.</p></div></header>
    <section className="filter-bar" aria-label="Timing history filters">
      <label>Platform <select value={platform} onChange={event => setPlatform(event.target.value)}><option value="">All platforms</option><option value="windows-x64">Windows</option><option value="macos-arm64">macOS</option></select></label>
      <label>vCPU <input inputMode="numeric" value={vcpu} onChange={event => setVcpu(event.target.value)} placeholder="All" /></label>
      <label>Parallelism <input inputMode="numeric" value={concurrency} onChange={event => setConcurrency(event.target.value)} placeholder="All" /></label>
    </section>
    <QueryState error={history.error ?? aggregates.error} isLoading={history.isLoading || aggregates.isLoading} isEmpty={!history.isLoading && !history.error && items.length === 0} retry={() => { void history.refetch(); void aggregates.refetch(); }} operationLabel="timing history" />
    {aggregates.data && <section aria-label="Timing comparisons" className="panel"><h2>Execution timing comparisons</h2><p>Completed samples grouped by platform.</p><table><thead><tr><th>Platform</th><th>Samples</th><th>Median</th><th>p95</th><th>Range</th></tr></thead><tbody>{aggregates.data.map(item => <tr key={item.group.platform}><td>{item.group.platform}</td><td>{item.sampleCount}</td><td>{item.p50Ms} ms</td><td>{item.p95Ms} ms</td><td>{item.minMs}–{item.maxMs} ms</td></tr>)}</tbody></table></section>}
    {items.length > 0 && <section aria-label="Completed timing measurements" className="panel"><h2>Completed measurements</h2><table><thead><tr><th>Job</th><th>Completed</th><th>Execution</th><th>Total</th><th>CPU load</th><th>Memory peak</th><th>Resources</th></tr></thead><tbody>{items.map(item => <tr key={item.jobId}><td>{item.repositoryName} / {item.jobName}</td><td>{new Date(item.completedAt).toLocaleString()}</td><td>{item.executionDurationMs} ms</td><td>{item.totalDurationMs} ms</td><td>{item.telemetryState === "unavailable" ? "Telemetry unavailable" : `${item.cpuAveragePercent?.toFixed(1)}% avg / ${item.cpuP95Percent?.toFixed(1)}% p95 (${item.telemetrySampleCount} samples)`}</td><td>{item.memoryPeakBytes === null ? "Unavailable" : `${item.memoryPeakBytes} bytes`}</td><td>{item.requestedVcpu} vCPU / {item.effectiveConcurrency} parallel</td></tr>)}</tbody></table></section>}
    {history.hasNextPage && <button type="button" className="button secondary load-more" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>{history.isFetchingNextPage ? "Loading…" : "Load more timing records"}</button>}
  </>;
}
