import { useMemo } from "react";
import { barY, colorLegend, defineChart, stack } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import type { OverviewDto } from "@whitesmith/contracts";

type JobOutcome = NonNullable<OverviewDto["jobOutcomes"]>[number];
type Platform = keyof JobOutcome["platforms"];
type OutcomeName = JobOutcome["outcome"];
type ChartRow = { outcome: OutcomeName; platform: Platform; count: number };

const outcomeOrder: readonly OutcomeName[] = ["queued", "running", "completed", "failed"];
const platformOrder: readonly { key: Platform; label: string }[] = [
  { key: "macos", label: "macOS" },
  { key: "ubuntu", label: "Ubuntu" },
  { key: "windows", label: "Windows" },
  { key: "other", label: "Other" },
];
const outcomeLabels: Record<OutcomeName, string> = { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed" };
const platformLabels = Object.fromEntries(platformOrder.map(({ key, label }) => [key, label])) as Record<Platform, string>;

export function OutcomeBars({ outcomes, label = "Job outcomes" }: { outcomes: readonly JobOutcome[]; label?: string }) {
  const rows = useMemo<ChartRow[]>(() => outcomeOrder.flatMap((outcome) => {
    const value = outcomes.find((item) => item.outcome === outcome);
    return platformOrder.map(({ key }) => ({ outcome, platform: key, count: value?.platforms[key] ?? 0 }));
  }), [outcomes]);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const definition = useMemo(() => defineChart({
    marks: [barY(rows, { x: "outcome", y: "count", z: "platform", color: "platform", layout: stack({ order: platformOrder.map(({ key }) => key) }), radius: 2 })],
    x: { scale: () => scaleBand<OutcomeName>().padding(0.3), axis: { label: "Job outcome", format: (value: string) => outcomeLabels[value as OutcomeName] ?? value } },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Jobs" } },
    color: { scale: () => scaleOrdinal<Platform, string>().domain(platformOrder.map(({ key }) => key)).range(["#c9f47b", "#8bc9dc", "#e7835d", "#59635f"]), legend: colorLegend({ label: "Platform" }) },
    focus: "group-x",
    tooltip: { use: tooltip, anchor: "group-center", placement: ["top", "right", "left", "bottom"], sort: "color-domain" },
  }), [rows]);
  if (!total) return <p className="chart-empty">No outcomes recorded yet.</p>;
  const summary = outcomeOrder.flatMap((outcome) => platformOrder.map(({ key }) => `${outcomeLabels[outcome]} ${platformLabels[key]}: ${outcomes.find((item) => item.outcome === outcome)?.platforms[key] ?? 0}`)).join(", ");
  return <div className="chart-frame outcome-chart" role="img" aria-label={`${label}. ${summary}`}><Chart definition={definition} height={260} ariaLabel={label} /></div>;
}
