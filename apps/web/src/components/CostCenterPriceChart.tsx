import { useMemo } from "react";
import { Chart } from "@tanstack/charts/react";
import { defineChart, lineY } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";
import { scalePoint } from "@tanstack/charts/scales/point";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import type { CostCenterPricePoint } from "@mars/contracts";
import { formatUsdMicros } from "../format.ts";

type PriceRow = { date: string; value: number };

export function CostCenterPriceChart({ points }: { points: readonly CostCenterPricePoint[] }) {
  const rows = useMemo<PriceRow[]>(() => points.map((point) => ({ date: point.date, value: point.estimatedSavingsMicros / 1_000_000 })), [points]);
  const definition = useMemo(() => defineChart({
    marks: [lineY(rows, { x: "date", y: "value", points: true })],
    x: { scale: () => scalePoint<string>().padding(0.4) },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "USD avoided" } },
    tooltip: { use: tooltip, anchor: "point", placement: ["top", "right", "left", "bottom"] },
    svgAnimation: true,
  }), [rows]);
  if (!points.length) return <p className="chart-empty">No priced usage in this window.</p>;
  const summary = points.map((point) => `${point.date}: ${formatUsdMicros(point.estimatedSavingsMicros)}`).join("; ");
  return <div className="chart-frame cost-center-price-chart" role="img" aria-label={`Estimated GitHub-hosted retail cost avoided by completion date. ${summary}`}><Chart definition={definition} height={240} ariaLabel="Estimated GitHub-hosted retail cost avoided by completion date" /></div>;
}
