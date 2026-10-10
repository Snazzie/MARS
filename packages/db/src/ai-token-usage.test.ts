import { expect, test } from "bun:test";
import { aggregateAiTokenUsage, aggregateAiRunPerformance, getPipelineAnalysisMetrics, type PipelineAnalysisMetricsRow, type PipelineFailureAnalysisUsageRow } from "./ai-token-usage.ts";

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

test("model lines combine pipeline and review calls while keeping unknown cloud costs separate from free LM Studio", () => {
  const usage = aggregateAiTokenUsage([
    row({ model: "cloud", providerKind: "anthropic" }),
    row({ model: "cloud", estimatedCostUsd: 0.5, inputUsdPerMillionTokens: null, outputUsdPerMillionTokens: null }),
    row({ model: "unpriced", inputUsdPerMillionTokens: null }),
    row({ model: "local", providerKind: "lm-studio", estimatedCostUsd: 8 }),
    row({ model: "local", providerKind: "lm-studio", inputTokens: null, outputTokens: null, estimatedCostUsd: null, inputUsdPerMillionTokens: null, outputUsdPerMillionTokens: null }),
    row({ model: "outside", calledAt: "2026-09-07T23:59:59Z" }),
  ], now);
  expect(usage.models.map(model => model.model)).toEqual(["cloud", "local", "unpriced"]);
  expect(usage.models[0]).toMatchObject({ inputTokens: 2_000_000, outputTokens: 200_000, estimatedCostUsd: 3.5, reportedRequests: 2 });
  expect(usage.models[0]!.points.at(-1)).toEqual({ date: "2026-10-07", inputTokens: 2_000_000, outputTokens: 200_000, estimatedCostUsd: 3.5 });
  expect(usage.models[1]).toMatchObject({ estimatedCostUsd: 0, unreportedRequests: 1, unpricedRequests: 0 });
  expect(usage.models[1]!.points.at(-1)?.estimatedCostUsd).toBe(0);
  expect(usage.models[2]).toMatchObject({ estimatedCostUsd: null, unpricedRequests: 1 });
  expect(usage).toMatchObject({ estimatedCostUsd: null, unpricedRequests: 1, unreportedRequests: 1 });
});

const analysis = (changes: Partial<PipelineAnalysisMetricsRow> = {}): PipelineAnalysisMetricsRow => ({
  ...row(), state: "completed", queuedAt: "2026-10-07T01:00:00.000Z",
  startedAt: "2026-10-07T01:00:05.000Z", finishedAt: "2026-10-07T01:00:25.000Z", ...changes,
});

test("analysis queue wait and processing time advance only while their phase is active", () => {
  const now = Date.parse("2026-10-07T01:00:20.000Z");
  expect(getPipelineAnalysisMetrics(analysis({ state: "pending", startedAt: null, finishedAt: null, calledAt: null, inputTokens: null, outputTokens: null }), now)).toMatchObject({
    queueWaitMs: 20_000, durationMs: null, estimatedCostUsd: null, usage: { input: null, output: null, total: null },
  });
  expect(getPipelineAnalysisMetrics(analysis({ state: "running", finishedAt: null }), now)).toMatchObject({ queueWaitMs: 5_000, durationMs: 15_000 });
  const completed = getPipelineAnalysisMetrics(analysis(), now + 60_000);
  expect(completed).toMatchObject({ queueWaitMs: 5_000, durationMs: 20_000, usage: { input: 1_000_000, output: 100_000, total: 1_100_000 }, estimatedCostUsd: 3 });
  expect(getPipelineAnalysisMetrics(analysis(), now + 120_000)).toEqual(completed);
  expect(getPipelineAnalysisMetrics(analysis({ state: "failed" }), now)).toMatchObject({ estimatedCostUsd: 3, durationMs: 20_000 });
});

test("missing usage and captured pricing do not masquerade as zero spend", () => {
  expect(getPipelineAnalysisMetrics(analysis({ inputTokens: null, outputTokens: null }))).toMatchObject({ usage: { input: null, output: null, total: null }, estimatedCostUsd: null });
  expect(getPipelineAnalysisMetrics(analysis({ inputUsdPerMillionTokens: null }))).toMatchObject({ usage: { total: 1_100_000 }, estimatedCostUsd: null });
  expect(getPipelineAnalysisMetrics(analysis({ inputTokens: null, outputTokens: null, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }))).toMatchObject({ usage: { total: null }, estimatedCostUsd: 0 });
});

test("skips without a worker claim and incomplete or reversed timestamps do not invent processing time", () => {
  expect(getPipelineAnalysisMetrics(analysis({ state: "skipped", startedAt: null, calledAt: null, inputTokens: null, outputTokens: null }))).toMatchObject({ queueWaitMs: 25_000, durationMs: null, estimatedCostUsd: null });
  expect(getPipelineAnalysisMetrics(analysis({ finishedAt: null }))).toMatchObject({ queueWaitMs: 5_000, durationMs: null });
  expect(getPipelineAnalysisMetrics(analysis({ startedAt: "2026-10-07T00:59:59.000Z", finishedAt: "2026-10-07T00:59:58.000Z" }))).toMatchObject({ queueWaitMs: null, durationMs: null });
  expect(getPipelineAnalysisMetrics(analysis({ inputTokens: -1 }))).toMatchObject({ usage: { input: null, total: null }, estimatedCostUsd: null });
});

test("AI run percentiles use observed phases and exclude missing or reversed timestamps", () => {
  const queuedAt = "2026-10-07T00:00:00Z";
  const rows = Array.from({ length: 20 }, (_, index) => ({
    queuedAt, startedAt: new Date(Date.parse(queuedAt) + (index + 1) * 1_000).toISOString(),
    finishedAt: new Date(Date.parse(queuedAt) + (index + 1) * 3_000).toISOString(),
  }));
  rows.reverse();
  const performance = aggregateAiRunPerformance([
    ...rows,
    { queuedAt, startedAt: null, finishedAt: null },
    { queuedAt, startedAt: "2026-10-06T23:59:59Z", finishedAt: queuedAt },
    { queuedAt, startedAt: queuedAt, finishedAt: "2026-10-06T23:59:59Z" },
    { queuedAt, startedAt: "2026-10-07T00:01:00Z", finishedAt: null },
  ]);
  expect(performance).toEqual({
    timeToStart: { sampleCount: 22, p50Ms: 10_000, p95Ms: 20_000 },
    timeToComplete: { sampleCount: 20, p50Ms: 20_000, p95Ms: 38_000 },
  });
  expect(aggregateAiRunPerformance([])).toEqual({
    timeToStart: { sampleCount: 0, p50Ms: null, p95Ms: null },
    timeToComplete: { sampleCount: 0, p50Ms: null, p95Ms: null },
  });
});
