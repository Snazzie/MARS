import type { AiTokenUsage } from "@mars/contracts";

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
    if (Number.isFinite(row.inputUsdPerMillionTokens) && row.inputUsdPerMillionTokens! >= 0 && Number.isFinite(row.outputUsdPerMillionTokens) && row.outputUsdPerMillionTokens! >= 0) {
      const cost = input * row.inputUsdPerMillionTokens! / 1_000_000 + output * row.outputUsdPerMillionTokens! / 1_000_000;
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
