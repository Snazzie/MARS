import type { OverviewCostSavings, OverviewDto } from "@mars/contracts";
import type { DatabaseClient } from "./index.ts";

export type GithubRunnerPlatform = "linux-x64" | "windows-x64" | "macos-arm64";
export type GithubRunnerRate = Readonly<{ platform: GithubRunnerPlatform; vcpu: number; sku: string; rateMicros: number }>;
export type GithubRunnerRateSchedule = Readonly<{ effectiveFrom: string; sourceUrl: string; rates: readonly GithubRunnerRate[] }>;
export type GithubRunnerUsageGroup = Readonly<{ usageDate: string; platform: string; requestedVcpu: number; billableMinutes: number }>;

const githubPricingUrl = "https://docs.github.com/en/billing/reference/actions-runner-pricing";

export const GITHUB_HOSTED_RATE_SCHEDULES: readonly GithubRunnerRateSchedule[] = Object.freeze([{
  effectiveFrom: "2026-01-01",
  sourceUrl: githubPricingUrl,
  // Effective date corroborated by https://github.blog/changelog/2026-01-01-reduced-pricing-for-github-hosted-runners-usage/.
  rates: Object.freeze<GithubRunnerRate[]>([
    { platform: "linux-x64", vcpu: 1, sku: "actions_linux_slim", rateMicros: 2_000 },
    { platform: "linux-x64", vcpu: 2, sku: "actions_linux", rateMicros: 6_000 },
    { platform: "linux-x64", vcpu: 4, sku: "linux_4_core", rateMicros: 12_000 },
    { platform: "linux-x64", vcpu: 8, sku: "linux_8_core", rateMicros: 22_000 },
    { platform: "linux-x64", vcpu: 16, sku: "linux_16_core", rateMicros: 42_000 },
    { platform: "linux-x64", vcpu: 32, sku: "linux_32_core", rateMicros: 82_000 },
    { platform: "linux-x64", vcpu: 64, sku: "linux_64_core", rateMicros: 162_000 },
    { platform: "linux-x64", vcpu: 96, sku: "linux_96_core", rateMicros: 252_000 },
    { platform: "windows-x64", vcpu: 2, sku: "actions_windows", rateMicros: 10_000 },
    { platform: "windows-x64", vcpu: 4, sku: "windows_4_core", rateMicros: 22_000 },
    { platform: "windows-x64", vcpu: 8, sku: "windows_8_core", rateMicros: 42_000 },
    { platform: "windows-x64", vcpu: 16, sku: "windows_16_core", rateMicros: 82_000 },
    { platform: "windows-x64", vcpu: 32, sku: "windows_32_core", rateMicros: 162_000 },
    { platform: "windows-x64", vcpu: 64, sku: "windows_64_core", rateMicros: 322_000 },
    { platform: "windows-x64", vcpu: 96, sku: "windows_96_core", rateMicros: 552_000 },
    { platform: "macos-arm64", vcpu: 4, sku: "actions_macos", rateMicros: 62_000 },
    { platform: "macos-arm64", vcpu: 5, sku: "macos_xl", rateMicros: 102_000 },
  ]),
}]);

const emptySavings = (): OverviewCostSavings => ({ selfHostedMinutes: 0, pricedMinutes: 0, unpricedMinutes: 0, estimatedSavingsMicros: 0, currency: "USD", latestRateEffectiveFrom: null });

export function calculateGithubRunnerCostSavings(usage: readonly GithubRunnerUsageGroup[], schedules: readonly GithubRunnerRateSchedule[] = GITHUB_HOSTED_RATE_SCHEDULES): OverviewCostSavings {
  let selfHostedMinutes = 0;
  let pricedMinutes = 0;
  let estimatedSavingsMicros = 0;
  let latestRateEffectiveFrom: string | null = null;
  for (const group of usage) {
    const minutes = Math.max(0, Math.floor(group.billableMinutes));
    selfHostedMinutes += minutes;
    const schedule = schedules.filter((candidate) => candidate.effectiveFrom <= group.usageDate).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const rate = schedule?.rates.filter((candidate) => candidate.platform === group.platform && candidate.vcpu >= group.requestedVcpu).sort((a, b) => a.vcpu - b.vcpu)[0];
    if (!rate) continue;
    pricedMinutes += minutes;
    estimatedSavingsMicros += minutes * rate.rateMicros;
    if (!latestRateEffectiveFrom || schedule.effectiveFrom > latestRateEffectiveFrom) latestRateEffectiveFrom = schedule.effectiveFrom;
  }
  return { ...emptySavings(), selfHostedMinutes, pricedMinutes, unpricedMinutes: selfHostedMinutes - pricedMinutes, estimatedSavingsMicros, latestRateEffectiveFrom };
}

const periodInterval = (period: OverviewDto["period"]) => period === "24h" ? "24 hours" : period === "7d" ? "7 days" : "30 days";

export async function getGithubRunnerCostSavings(db: DatabaseClient, organizationId: string, period: OverviewDto["period"], userId?: string): Promise<OverviewCostSavings> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT (completed_at AT TIME ZONE 'UTC')::date::text AS "usageDate", platform, requested_vcpu AS "requestedVcpu",
      SUM(GREATEST(1, CEIL(execution_duration_ms / 60000.0)))::bigint AS "billableMinutes"
    FROM dashboard_job_timing_snapshots
    WHERE completed_at >= now() - (${periodInterval(period)})::interval
      AND ((${organizationId === "all"} AND organization_id IN (SELECT organization_id FROM memberships WHERE user_id=${userId ?? null}))
        OR (${organizationId !== "all"} AND organization_id=${organizationId === "all" ? null : organizationId}::uuid))
    GROUP BY (completed_at AT TIME ZONE 'UTC')::date, platform, requested_vcpu
  `;
  return calculateGithubRunnerCostSavings(rows.map((row) => ({ usageDate: String(row.usageDate), platform: String(row.platform), requestedVcpu: Number(row.requestedVcpu), billableMinutes: Number(row.billableMinutes) })));
}
