import { expect, test } from "bun:test";
import { calculateGithubRunnerCostCenter, calculateGithubRunnerCostSavings, getGithubRunnerCostCenter, getGithubRunnerCostSavings, GITHUB_HOSTED_RATE_SCHEDULES, type GithubRunnerRateSchedule } from "./github-runner-cost.ts";

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
test("cost center merges repository and runner rows with explicit unmatched usage", () => {
  const result = calculateGithubRunnerCostCenter([
    { organizationId: "org", repositoryId: "repo-b", repositoryName: "zeta", usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 3, jobCount: 1, billableMinutes: 2 },
    { organizationId: "org", repositoryId: "repo-a", repositoryName: "alpha", usageDate: "2026-01-02", platform: "linux-x64", requestedVcpu: 2, jobCount: 2, billableMinutes: 3 },
    { organizationId: "org", repositoryId: "repo-a", repositoryName: "alpha", usageDate: "2025-12-31", platform: "linux-x64", requestedVcpu: 2, jobCount: 1, billableMinutes: 1 },
  ]);
  expect(result.breakdown.map((row) => [row.repositoryName, row.githubRunnerSku])).toEqual([["zeta", "windows_4_core"], ["alpha", "actions_linux"], ["alpha", null]]);
  expect(result.costSavings.selfHostedMinutes).toBe(6);
  expect(result.costSavings.estimatedSavingsMicros).toBe(62_000);
  expect(result.breakdown.reduce((sum, row) => sum + row.estimatedSavingsMicros, 0)).toBe(result.costSavings.estimatedSavingsMicros);
});

test("cost center query preserves repository/date/platform/vcpu grouping and membership scope", async () => {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [{ organizationId: "org-1", repositoryId: "repo-1", repositoryName: "app", usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 3, jobCount: 1, billableMinutes: 2 }];
  }) as never;
  const result = await getGithubRunnerCostCenter(db, "all", "7d", "user-1");
  expect(result.breakdown[0]?.githubRunnerSku).toBe("windows_4_core");
  expect(queries[0]).toContain("COUNT(*)");
  expect(queries[0]).toContain("GREATEST(1, CEIL(execution_duration_ms / 60000.0))");
  expect(queries[0]).toContain("repository_id, repository_name");
  expect(queries[0]).toContain("memberships WHERE user_id");
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
