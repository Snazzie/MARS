import type { AiTokenUsage } from "@mars/contracts";
import type { PipelineAnalysisMetrics } from "@mars/contracts";

export interface PipelineFailureAnalysisUsageRow {
  model?: string | null;
  providerKind?: string | null;
  calledAt: string | Date | null;
  inputTokens: number | null;
  outputTokens: number | null;
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  estimatedCostUsd?: number | null;
}

function safeSum(target: number, value: number): number {
  const sum = target + value;
  if (!Number.isSafeInteger(sum)) throw new Error("AI token totals exceed safe integer range");
  return sum;
}

function reportedCount(value: number | null): number | null {
  return Number.isSafeInteger(value) && value! >= 0 ? value : null;
}

export function estimateAiRequestCost(row: PipelineFailureAnalysisUsageRow): number | null {
  if (row.providerKind === "lm-studio") return 0;
  if (row.estimatedCostUsd !== undefined) return row.estimatedCostUsd !== null && Number.isFinite(row.estimatedCostUsd) && row.estimatedCostUsd >= 0 ? row.estimatedCostUsd : null;
  const inputPrice = row.inputUsdPerMillionTokens, outputPrice = row.outputUsdPerMillionTokens;
  if (inputPrice === null || outputPrice === null || !Number.isFinite(inputPrice) || !Number.isFinite(outputPrice) || inputPrice < 0 || outputPrice < 0) return null;
  if (inputPrice === 0 && outputPrice === 0) return 0;
  const input = reportedCount(row.inputTokens), output = reportedCount(row.outputTokens);
  if (input === null || output === null) return null;
  const cost = input * inputPrice / 1_000_000 + output * outputPrice / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

export interface PipelineAnalysisMetricsRow extends PipelineFailureAnalysisUsageRow {
  state: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  tokensPerSecond?: number | null;
}

export function getPipelineAnalysisMetrics(row: PipelineAnalysisMetricsRow, now = Date.now()): PipelineAnalysisMetrics {
  const interval = (start: string | null, end: string | number | null): number | null => {
    if (start === null || end === null) return null;
    const value = (typeof end === "number" ? end : Date.parse(end)) - Date.parse(start);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const input = reportedCount(row.inputTokens), output = reportedCount(row.outputTokens);
  const total = input === null || output === null || !Number.isSafeInteger(input + output) ? null : input + output;
  return {
    queuedAt: row.queuedAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    providerCalledAt: row.calledAt instanceof Date ? row.calledAt.toISOString() : row.calledAt,
    queueWaitMs: interval(row.queuedAt, row.startedAt ?? row.finishedAt ?? (row.state === "pending" ? now : null)),
    durationMs: interval(row.startedAt, row.finishedAt ?? (row.state === "running" ? now : null)),
    tokensPerSecond: row.tokensPerSecond ?? null,
    usage: { input, output, total },
    estimatedCostUsd: row.calledAt === null ? null : estimateAiRequestCost(row),
  };
}

function aggregateUsageTotals(rows: readonly PipelineFailureAnalysisUsageRow[], now: Date): Omit<AiTokenUsage, "models" | "performance"> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const firstDay = new Date(today);
  firstDay.setUTCDate(firstDay.getUTCDate() - 29);
  const daily = new Map<string, { inputTokens: number; outputTokens: number; estimatedCostUsd: number; costKnown: boolean }>();
  for (let offset = 0; offset < 30; offset++) {
    const date = new Date(firstDay);
    date.setUTCDate(firstDay.getUTCDate() + offset);
    daily.set(date.toISOString().slice(0, 10), { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, costKnown: true });
  }

  let inputTokens = 0, outputTokens = 0, reportedRequests = 0, unreportedRequests = 0, unpricedRequests = 0;
  let estimatedCostUsd = 0, totalCostKnown = true;
  for (const row of rows) {
    if (!row.calledAt) continue;
    const date = new Date(row.calledAt).toISOString().slice(0, 10);
    const point = daily.get(date);
    if (!point) continue;
    const hasInput = Number.isSafeInteger(row.inputTokens) && (row.inputTokens ?? -1) >= 0;
    const hasOutput = Number.isSafeInteger(row.outputTokens) && (row.outputTokens ?? -1) >= 0;
    if (!hasInput || !hasOutput) {
      unreportedRequests = safeSum(unreportedRequests, 1);
      if (row.inputUsdPerMillionTokens !== 0 || row.outputUsdPerMillionTokens !== 0) {
        unpricedRequests = safeSum(unpricedRequests, 1);
        point.costKnown = false;
        totalCostKnown = false;
      }
      continue;
    }
    reportedRequests = safeSum(reportedRequests, 1);
    const input = row.inputTokens!, output = row.outputTokens!;
    inputTokens = safeSum(inputTokens, input);
    outputTokens = safeSum(outputTokens, output);
    point.inputTokens = safeSum(point.inputTokens, input);
    point.outputTokens = safeSum(point.outputTokens, output);
    const cost = estimateAiRequestCost(row);
    if (cost !== null) {
      point.estimatedCostUsd += cost;
      estimatedCostUsd += cost;
    } else {
      unpricedRequests = safeSum(unpricedRequests, 1);
      point.costKnown = false;
      totalCostKnown = false;
    }
  }
  return {
    points: [...daily].map(([date, point]) => ({ date, inputTokens: point.inputTokens, outputTokens: point.outputTokens, estimatedCostUsd: point.costKnown ? point.estimatedCostUsd : null })),
    inputTokens, outputTokens, reportedRequests, unreportedRequests,
    estimatedCostUsd: totalCostKnown ? estimatedCostUsd : null,
    unpricedRequests,
  };
}

export function aggregateAiRunPerformance(rows: readonly { queuedAt: string; startedAt: string | null; finishedAt: string | null }[]): AiTokenUsage["performance"] {
  const starts: number[] = [], completions: number[] = [];
  for (const row of rows) {
    const queued = Date.parse(row.queuedAt);
    const started = row.startedAt === null ? NaN : Date.parse(row.startedAt);
    const finished = row.finishedAt === null ? NaN : Date.parse(row.finishedAt);
    if (Number.isSafeInteger(started - queued) && started >= queued) starts.push(started - queued);
    if (Number.isSafeInteger(finished - started) && finished >= started && started >= queued) completions.push(finished - started);
  }
  const percentiles = (values: number[]) => {
    values.sort((a, b) => a - b);
    return { sampleCount: values.length, p50Ms: values.length ? values[Math.ceil(values.length * 0.5) - 1]! : null, p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1]! : null };
  };
  return { timeToStart: percentiles(starts), timeToComplete: percentiles(completions) };
}

export function aggregateAiTokenUsage(rows: readonly PipelineFailureAnalysisUsageRow[], now = new Date()): AiTokenUsage {
  const groups = new Map<string, PipelineFailureAnalysisUsageRow[]>();
  const normalized = rows.map(row => row.providerKind === "lm-studio"
    ? { ...row, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0, estimatedCostUsd: 0 }
    : row);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const firstDay = today - 29 * 86_400_000;
  for (const row of normalized) {
    const calledAt = row.calledAt ? new Date(row.calledAt).getTime() : NaN;
    if (!(calledAt >= firstDay && calledAt < today + 86_400_000)) continue;
    const model = row.model || "Unknown model";
    const group = groups.get(model);
    if (group) group.push(row);
    else groups.set(model, [row]);
  }
  return {
    ...aggregateUsageTotals(normalized, now),
    performance: aggregateAiRunPerformance([]),
    models: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([model, calls]) => ({
      model, ...aggregateUsageTotals(calls, now),
    })),
  };
}
