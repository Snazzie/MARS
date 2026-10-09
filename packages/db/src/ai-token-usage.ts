import type { AiTokenUsage } from "@mars/contracts";
import type { PipelineAnalysisMetrics } from "@mars/contracts";

export interface PipelineFailureAnalysisUsageRow {
  calledAt: string | Date | null;
  inputTokens: number | null;
  outputTokens: number | null;
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
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
    usage: { input, output, total },
    estimatedCostUsd: row.calledAt === null ? null : estimateAiRequestCost(row),
  };
}

export function aggregateAiTokenUsage(rows: readonly PipelineFailureAnalysisUsageRow[], now = new Date()): AiTokenUsage {
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
