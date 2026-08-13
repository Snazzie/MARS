import { useMemo } from "react";
import { Chart } from "@tanstack/charts/react";
import { defineChart, lineY } from "@tanstack/charts";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import type { OverviewTimeseriesPoint } from "@whitesmith/contracts";

export function JobActivityChart({ points }: { points: readonly OverviewTimeseriesPoint[] }) {
  const definition = useMemo(() => defineChart({
    marks: [lineY(points, { x: "bucket", y: "pending" }), lineY(points, { x: "bucket", y: "running" })],
    x: { scale: () => scalePoint<string>().padding(0.4) },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Jobs" } },
    svgAnimation: true,
  }), [points]);
  if (!points.length) return <p className="chart-empty">No job activity in this window.</p>;
  const summary = points.map((point) => `${point.bucket}: pending ${point.pending}, running ${point.running}`).join("; ");
  return <div className="chart-frame" role="img" aria-label={`Pending jobs and Running jobs. ${summary}`}><Chart definition={definition} height={220} ariaLabel="Pending jobs and Running jobs" /></div>;
}
