import { expect, test } from "bun:test";
import { calculateGithubExternalCostCenter, calculateGithubRunnerCostCenter, calculateGithubRunnerCostSavings, getGithubRunnerCostCenter, getGithubRunnerCostSavings, AZURE_VM_RATE_SCHEDULES, GITHUB_HOSTED_RATE_SCHEDULES, type GithubRunnerRateSchedule } from "./github-runner-cost.ts";
import { preparedTestDatabase } from "./prepared-test-fixture.ts";

function fakeDb(results: Record<string, Record<string, unknown>[]>) {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  const db = preparedTestDatabase((name, params) => {
    calls.push({ name, params });
    return results[name] ?? [];
  });
  return { db, calls };
}


test("calculator selects closest compatible same-platform runner with integer arithmetic", () => {
  const result = calculateGithubRunnerCostSavings([
    { usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 2, billableMinutes: 2 },
    { usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 3, billableMinutes: 1 },
  ]);
  expect(result).toEqual({ selfHostedMinutes: 3, pricedMinutes: 3, unpricedMinutes: 0, estimatedSavingsMicros: 42_000, currency: "USD", latestRateEffectiveFrom: "2026-01-01" });
});

test("GitHub Ubuntu rates price Linux ARM64 jobs at the matching vCPU tier", () => {
  const result = calculateGithubRunnerCostCenter([
    { organizationId: "org", repositoryId: "repo", repositoryName: "app", usageDate: "2026-01-02", platform: "linux-arm64", requestedVcpu: 3, jobCount: 1, billableMinutes: 10 },
  ]);
  expect(result.breakdown[0]).toMatchObject({ platform: "linux-arm64", githubRunnerSku: "linux_4_core", githubRunnerVcpu: 4, pricedMinutes: 10, unpricedMinutes: 0, estimatedSavingsMicros: 120_000 });
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

test("Azure VM pricing resolves supported Linux and Windows runner sizes including Ubuntu ARM64", () => {
  const result = calculateGithubRunnerCostSavings([
    { usageDate: "2026-01-02", platform: "linux-x64", requestedVcpu: 3, billableMinutes: 2 },
    { usageDate: "2026-01-02", platform: "linux-arm64", requestedVcpu: 2, billableMinutes: 1 },
    { usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 4, billableMinutes: 1 },
    { usageDate: "2026-01-02", platform: "macos-arm64", requestedVcpu: 4, billableMinutes: 1 },
  ], AZURE_VM_RATE_SCHEDULES);
  expect(result).toMatchObject({ selfHostedMinutes: 5, pricedMinutes: 4, unpricedMinutes: 1, estimatedSavingsMicros: 14_400, latestRateEffectiveFrom: "2026-01-01" });
  const arm = calculateGithubRunnerCostCenter([
    { organizationId: "org", repositoryId: "repo", repositoryName: "app", usageDate: "2026-01-02", platform: "linux-arm64", requestedVcpu: 2, jobCount: 1, billableMinutes: 1 },
  ], AZURE_VM_RATE_SCHEDULES);
  expect(arm.breakdown[0]).toMatchObject({ githubRunnerSku: "Standard_D2ps_v5", githubRunnerVcpu: 2, pricedMinutes: 1, unpricedMinutes: 0 });
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
test("external calculator estimates detected hosted jobs without affecting Mars savings", () => {
  const result = calculateGithubExternalCostCenter([
    { organizationId: "org", repositoryId: "repo", repositoryName: "app", usageDate: "2026-01-02", platform: "linux-x64", requestedVcpu: 4, jobCount: 2, billableMinutes: 3 },
  ]);
  expect(result).toMatchObject({ externalMinutes: 3, externalPricedMinutes: 3, externalUnpricedMinutes: 0, estimatedExternalCostMicros: 36_000 });
  expect(result.externalBreakdown[0]).toMatchObject({ githubRunnerSku: "linux_4_core", estimatedCostMicros: 36_000 });
});

test("cost center query returns grouped pricing and retains aggregate user scope", async () => {
  const { db, calls } = fakeDb({
    github_runner_cost_center: [{ organizationId: "org-1", repositoryId: "repo-1", repositoryName: "app", usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 3, jobCount: 1, billableMinutes: 2 }],
  });
  const result = await getGithubRunnerCostCenter(db, "all", "7d", "user-1");
  expect(result.breakdown[0]?.githubRunnerSku).toBe("windows_4_core");
  expect(result).not.toHaveProperty("pricingProvider");
  expect(calls.filter((call) => call.name === "github_runner_cost_center")).toHaveLength(1);
  expect(calls.find((call) => call.name === "github_runner_cost_center")?.params).toMatchObject({ isAll: true, userId: "user-1", period: "7 days" });
  expect(calls.find((call) => call.name === "github_runner_external_cost_center")?.params).toMatchObject({ isAll: true, userId: "user-1", organizationId: null });
});

test("cost savings query returns rounded completed Mars usage within aggregate membership scope", async () => {
  const { db, calls } = fakeDb({
    github_runner_cost_savings: [{ usageDate: "2026-01-02", platform: "windows-x64", requestedVcpu: 2, billableMinutes: 4 }],
  });
  const result = await getGithubRunnerCostSavings(db, "all", "7d", "user-1");
  expect(result.estimatedSavingsMicros).toBe(40_000);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("github_runner_cost_savings");
  expect(calls[0]?.params).toMatchObject({ period: "7 days", isAll: true, userId: "user-1", organizationId: null });
});
