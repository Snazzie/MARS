import { useId, useMemo, type ReactNode } from "react";
import type { JobResourceTrendPoint } from "@mars/contracts";
import { barY, colorLegend, defineChart, lineY } from "@tanstack/charts";
import type { ChartPoint, ChartTooltipContent } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import { formatBytes, formatDate, formatDuration, formatPercent } from "../routes/timing-model.ts";

export type ResourceChartProps = {
  points: readonly JobResourceTrendPoint[];
  selectedRunId: string | null;
  onSelectRun(runId: string): void;
};

type SharedRow = {
  position: string;
  runId: string;
  completedAt: string;
  outcome: JobResourceTrendPoint["outcome"];
  telemetryState: JobResourceTrendPoint["telemetryState"];
  telemetrySampleCount: number;
};

type CpuRow = SharedRow & { series: "Average" | "Peak"; segment: string; value: number };
type MemoryRow = SharedRow & { series: "Peak" | "Requested"; segment: string; value: number };
type DurationRow = SharedRow & { value: number };

const tooltipPlacement = ["top", "right", "left", "bottom"] as const;

function outcomeLabel(outcome: JobResourceTrendPoint["outcome"]): string {
  return outcome.charAt(0).toUpperCase() + outcome.slice(1);
}

function telemetryLabel(row: SharedRow): string {
  if (row.telemetryState === "unavailable") return "Unavailable";
  const samples = `${row.telemetrySampleCount} ${row.telemetrySampleCount === 1 ? "sample" : "samples"}`;
  return `${row.telemetryState === "partial" ? "Partial" : "Available"} · ${samples}`;
}

function sharedRow(point: JobResourceTrendPoint, index: number): SharedRow {
  return {
    position: String(index + 1),
    runId: point.runId,
    completedAt: point.completedAt,
    outcome: point.outcome,
    telemetryState: point.telemetryState,
    telemetrySampleCount: point.telemetrySampleCount,
  };
}

function positionLabels(points: readonly JobResourceTrendPoint[]): Map<string, string> {
  return new Map(points.map((point, index) => [String(index + 1), formatDate(point.completedAt)]));
}

const runBandPadding = 0.3;
const runPointPadding = (1 + runBandPadding) / 2;

function orderedRunPointScale(labels: ReadonlyMap<string, string>) {
  return scalePoint<string>().domain(labels.keys()).padding(runPointPadding);
}

function orderedRunBandScale(labels: ReadonlyMap<string, string>) {
  return scaleBand<string>().domain(labels.keys()).padding(runBandPadding);
}

function resourceTooltip<TRow extends SharedRow & { value: number }>(
  points: readonly ChartPoint<TRow, string, number>[],
  formatValue: (value: number) => string,
): ChartTooltipContent {
  const first = points[0]?.datum;
  if (!first) return { rows: [] };
  return {
    title: `${formatDate(first.completedAt)} · ${outcomeLabel(first.outcome)}`,
    rows: [
      ...points.map((point) => ({
        label: "series" in point.datum ? String(point.datum.series) : "Duration",
        value: formatValue(point.datum.value),
        color: point.color,
      })),
      { label: "Telemetry", value: telemetryLabel(first) },
      { label: "Run", value: first.runId },
    ],
  };
}

function ChartPanel({ label, children }: { label: string; children: ReactNode }): ReactNode {
  const headingId = useId();
  return (
    <section className="resource-history-chart-panel" aria-labelledby={headingId}>
      <h3 id={headingId}>{label}</h3>
      {children}
    </section>
  );
}

export function CpuTrendChart({ points, selectedRunId, onSelectRun }: ResourceChartProps): ReactNode {
  const rows = useMemo<CpuRow[]>(() => {
    const result: CpuRow[] = [];
    let averageSegment = 0;
    let peakSegment = 0;
    points.forEach((point, index) => {
      const common = sharedRow(point, index);
      if (point.cpuAveragePercent === null) averageSegment += 1;
      else result.push({ ...common, series: "Average", segment: `Average-${averageSegment}`, value: point.cpuAveragePercent });
      if (point.cpuPeakPercent === null) peakSegment += 1;
      else result.push({ ...common, series: "Peak", segment: `Peak-${peakSegment}`, value: point.cpuPeakPercent });
    });
    return result;
  }, [points]);
  const labels = useMemo(() => positionLabels(points), [points]);
  const definition = useMemo(() => defineChart({
    marks: [lineY(rows, {
      x: "position",
      y: "value",
      z: "segment",
      color: "series",
      key: (row) => `${row.runId}-${row.series}`,
      points: true,
      states: selectedRunId === null ? undefined : [{ when: ({ datum }) => datum.runId === selectedRunId, style: { strokeWidth: 3, opacity: 1 } }],
    })],
    x: { scale: orderedRunPointScale(labels), axis: { label: "Completed runs", ticks: { format: (position: string) => labels.get(position) ?? position } } },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "CPU", ticks: { format: (value: number) => formatPercent(Number(value), 0) } } },
    color: {
      scale: () => scaleOrdinal<string, string>().domain(["Average", "Peak"]).range(["#4f83ff", "#8bc9dc"]),
      legend: colorLegend({ label: "CPU series" }),
    },
    focus: "group-x",
    tooltip: {
      use: tooltip,
      anchor: "group-center",
      placement: tooltipPlacement,
      sort: "color-domain",
      content: (focused) => resourceTooltip(focused, (value) => formatPercent(value)),
    },
  }), [labels, rows, selectedRunId]);
  const summary = points.map((point) => `${formatDate(point.completedAt)}, ${outcomeLabel(point.outcome)}: average ${formatPercent(point.cpuAveragePercent)}, peak ${formatPercent(point.cpuPeakPercent)}`).join("; ");

  return (
    <ChartPanel label="CPU usage over completed runs">
      {rows.length === 0
        ? <p className="chart-empty">CPU telemetry is unavailable for these runs.</p>
        : <div className="chart-frame"><Chart definition={definition} height={240} ariaLabel="CPU usage over completed runs" ariaDescription={summary} onSelect={(point) => { if (point) onSelectRun(point.datum.runId); }} /></div>}
    </ChartPanel>
  );
}

export function MemoryTrendChart({ points, selectedRunId, onSelectRun, requestedMemoryBytes }: ResourceChartProps & { requestedMemoryBytes: number | null }): ReactNode {
  const hasPeakTelemetry = points.some((point) => point.memoryPeakBytes !== null);
  const rows = useMemo<MemoryRow[]>(() => {
    const result: MemoryRow[] = [];
    let peakSegment = 0;
    points.forEach((point, index) => {
      const common = sharedRow(point, index);
      if (point.memoryPeakBytes === null) peakSegment += 1;
      else result.push({ ...common, series: "Peak", segment: `Peak-${peakSegment}`, value: point.memoryPeakBytes });
      if (requestedMemoryBytes !== null) result.push({ ...common, series: "Requested", segment: "Requested-0", value: requestedMemoryBytes });
    });
    return result;
  }, [points, requestedMemoryBytes]);
  const labels = useMemo(() => positionLabels(points), [points]);
  const definition = useMemo(() => defineChart({
    marks: [lineY(rows, {
      x: "position",
      y: "value",
      z: "segment",
      color: "series",
      key: (row) => `${row.runId}-${row.series}`,
      points: true,
      states: selectedRunId === null ? undefined : [{ when: ({ datum }) => datum.runId === selectedRunId, style: { strokeWidth: 3, opacity: 1 } }],
    })],
    x: { scale: orderedRunPointScale(labels), axis: { label: "Completed runs", ticks: { format: (position: string) => labels.get(position) ?? position } } },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Memory", ticks: { format: (value: number) => formatBytes(Number(value)) } } },
    color: {
      scale: () => scaleOrdinal<string, string>().domain(["Peak", "Requested"]).range(["#8bc9dc", "#d6a15f"]),
      legend: colorLegend({ label: "Memory series" }),
    },
    focus: "group-x",
    tooltip: {
      use: tooltip,
      anchor: "group-center",
      placement: tooltipPlacement,
      sort: "color-domain",
      content: (focused) => resourceTooltip(focused, (value) => formatBytes(value)),
    },
  }), [labels, rows, selectedRunId]);
  const summary = points.map((point) => `${formatDate(point.completedAt)}, ${outcomeLabel(point.outcome)}: peak ${formatBytes(point.memoryPeakBytes)}, requested ${formatBytes(requestedMemoryBytes)}`).join("; ");

  return (
    <ChartPanel label="Peak memory over completed runs">
      {!hasPeakTelemetry
        ? <p className="chart-empty">Memory telemetry is unavailable for these runs.</p>
        : <div className="chart-frame"><Chart definition={definition} height={240} ariaLabel="Peak memory over completed runs" ariaDescription={summary} onSelect={(point) => { if (point) onSelectRun(point.datum.runId); }} /></div>}
    </ChartPanel>
  );
}

export function DurationTrendChart({ points, selectedRunId, onSelectRun }: ResourceChartProps): ReactNode {
  const rows = useMemo<DurationRow[]>(() => points.map((point, index) => ({ ...sharedRow(point, index), value: point.executionDurationMs })), [points]);
  const labels = useMemo(() => positionLabels(points), [points]);
  const definition = useMemo(() => defineChart({
    marks: [barY(rows, {
      x: "position",
      y: "value",
      key: "runId",
      fill: "#4f83ff",
      radius: 2,
      states: selectedRunId === null ? undefined : [{ when: ({ datum }) => datum.runId === selectedRunId, style: { stroke: "#8bc9dc", strokeWidth: 3, opacity: 1 } }],
    })],
    x: { scale: orderedRunBandScale(labels), axis: { label: "Completed runs", ticks: { format: (position: string) => labels.get(position) ?? position } } },
    y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Duration", ticks: { format: (value: number) => formatDuration(Number(value)) } } },
    focus: "group-x",
    tooltip: {
      use: tooltip,
      anchor: "group-center",
      placement: tooltipPlacement,
      content: (focused) => resourceTooltip(focused, formatDuration),
    },
  }), [labels, rows, selectedRunId]);
  const summary = points.map((point) => `${formatDate(point.completedAt)}, ${outcomeLabel(point.outcome)}: ${formatDuration(point.executionDurationMs)}`).join("; ");

  return (
    <ChartPanel label="Execution duration over completed runs">
      {rows.length === 0
        ? <p className="chart-empty">No completed runs in this window.</p>
        : <div className="chart-frame"><Chart definition={definition} height={240} ariaLabel="Execution duration over completed runs" ariaDescription={summary} onSelect={(point) => { if (point) onSelectRun(point.datum.runId); }} /></div>}
    </ChartPanel>
  );
}
