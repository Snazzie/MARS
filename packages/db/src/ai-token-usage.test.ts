import { expect, test } from "bun:test";
import { aggregateAiTokenUsage, type PipelineFailureAnalysisUsageRow } from "./ai-token-usage.ts";

const now = new Date("2026-10-07T15:00:00Z");
const row = (changes: Partial<PipelineFailureAnalysisUsageRow> = {}): PipelineFailureAnalysisUsageRow => ({
  calledAt: "2026-10-07T01:00:00Z", inputTokens: 1_000_000, outputTokens: 100_000,
  inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10, ...changes,
});

test("groups actual calls by UTC date within the inclusive 30-day window", () => {
  const usage = aggregateAiTokenUsage([
    row({ calledAt: "2026-09-08T00:00:00Z" }),
    row({ calledAt: "2026-10-07T23:30:00-01:00" }),
    row({ calledAt: "2026-09-07T23:59:59Z" }),
    row({ calledAt: null }),
  ], now);
  expect(usage.inputTokens).toBe(1_000_000);
  expect(usage.outputTokens).toBe(100_000);
  expect(usage.reportedRequests).toBe(1);
  expect(usage.estimatedCostUsd).toBe(3);
  expect(usage.points[0]).toEqual({ date: "2026-09-08", inputTokens: 1_000_000, outputTokens: 100_000, estimatedCostUsd: 3 });
  expect(usage.points.at(-1)).toEqual({ date: "2026-10-07", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
});

test("missing usage stays unknown while local zero rates retain zero API cost", () => {
  const usage = aggregateAiTokenUsage([row({ inputTokens: null, outputTokens: null, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 })], now);
  expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 0, reportedRequests: 0, unreportedRequests: 1, unpricedRequests: 0, estimatedCostUsd: 0 });
});

test("unpriced cloud calls invalidate cost totals without discarding known token totals", () => {
  const usage = aggregateAiTokenUsage([row(), row({ inputUsdPerMillionTokens: null }), row({ inputTokens: null, outputTokens: null })], now);
  expect(usage).toMatchObject({ inputTokens: 2_000_000, outputTokens: 200_000, reportedRequests: 2, unreportedRequests: 1, unpricedRequests: 2, estimatedCostUsd: null });
  expect(usage.points.at(-1)?.estimatedCostUsd).toBeNull();
});

test("rates snapshotted on different calls contribute independently", () => {
  const usage = aggregateAiTokenUsage([row(), row({ inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 20 })], now);
  expect(usage.estimatedCostUsd).toBe(9);
  expect(usage.points.at(-1)?.estimatedCostUsd).toBe(9);
});
