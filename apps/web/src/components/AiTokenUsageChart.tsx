import { useMemo } from "react";
import { Chart } from "@tanstack/charts/react";
import { colorLegend, defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import type { AiTokenUsage } from "@mars/contracts";

type TokenRow = { date: string; series: string; value: number };
const tokenFormatter = new Intl.NumberFormat("en-US");
const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

export function AiTokenUsageChart({ usage }: { usage: AiTokenUsage }) {
  const rows = useMemo<TokenRow[]>(() => usage.models.flatMap((model) => model.points.map((point) => ({
    date: point.date, series: model.model, value: point.inputTokens + point.outputTokens,
  }))), [usage.models]);
  const definition = useMemo(() => defineChart({
    marks: [lineY(rows, { x: "date", y: "value", z: "series", color: "series", points: true })],
    x: { scale: () => scalePoint<string>().padding(0.4), axis: { ticks: { format: (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) } } },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Tokens" } },
    color: { scale: () => scaleOrdinal<string, string>().domain(usage.models.map(model => model.model)).range(["var(--ui-chart-blue)", "var(--ui-chart-orange)", "#16a34a", "#a855f7", "#e11d48", "#0891b2", "#ca8a04", "#64748b"]), legend: colorLegend({ label: "Model" }) },
    focus: "group-x",
    tooltip: { use: tooltip, anchor: "group-center", placement: ["top", "right", "left", "bottom"], sort: "color-domain" },
    svgAnimation: true,
  }), [rows, usage.models]);
  const summary = usage.models.map(model => `${model.model}: ${tokenFormatter.format(model.inputTokens + model.outputTokens)} tokens, estimated API cost ${model.estimatedCostUsd === null ? "unavailable" : usdFormatter.format(model.estimatedCostUsd)}`).join("; ");
  const hasTokens = usage.inputTokens > 0 || usage.outputTokens > 0;
  return <>
    <div className="ai-token-usage-summary">
      <span><strong>{tokenFormatter.format(usage.inputTokens + usage.outputTokens)}</strong> tokens <span className="form-help">({tokenFormatter.format(usage.inputTokens)} in / {tokenFormatter.format(usage.outputTokens)} out)</span></span>
      <span>Estimated API cost <strong>{usage.estimatedCostUsd === null ? "Unavailable" : usdFormatter.format(usage.estimatedCostUsd)}</strong></span>
      <span className="form-help">{tokenFormatter.format(usage.reportedRequests + usage.unreportedRequests)} requests · 30 days</span>
    </div>
    {usage.models.length > 0 && <div className="ai-token-usage-models"><table className="ai-repository-table">
      <thead><tr><th scope="col">Model</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Estimated API cost</th></tr></thead>
      <tbody>{usage.models.map(model => <tr key={model.model}>
        <th scope="row">{model.model}</th><td>{tokenFormatter.format(model.inputTokens)}</td><td>{tokenFormatter.format(model.outputTokens)}</td><td>{model.estimatedCostUsd === null ? "Unavailable" : usdFormatter.format(model.estimatedCostUsd)}</td>
      </tr>)}</tbody>
    </table></div>}
    {hasTokens
      ? <div className="chart-frame ai-token-usage-chart" role="img" aria-label={`Daily AI token usage by model for the trailing 30 UTC days. ${summary}`}><Chart definition={definition} height={160} ariaLabel="Daily AI token usage by model" /></div>
      : usage.unreportedRequests > 0
        ? <p className="chart-empty">Token usage is not available for the requests in this window; no token values are estimated.</p>
        : <p className="chart-empty">No reported AI token usage in this window.</p>}
    {usage.unpricedRequests > 0 && <p className="chart-note">Cost is unavailable for {tokenFormatter.format(usage.unpricedRequests)} request(s) with missing pricing or usage. Unknown costs are not treated as zero.</p>}
    {usage.unreportedRequests > 0 && <p className="chart-note">Usage was not reported for {tokenFormatter.format(usage.unreportedRequests)} request(s); these are not included in token totals.</p>}
  </>;
}
