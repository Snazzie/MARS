import { useQuery } from "@tanstack/react-query";
import { getLlmTokenUsage } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { AiTokenUsageChart } from "./AiTokenUsageChart.tsx";
import { formatDuration } from "./RunTelemetry.tsx";

export function AiTokenUsage({ overview = false }: { overview?: boolean }) {
  const usage = useQuery({ queryKey: ["admin", "llm-token-usage"], queryFn: getLlmTokenUsage, staleTime: 30_000 });
  return <div className={overview ? "ai-observe-widgets overview-ai-usage" : "ai-observe-widgets"}>
    <section className="ai-section ai-observe-widget" aria-labelledby="ai-token-usage-title">
      <div className="panel-heading"><div><p className="eyebrow">{overview ? "AI / Observe" : "03 / Observe"}</p><h2 id="ai-token-usage-title">AI usage</h2><p className="form-help">All workspaces · trailing 30 UTC days</p></div></div>
      <QueryState error={usage.error} isLoading={usage.isLoading} retry={() => void usage.refetch()} operationLabel="AI usage" />
      {usage.data && <AiTokenUsageChart usage={usage.data} />}
    </section>
    <section className="ai-section ai-observe-widget" aria-labelledby="ai-run-performance-title">
      <div className="panel-heading"><div><p className="eyebrow">AI / Performance</p><h2 id="ai-run-performance-title">AI run performance</h2><p className="form-help">Failure analyses + PR reviews · enqueued in the last 30 UTC days</p></div></div>
      <QueryState error={usage.error} isLoading={usage.isLoading} retry={() => void usage.refetch()} operationLabel="AI run performance" />
      {usage.data && <div className="ai-performance-metrics">
        {([
          ["Time to start", "Enqueue → worker claim", usage.data.performance.timeToStart],
          ["Time to complete", "Worker claim → finish · excludes publishing", usage.data.performance.timeToComplete],
        ] as const).map(([label, help, metrics]) => <div key={label} className="ai-performance-metric">
          <h3>{label}</h3><p className="form-help">{help}</p>
          <dl><div><dt>p50</dt><dd>{formatDuration(metrics.p50Ms)}</dd></div><div><dt>p95</dt><dd>{formatDuration(metrics.p95Ms)}</dd></div></dl>
          <p className="form-help">{metrics.sampleCount.toLocaleString()} {metrics.sampleCount === 1 ? "run" : "runs"}{metrics.sampleCount === 0 ? " · No measured runs yet" : ""}</p>
        </div>)}
      </div>}
    </section>
  </div>;
}
