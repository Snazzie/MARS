import { useMemo } from "react";
import { Chart } from "@tanstack/charts/react";
import { colorLegend, defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import type { AiTokenUsage } from "@mars/contracts";

type TokenRow = { date: string; series: "Input tokens" | "Output tokens"; value: number };
const tokenFormatter = new Intl.NumberFormat("en-US");
const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

export function AiTokenUsageChart({ usage }: { usage: AiTokenUsage }) {
  const rows = useMemo<TokenRow[]>(() => usage.points.flatMap((point) => [
    { date: point.date, series: "Input tokens", value: point.inputTokens },
    { date: point.date, series: "Output tokens", value: point.outputTokens },
  ]), [usage.points]);
  const definition = useMemo(() => defineChart({
    marks: [lineY(rows, { x: "date", y: "value", z: "series", color: "series", points: true })],
    x: { scale: () => scalePoint<string>().padding(0.4), axis: { ticks: { format: (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) } } },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Tokens" } },
    color: { scale: () => scaleOrdinal<string, string>().domain(["Input tokens", "Output tokens"]).range(["var(--ui-chart-blue)", "var(--ui-chart-orange)"]), legend: colorLegend({ label: "Usage" }) },
    focus: "group-x",
    tooltip: { use: tooltip, anchor: "group-center", placement: ["top", "right", "left", "bottom"], sort: "color-domain" },
    svgAnimation: true,
  }), [rows]);
  const summary = usage.points.map((point) => `${point.date}: input ${tokenFormatter.format(point.inputTokens)}, output ${tokenFormatter.format(point.outputTokens)}${point.estimatedCostUsd === null ? ", estimated cost unavailable" : `, estimated cost ${usdFormatter.format(point.estimatedCostUsd)}`}`).join("; ");
  const hasTokens = usage.inputTokens > 0 || usage.outputTokens > 0;
  return <>
    <dl className="ai-token-usage-totals">
      <div><dt>Input tokens</dt><dd>{tokenFormatter.format(usage.inputTokens)}</dd></div>
      <div><dt>Output tokens</dt><dd>{tokenFormatter.format(usage.outputTokens)}</dd></div>
      <div><dt>Estimated API cost</dt><dd>{usage.estimatedCostUsd === null ? "Unavailable" : usdFormatter.format(usage.estimatedCostUsd)}</dd></div>
      <div><dt>Requests with reported usage</dt><dd>{tokenFormatter.format(usage.reportedRequests)}</dd></div>
      <div><dt>Requests without reported usage</dt><dd>{tokenFormatter.format(usage.unreportedRequests)}</dd></div>
      <div><dt>Requests without cost estimates</dt><dd>{tokenFormatter.format(usage.unpricedRequests)}</dd></div>
    </dl>
    {hasTokens
      ? <div className="chart-frame ai-token-usage-chart" role="img" aria-label={`Daily AI token usage for the trailing 30 UTC days. Input tokens and output tokens. ${summary}`}><Chart definition={definition} height={240} ariaLabel="Daily AI token usage, input and output tokens" /></div>
      : usage.unreportedRequests > 0
        ? <p className="chart-empty">Token usage is not available for the requests in this window; no token values are estimated.</p>
        : <p className="chart-empty">No reported AI token usage in this window.</p>}
    {usage.unpricedRequests > 0 && <p className="chart-note">Cost is unavailable for {tokenFormatter.format(usage.unpricedRequests)} request(s) with missing pricing or usage. Unknown costs are not treated as zero.</p>}
    {usage.unreportedRequests > 0 && <p className="chart-note">Usage was not reported for {tokenFormatter.format(usage.unreportedRequests)} request(s); these are not included in token totals.</p>}
  </>;
}
