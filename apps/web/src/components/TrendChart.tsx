import { useMemo } from "react";
import { Chart } from "@tanstack/charts/react";
import { defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleLinear } from "@tanstack/charts/scales/linear";

type TrendPoint = { label: string; value: number };

export function TrendChart({ points, label }: { points: readonly TrendPoint[]; label: string }) {
  const definition = useMemo(() => defineChart({
    marks: [lineY(points, { x: "label", y: "value", points: true })],
    x: { scale: () => scalePoint<string>().padding(0.4) },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label } },
    tooltip: { use: tooltip, anchor: "point", placement: ["top", "right", "left", "bottom"] },
    svgAnimation: true,
  }), [points, label]);
  if (!points.length) return <p className="chart-empty">No trend data in this window.</p>;
  return <div className="chart-frame" role="img" aria-label={`${label} trend chart`}><Chart definition={definition} height={220} ariaLabel={`${label} trend chart`} /></div>;
}
