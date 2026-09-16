import { expect, test } from "bun:test";
import { calculateGithubRunnerCostSavings, getGithubRunnerCostSavings, GITHUB_HOSTED_RATE_SCHEDULES, type GithubRunnerRateSchedule } from "./github-runner-cost.ts";

test("calculator selects closest compatible same-platform runner with integer arithmetic", () => {
  const result = calculateGithubRunnerCostSavings([
    { usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 2, billableMinutes: 2 },
    { usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 3, billableMinutes: 1 },
  ]);
  expect(result).toEqual({ selfHostedMinutes: 3, pricedMinutes: 3, unpricedMinutes: 0, estimatedSavingsMicros: 42_000, currency: "USD", latestRateEffectiveFrom: "2026-01-01" });
});

test("dated schedules change rates exactly on effective date", () => {
  const later: GithubRunnerRateSchedule = { effectiveFrom: "2026-02-01", sourceUrl: "https://example.test/rate", rates: [{ platform: "windows-x64", vcpu: 2, sku: "new", rateMicros: 20_000 }] };
  const result = calculateGithubRunnerCostSavings([
    { usageDate: "2026-01-31", platform: "windows-x64", requestedVcpu: 2, billableMinutes: 1 },
    { usageDate: "2026-02-01", platform: "windows-x64", requestedVcpu: 2, billableMinutes: 1 },
  ], [...GITHUB_HOSTED_RATE_SCHEDULES, later]);
  expect(result.estimatedSavingsMicros).toBe(30_000);
  expect(result.latestRateEffectiveFrom).toBe("2026-02-01");
});

test("missing schedules and oversized requests remain explicitly unpriced", () => {
  const result = calculateGithubRunnerCostSavings([
    { usageDate: "2025-12-31", platform: "windows-x64", requestedVcpu: 2, billableMinutes: 2 },
    { usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 97, billableMinutes: 3 },
  ]);
  expect(result).toMatchObject({ selfHostedMinutes: 5, pricedMinutes: 0, unpricedMinutes: 5, estimatedSavingsMicros: 0, latestRateEffectiveFrom: null });
});

test("query groups rounded completed Mars snapshots and constrains aggregate membership", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [{ usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 2, billableMinutes: 4 }];
  }) as never;
  const result = await getGithubRunnerCostSavings(db, "all", "7d", "user-1");
  expect(result.estimatedSavingsMicros).toBe(40_000);
  expect(queries[0]).toContain("GREATEST(1, CEIL(execution_duration_ms / 60000.0))");
  expect(queries[0]).toContain("FROM dashboard_job_timing_snapshots");
  expect(queries[0]).toContain("memberships WHERE user_id");
  expect(queries[0]).toContain("GROUP BY (completed_at AT TIME ZONE 'UTC')::date, platform, requested_vcpu");
});
