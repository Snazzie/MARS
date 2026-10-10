import { useId, useMemo, useState } from "react";
import { Chart } from "@tanstack/charts/react";
import { defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import type { AiTokenUsage } from "@mars/contracts";

type UsageRow = { date: string; value: number };
const tokenFormatter = new Intl.NumberFormat("en-US");
const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

export function AiTokenUsageChart({ usage }: { usage: AiTokenUsage }) {
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const id = useId();
  const isCost = metric === "cost";
  const label = isCost ? "Estimated API cost" : "Tokens";
  const rows = useMemo<UsageRow[]>(() => usage.points.flatMap(point => {
    const value = metric === "cost" ? point.estimatedCostUsd : point.inputTokens + point.outputTokens;
    return value === null ? [] : [{ date: point.date, value }];
  }), [usage.points, metric]);
  const definition = useMemo(() => defineChart({
    marks: [lineY(rows, { x: "date", y: "value", stroke: "var(--ui-chart-blue)", points: true })],
    x: { scale: () => scalePoint<string>().padding(0.4), axis: { ticks: { format: (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) } } },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label, ticks: { format: (value: number) => isCost ? usdFormatter.format(value) : tokenFormatter.format(value) } } },
    focus: "group-x",
    tooltip: { use: tooltip, anchor: "group-center", placement: ["top", "right", "left", "bottom"], sort: "color-domain" },
    svgAnimation: true,
  }), [rows, label, isCost]);
  const total = isCost ? usage.estimatedCostUsd === null ? "Unavailable" : usdFormatter.format(usage.estimatedCostUsd) : tokenFormatter.format(usage.inputTokens + usage.outputTokens);
  const hasData = isCost ? usage.estimatedCostUsd !== null && usage.reportedRequests + usage.unreportedRequests > 0 : usage.inputTokens > 0 || usage.outputTokens > 0;
  return <>
    <div className="ai-token-usage-toolbar">
      <div className="detail-tab-list" role="tablist" aria-label="AI usage metric" onKeyDown={event => {
        let next: "cost" | "tokens";
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = isCost ? "tokens" : "cost";
        else if (event.key === "Home") next = "cost";
        else if (event.key === "End") next = "tokens";
        else return;
        event.preventDefault();
        setMetric(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-metric="${next}"]`)?.focus();
      }}>
        {(["cost", "tokens"] as const).map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`} data-metric={value} aria-selected={metric === value} aria-controls={`${id}-panel`} tabIndex={metric === value ? 0 : -1} onClick={() => setMetric(value)}>{value === "cost" ? "Cost" : "Tokens"}</button>)}
      </div>
      <span className="form-help">{tokenFormatter.format(usage.reportedRequests + usage.unreportedRequests)} requests · 30 days</span>
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${metric}`} tabIndex={0}>
      <div className="ai-token-usage-summary"><strong>{total}</strong><span>{label}{!isCost && <small>{tokenFormatter.format(usage.inputTokens)} in / {tokenFormatter.format(usage.outputTokens)} out</small>}</span></div>
      {hasData
        ? <div className="chart-frame ai-token-usage-chart" role="img" aria-label={`Daily AI ${isCost ? "cost" : "token usage"} for the trailing 30 UTC days. Total: ${total}.`}><Chart definition={definition} height={120} ariaLabel={`Daily AI ${isCost ? "cost" : "token usage"}`} /></div>
        : <p className="chart-empty">{isCost && usage.estimatedCostUsd === null ? "Cost unavailable: missing pricing or usage." : !isCost && usage.unreportedRequests > 0 ? "Token usage was not reported." : "No AI usage in this window."}</p>}
      {isCost && usage.unpricedRequests > 0 && <p className="chart-note">{tokenFormatter.format(usage.unpricedRequests)} unpriced requests · unknown costs are not zero.</p>}
      {!isCost && usage.unreportedRequests > 0 && <p className="chart-note">{tokenFormatter.format(usage.unreportedRequests)} requests without reported usage are excluded.</p>}
    </div>
  </>;
}
