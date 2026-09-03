import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { JobResourceTrendPoint } from "@mars/contracts";
import { barY, colorLegend, defineChart, dot, lineY } from "@tanstack/charts";
import type { ChartMark, ChartPoint, ChartTooltipContent } from "@tanstack/charts";
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
  point: JobResourceTrendPoint;
  outcome: JobResourceTrendPoint["outcome"];
  telemetryState: JobResourceTrendPoint["telemetryState"];
  telemetrySampleCount: number;
};

type CpuRow = SharedRow & { series: "Average" | "Peak"; segment: string; value: number };
type MemoryRow = SharedRow & { series: "Peak" | "Requested"; segment: string; value: number };
type DurationRow = SharedRow & { value: number };
type MetricRow = SharedRow & { value: number };

const CPU_AVERAGE = "#4f83ff";
const CPU_PEAK = "#8bc9dc";
const MEMORY_PEAK = "#e56b3f";
const REQUESTED_MEMORY = "#d6a15f";
const DURATION = "#d6a15f";
const DEGRADED = "#e76f9b";
const PANEL = "#211917";
const tooltipPlacement = ["top", "right", "left", "bottom"] as const;

function outcomeLabel(outcome: JobResourceTrendPoint["outcome"]): string {
  return outcome.charAt(0).toUpperCase() + outcome.slice(1);
}

function isOutcomeDegraded(point: JobResourceTrendPoint): boolean {
  return point.outcome === "failure" || point.outcome === "cancelled";
}

function telemetryLabel(point: JobResourceTrendPoint): string {
  if (point.telemetryState === "unavailable") return "Unavailable";
  const samples = `${point.telemetrySampleCount} ${point.telemetrySampleCount === 1 ? "sample" : "samples"}`;
  return `${point.telemetryState === "partial" ? "Partial" : "Available"} · ${samples}`;
}

function sharedRow(point: JobResourceTrendPoint, index: number): SharedRow {
  return {
    position: String(index + 1),
    runId: point.runId,
    point,
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

function resourceTooltip<TRow extends MetricRow>(
  points: readonly ChartPoint<TRow, string, number>[],
): ChartTooltipContent {
  const point = points[0]?.datum.point;
  if (!point) return { rows: [] };
  return {
    title: formatDate(point.completedAt),
    rows: [
      { label: "Outcome", value: outcomeLabel(point.outcome), color: isOutcomeDegraded(point) ? DEGRADED : undefined },
      { label: "Execution duration", value: formatDuration(point.executionDurationMs) },
      { label: "CPU average", value: formatPercent(point.cpuAveragePercent) },
      { label: "CPU peak", value: formatPercent(point.cpuPeakPercent) },
      { label: "Memory peak", value: formatBytes(point.memoryPeakBytes) },
      { label: "Requested vCPU", value: String(point.requestedVcpu) },
      { label: "Requested memory", value: formatBytes(point.requestedMemoryBytes) },
      { label: "Parallelism", value: String(point.effectiveConcurrency) },
      { label: "Telemetry", value: telemetryLabel(point), color: point.telemetryState !== "available" ? DEGRADED : undefined },
      { label: "Action", value: "Open run below" },
    ],
  };
}

function ChartRunDetails({ point, focused }: { point: JobResourceTrendPoint | null; focused: boolean }): ReactNode {
  if (!point) return (
    <p className="resource-history-chart-run-empty">
      Focus or select a chart mark to inspect every measurement and open the run.
    </p>
  );
  return (
    <aside className="resource-history-chart-run-detail" aria-live="polite" aria-label={`${focused ? "Focused" : "Selected"} run details`}>
      <strong>{focused ? "Focused" : "Selected"} run · {formatDate(point.completedAt)}</strong>
      <dl>
        <div><dt>Outcome</dt><dd>{outcomeLabel(point.outcome)}</dd></div>
        <div><dt>Execution duration</dt><dd>{formatDuration(point.executionDurationMs)}</dd></div>
        <div><dt>CPU average / peak</dt><dd>{formatPercent(point.cpuAveragePercent)} / {formatPercent(point.cpuPeakPercent)}</dd></div>
        <div><dt>Memory peak</dt><dd>{formatBytes(point.memoryPeakBytes)}</dd></div>
        <div><dt>Requested</dt><dd>{point.requestedVcpu} vCPU / {formatBytes(point.requestedMemoryBytes)}</dd></div>
        <div><dt>Parallelism</dt><dd>{point.effectiveConcurrency}</dd></div>
        <div><dt>Telemetry</dt><dd>{telemetryLabel(point)}</dd></div>
      </dl>
      <a href={`/runs/${encodeURIComponent(point.runId)}?organizationId=${encodeURIComponent(point.organizationId)}`}>Open run</a>
    </aside>
  );
}

function MarkLegend(): ReactNode {
  return (
    <div className="resource-history-mark-legend" aria-label="Chart mark meanings">
      <span><i className="is-outcome" aria-hidden="true" />Failed or cancelled run</span>
      <span><i className="is-partial" aria-hidden="true" />Partial telemetry (hollow mark)</span>
    </div>
  );
}

function ChartPanel({ label, children }: { label: string; children: ReactNode }): ReactNode {
  const headingId = useId();
  return (
    <section className="resource-history-chart-panel" aria-labelledby={headingId}>
      <h3 id={headingId}>{label}</h3>
      <MarkLegend />
      {children}
    </section>
  );
}

function dotMark<TRow extends MetricRow>(
  rows: readonly TRow[],
  id: string,
  fill: string,
  stroke: string = fill,
  selectedRunId: string | null = null,
): ChartMark<TRow, string, number> {
  return dot(rows, {
    id,
    x: (row) => row.position,
    y: (row) => row.value,
    key: (row) => `${row.runId}-${"series" in row ? String(row.series) : "value"}`,
    r: (row) => row.runId === selectedRunId ? 5 : 3.5,
    fill,
    stroke,
    strokeWidth: 2,
  });
}

function classifiedDotMarks<TRow extends MetricRow>(
  rows: readonly TRow[],
  prefix: string,
  selectedRunId: string | null,
): ChartMark<TRow, string, number>[] {
  const outcome = rows.filter((row) => isOutcomeDegraded(row.point) && row.telemetryState !== "partial");
  const partialOutcome = rows.filter((row) => isOutcomeDegraded(row.point) && row.telemetryState === "partial");
  const partial = rows.filter((row) => !isOutcomeDegraded(row.point) && row.telemetryState === "partial");
  return [
    dotMark(outcome, `${prefix}-outcome-markers`, DEGRADED, DEGRADED, selectedRunId),
    dotMark(partialOutcome, `${prefix}-partial-outcome-markers`, PANEL, DEGRADED, selectedRunId),
    dotMark(partial, `${prefix}-partial-markers`, PANEL, DEGRADED, selectedRunId),
  ];
}
export function retainChartFocus(
  current: JobResourceTrendPoint | null,
  next: JobResourceTrendPoint | null,
): JobResourceTrendPoint | null {
  return next ?? current;
}


function selectedPoint(points: readonly JobResourceTrendPoint[], selectedRunId: string | null): JobResourceTrendPoint | null {
  return selectedRunId === null ? null : points.find((point) => point.runId === selectedRunId) ?? null;
}

export function CpuTrendChart({ points, selectedRunId, onSelectRun }: ResourceChartProps): ReactNode {
  const [focusedPoint, setFocusedPoint] = useState<JobResourceTrendPoint | null>(null);
  useEffect(() => setFocusedPoint(null), [selectedRunId]);
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
  const definition = useMemo(() => {
    const normalAverage = rows.filter((row) => row.series === "Average" && !isOutcomeDegraded(row.point) && row.telemetryState === "available");
    const normalPeak = rows.filter((row) => row.series === "Peak" && !isOutcomeDegraded(row.point) && row.telemetryState === "available");
    return defineChart({
      marks: [
        lineY(rows, { id: "cpu-lines", x: "position", y: "value", z: "segment", color: "series", key: (row) => `${row.runId}-${row.series}` }),
        dotMark(normalAverage, "cpu-average-markers", CPU_AVERAGE, CPU_AVERAGE, selectedRunId),
        dotMark(normalPeak, "cpu-peak-markers", CPU_PEAK, CPU_PEAK, selectedRunId),
        ...classifiedDotMarks(rows, "cpu", selectedRunId),
      ],
      x: { scale: orderedRunPointScale(labels), axis: { label: "Completed runs", ticks: { format: (position: string) => labels.get(position) ?? position } } },
      y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "CPU", ticks: { format: (value: number) => formatPercent(Number(value), 0) } } },
      color: {
        scale: () => scaleOrdinal<string, string>().domain(["Average", "Peak"]).range([CPU_AVERAGE, CPU_PEAK]),
        legend: colorLegend({ label: "CPU series" }),
      },
      focus: "group-x",
      tooltip: { use: tooltip, anchor: "group-center", placement: tooltipPlacement, sort: "color-domain", content: resourceTooltip },
    });
  }, [labels, rows, selectedRunId]);
  const summary = points.map((point) => `${formatDate(point.completedAt)}, ${outcomeLabel(point.outcome)}, ${point.telemetryState} telemetry: average ${formatPercent(point.cpuAveragePercent)}, peak ${formatPercent(point.cpuPeakPercent)}`).join("; ");
  const activePoint = focusedPoint ?? selectedPoint(points, selectedRunId);

  return (
    <ChartPanel label="CPU usage over completed runs">
      {rows.length === 0
        ? <p className="chart-empty">CPU telemetry is unavailable for these runs.</p>
        : <div className="chart-frame"><Chart definition={definition} height={240} ariaLabel="CPU usage over completed runs" ariaDescription={summary}
          onFocusChange={(point) => setFocusedPoint((current) => retainChartFocus(current, point?.datum.point ?? null))}
          onSelect={(point) => { if (point) { setFocusedPoint(point.datum.point); onSelectRun(point.datum.runId); } }} /></div>}
      <ChartRunDetails point={activePoint} focused={focusedPoint !== null} />
    </ChartPanel>
  );
}

export function MemoryTrendChart({ points, selectedRunId, onSelectRun }: ResourceChartProps): ReactNode {
  const [focusedPoint, setFocusedPoint] = useState<JobResourceTrendPoint | null>(null);
  useEffect(() => setFocusedPoint(null), [selectedRunId]);
  const hasPeakTelemetry = points.some((point) => point.memoryPeakBytes !== null);
  const rows = useMemo<MemoryRow[]>(() => {
    const result: MemoryRow[] = [];
    let peakSegment = 0;
    points.forEach((point, index) => {
      const common = sharedRow(point, index);
      if (point.memoryPeakBytes === null) peakSegment += 1;
      else result.push({ ...common, series: "Peak", segment: `Peak-${peakSegment}`, value: point.memoryPeakBytes });
      result.push({ ...common, series: "Requested", segment: "Requested-0", value: point.requestedMemoryBytes });
    });
    return result;
  }, [points]);
  const labels = useMemo(() => positionLabels(points), [points]);
  const definition = useMemo(() => {
    const normalPeak = rows.filter((row) => row.series === "Peak" && !isOutcomeDegraded(row.point) && row.telemetryState === "available");
    const normalRequested = rows.filter((row) => row.series === "Requested" && !isOutcomeDegraded(row.point) && row.telemetryState === "available");
    return defineChart({
      marks: [
        lineY(rows, { id: "memory-lines", x: "position", y: "value", z: "segment", color: "series", key: (row) => `${row.runId}-${row.series}` }),
        dotMark(normalPeak, "memory-peak-markers", MEMORY_PEAK, MEMORY_PEAK, selectedRunId),
        dotMark(normalRequested, "memory-requested-markers", REQUESTED_MEMORY, REQUESTED_MEMORY, selectedRunId),
        ...classifiedDotMarks(rows, "memory", selectedRunId),
      ],
      x: { scale: orderedRunPointScale(labels), axis: { label: "Completed runs", ticks: { format: (position: string) => labels.get(position) ?? position } } },
      y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Memory", ticks: { format: (value: number) => formatBytes(Number(value)) } } },
      color: {
        scale: () => scaleOrdinal<string, string>().domain(["Peak", "Requested"]).range([MEMORY_PEAK, REQUESTED_MEMORY]),
        legend: colorLegend({ label: "Memory series" }),
      },
      focus: "group-x",
      tooltip: { use: tooltip, anchor: "group-center", placement: tooltipPlacement, sort: "color-domain", content: resourceTooltip },
    });
  }, [labels, rows, selectedRunId]);
  const summary = points.map((point) => `${formatDate(point.completedAt)}, ${outcomeLabel(point.outcome)}, ${point.telemetryState} telemetry: peak ${formatBytes(point.memoryPeakBytes)}, requested ${formatBytes(point.requestedMemoryBytes)}`).join("; ");
  const activePoint = focusedPoint ?? selectedPoint(points, selectedRunId);

  return (
    <ChartPanel label="Peak memory over completed runs">
      {!hasPeakTelemetry && <p className="chart-note">Memory telemetry is unavailable for these runs. Requested memory is shown.</p>}
      {points.length > 0 && <div className="chart-frame"><Chart definition={definition} height={240} ariaLabel="Peak memory over completed runs" ariaDescription={summary}
        onFocusChange={(point) => setFocusedPoint((current) => retainChartFocus(current, point?.datum.point ?? null))}
        onSelect={(point) => { if (point) { setFocusedPoint(point.datum.point); onSelectRun(point.datum.runId); } }} /></div>}
      <ChartRunDetails point={activePoint} focused={focusedPoint !== null} />
    </ChartPanel>
  );
}

export function DurationTrendChart({ points, selectedRunId, onSelectRun }: ResourceChartProps): ReactNode {
  const [focusedPoint, setFocusedPoint] = useState<JobResourceTrendPoint | null>(null);
  useEffect(() => setFocusedPoint(null), [selectedRunId]);
  const rows = useMemo<DurationRow[]>(() => points.map((point, index) => ({ ...sharedRow(point, index), value: point.executionDurationMs })), [points]);
  const labels = useMemo(() => positionLabels(points), [points]);
  const definition = useMemo(() => {
    const normal = rows.filter((row) => !isOutcomeDegraded(row.point) && row.telemetryState === "available");
    return defineChart({
      marks: [
        barY(rows, {
          id: "duration-bars",
          x: "position",
          y: "value",
          fill: (row) => isOutcomeDegraded(row.point) ? DEGRADED : DURATION,
          radius: 2,
        }),
        dotMark(normal, "duration-normal-markers", DURATION, DURATION, selectedRunId),
        ...classifiedDotMarks(rows, "duration", selectedRunId),
      ],
      x: { scale: orderedRunBandScale(labels), axis: { label: "Completed runs", ticks: { format: (position: string) => labels.get(position) ?? position } } },
      y: { scale: scaleLinear, nice: true, grid: true, axis: { label: "Duration", ticks: { format: (value: number) => formatDuration(Number(value)) } } },
      focus: "group-x",
      tooltip: { use: tooltip, anchor: "group-center", placement: tooltipPlacement, content: resourceTooltip },
    });
  }, [labels, rows, selectedRunId]);
  const summary = points.map((point) => `${formatDate(point.completedAt)}, ${outcomeLabel(point.outcome)}, ${point.telemetryState} telemetry: ${formatDuration(point.executionDurationMs)}`).join("; ");
  const activePoint = focusedPoint ?? selectedPoint(points, selectedRunId);

  return (
    <ChartPanel label="Execution duration over completed runs">
      {rows.length === 0
        ? <p className="chart-empty">No completed runs in this window.</p>
        : <div className="chart-frame"><Chart definition={definition} height={240} ariaLabel="Execution duration over completed runs" ariaDescription={summary}
          onFocusChange={(point) => setFocusedPoint((current) => retainChartFocus(current, point?.datum.point ?? null))}
          onSelect={(point) => { if (point) { setFocusedPoint(point.datum.point); onSelectRun(point.datum.runId); } }} /></div>}
      <ChartRunDetails point={activePoint} focused={focusedPoint !== null} />
    </ChartPanel>
  );
}
