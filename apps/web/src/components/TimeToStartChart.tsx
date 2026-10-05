import { useMemo } from "react";
import { Chart } from "@tanstack/charts/react";
import { colorLegend, defineChart, lineY, type ChartPoint, type ChartTooltipContent } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import type { DashboardPeriod, OverviewTimeToStartPoint } from "@mars/contracts";
import { formatDuration } from "../routes/timing-model.ts";

type WaitRow = { bucket: string; series: "p50" | "p95"; segment: string; value: number; sampleCount: number };

function waitTooltip(points: readonly ChartPoint<WaitRow, string, number>[]): ChartTooltipContent {
  const first = points[0]?.datum;
  if (!first) return { rows: [] };
  return {
    title: new Date(first.bucket).toLocaleString(),
    rows: [...points.map(({ datum }) => ({ label: datum.series, value: formatDuration(datum.value) })), { label: "Jobs started", value: String(first.sampleCount) }],
  };
}

export function TimeToStartChart({ points, period }: { points: readonly OverviewTimeToStartPoint[]; period: DashboardPeriod }) {
  const rows = useMemo(() => {
    const result: WaitRow[] = [];
    let segment = 0;
    for (const point of points) {
      if (point.p50Ms === null || point.p95Ms === null) { segment++; continue; }
      result.push({ bucket: point.bucket, series: "p50", segment: `p50-${segment}`, value: point.p50Ms, sampleCount: point.sampleCount }, { bucket: point.bucket, series: "p95", segment: `p95-${segment}`, value: point.p95Ms, sampleCount: point.sampleCount });
    }
    return result;
  }, [points]);
  const definition = useMemo(() => defineChart({
    marks: [lineY(rows, { x: "bucket", y: "value", z: "segment", color: "series", points: true })],
    x: {
      scale: () => scalePoint<string>().domain(points.map(point => point.bucket)).padding(0.4),
      axis: { label: "Job start time", ticks: { format: (bucket: string) => {
        const index = points.findIndex(point => point.bucket === bucket);
        if (index % Math.max(1, Math.ceil(points.length / 6)) !== 0 && index !== points.length - 1) return "";
        return new Date(bucket).toLocaleString(undefined, period === "24h" ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" });
      } } },
    },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Queue wait", ticks: { format: (value: number) => formatDuration(value) } } },
    color: { scale: () => scaleOrdinal<string, string>().domain(["p50", "p95"]).range(["var(--ui-chart-blue)", "var(--ui-chart-orange)"]), legend: colorLegend({ label: "Time to start" }) },
    focus: "group-x",
    tooltip: { use: tooltip, anchor: "group-center", placement: ["top", "right", "left", "bottom"], content: waitTooltip },
    svgAnimation: true,
  }), [rows, points, period]);
  if (!rows.length) return <p className="chart-empty">No jobs started in this window.</p>;
  const summary = points.map(point => `${point.bucket}: ${point.sampleCount} starts${point.p50Ms === null || point.p95Ms === null ? ", no samples" : `, p50 ${formatDuration(point.p50Ms)}, p95 ${formatDuration(point.p95Ms)}`}`).join("; ");
  return <div className="chart-frame" role="img" aria-label={`Time to start: queued to running. ${summary}`}><Chart definition={definition} height={260} ariaLabel="Time to start p50 and p95 over time" /></div>;
}
