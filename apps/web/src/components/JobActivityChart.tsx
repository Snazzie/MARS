import { useMemo } from "react";
import { Chart } from "@tanstack/charts/react";
import { defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import type { OverviewTimeseriesPoint } from "@whitesmith/contracts";

type ActivityRow = { bucket: string; series: "Pending" | "Running"; value: number };

export function JobActivityChart({ points }: { points: readonly OverviewTimeseriesPoint[] }) {
  const rows = useMemo<ActivityRow[]>(() => points.flatMap((point) => [{ bucket: point.bucket, series: "Pending", value: point.pending }, { bucket: point.bucket, series: "Running", value: point.running }]), [points]);
  const definition = useMemo(() => defineChart({
    marks: [lineY(rows, { x: "bucket", y: "value", z: "series", color: "series", points: true })],
    x: { scale: () => scalePoint<string>().padding(0.4) },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Jobs" } },
    focus: "group-x",
    tooltip: { use: tooltip, anchor: "group-center", placement: ["top", "right", "left", "bottom"], sort: "color-domain" },
    svgAnimation: true,
  }), [rows]);
  if (!points.length) return <p className="chart-empty">No job activity in this window.</p>;
  const summary = points.map((point) => `${point.bucket}: pending ${point.pending}, running ${point.running}`).join("; ");
  return <div className="chart-frame" role="img" aria-label={`Pending jobs and Running jobs. ${summary}`}><Chart definition={definition} height={220} ariaLabel="Pending jobs and Running jobs" /></div>;
}
