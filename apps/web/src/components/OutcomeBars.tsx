import { useMemo } from "react";
import { Chart } from "@tanstack/charts/react";
import { barX, defineChart } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleBand } from "@tanstack/charts/scales/band";

type Outcome = { label: string; value: number };

export function OutcomeBars({ outcomes, label = "Run outcomes" }: { outcomes: readonly Outcome[]; label?: string }) {
  const definition = useMemo(() => defineChart({
    marks: [barX(outcomes, { x: "value", y: "label" })],
    x: { scale: scaleLinear, nice: true, axis: { label: "Runs" } },
    y: { scale: () => scaleBand<string>().padding(0.28) },
    svgAnimation: true,
  }), [outcomes]);
  if (!outcomes.length) return <p className="chart-empty">No outcomes recorded yet.</p>;
  const summary = outcomes.map((outcome) => `${outcome.label}: ${outcome.value}`).join(", ");
  return <div className="chart-frame" role="img" aria-label={`${label}. ${summary}`}><Chart definition={definition} height={220} ariaLabel={label} /></div>;
}
