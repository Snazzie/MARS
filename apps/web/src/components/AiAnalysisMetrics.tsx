import type { PipelineAnalysisMetrics } from "@mars/contracts";
import { formatDuration } from "./RunTelemetry.tsx";

const count = new Intl.NumberFormat("en-US");
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 });
function spend(value: number): string {
  return value > 0 && value < 0.000001 ? "<$0.000001" : usd.format(value);
}

export function AiAnalysisMetrics({ metrics }: { metrics: PipelineAnalysisMetrics }) {
  const unavailable = metrics.providerCalledAt ? "Unavailable" : "—";
  return <dl className="ai-analysis-metrics" aria-label="AI analysis metrics">
    <div><dt>Tokens</dt><dd>{metrics.usage.total === null ? unavailable : count.format(metrics.usage.total)}</dd><small>{metrics.usage.input === null ? "—" : count.format(metrics.usage.input)} in / {metrics.usage.output === null ? "—" : count.format(metrics.usage.output)} out</small></div>
    <div><dt title="Estimated from provider-reported usage and the pricing captured when this analysis was queued; not an invoice.">Estimated spend</dt><dd>{metrics.estimatedCostUsd === null ? unavailable : spend(metrics.estimatedCostUsd)}</dd><small>{metrics.providerCalledAt ? metrics.estimatedCostUsd === null ? "Usage/pricing unavailable" : "Captured API pricing" : "No recorded request"}</small></div>
    <div><dt title="From analysis enqueue to worker claim. Includes waiting for completed pipeline evidence.">Time to start</dt><dd>{!metrics.startedAt && metrics.finishedAt ? "Not started" : formatDuration(metrics.queueWaitMs)}</dd><small>{metrics.startedAt ? "Queue wait" : metrics.finishedAt ? `Waited ${formatDuration(metrics.queueWaitMs)}` : "Waiting"}</small></div>
    <div><dt title="From worker claim to analysis completion. Includes fetching logs and model work; excludes pull request publishing.">Time taken</dt><dd>{formatDuration(metrics.durationMs)}</dd><small>{metrics.startedAt ? metrics.finishedAt ? "Processing time" : "In progress" : "Not started"}</small></div>
  </dl>;
}
