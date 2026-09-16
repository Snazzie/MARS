import type { CostCenterBreakdown, OverviewCostSavings, OverviewDto } from "@mars/contracts";
import type { DatabaseClient } from "./index.ts";

export type GithubRunnerPlatform = "linux-x64" | "windows-x64" | "macos-arm64";
export type GithubRunnerRate = Readonly<{ platform: GithubRunnerPlatform; vcpu: number; sku: string; rateMicros: number }>;
export type GithubRunnerRateSchedule = Readonly<{ effectiveFrom: string; sourceUrl: string; rates: readonly GithubRunnerRate[] }>;
export type GithubRunnerUsageGroup = Readonly<{ usageDate: string; platform: string; requestedVcpu: number; billableMinutes: number }>;
export type GithubRunnerCostCenterUsageGroup = Readonly<{
  organizationId: string;
  repositoryId: string;
  repositoryName: string;
  usageDate: string;
  platform: string;
  requestedVcpu: number;
  jobCount: number;
  billableMinutes: number;
}>;

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
type ResolvedGithubRate = { schedule: GithubRunnerRateSchedule; rate: GithubRunnerRate } | null;
function resolveGithubRate(usageDate: string, platform: string, requestedVcpu: number, schedules: readonly GithubRunnerRateSchedule[]): ResolvedGithubRate {
  const schedule = schedules.filter((candidate) => candidate.effectiveFrom <= usageDate).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const rate = schedule?.rates.filter((candidate) => candidate.platform === platform && candidate.vcpu >= requestedVcpu).sort((a, b) => a.vcpu - b.vcpu)[0];
  return schedule && rate ? { schedule, rate } : null;
}

export function calculateGithubRunnerCostSavings(usage: readonly GithubRunnerUsageGroup[], schedules: readonly GithubRunnerRateSchedule[] = GITHUB_HOSTED_RATE_SCHEDULES): OverviewCostSavings {
  let selfHostedMinutes = 0;
  let pricedMinutes = 0;
  let estimatedSavingsMicros = 0;
  let latestRateEffectiveFrom: string | null = null;
  for (const group of usage) {
    const minutes = Math.max(0, Math.floor(group.billableMinutes));
    selfHostedMinutes += minutes;
    const resolved = resolveGithubRate(group.usageDate, group.platform, group.requestedVcpu, schedules);
    if (!resolved) continue;
    pricedMinutes += minutes;
    estimatedSavingsMicros += minutes * resolved.rate.rateMicros;
    if (!latestRateEffectiveFrom || resolved.schedule.effectiveFrom > latestRateEffectiveFrom) latestRateEffectiveFrom = resolved.schedule.effectiveFrom;
  }
  return { ...emptySavings(), selfHostedMinutes, pricedMinutes, unpricedMinutes: selfHostedMinutes - pricedMinutes, estimatedSavingsMicros, latestRateEffectiveFrom };
}

export function calculateGithubRunnerCostCenter(usage: readonly GithubRunnerCostCenterUsageGroup[], schedules: readonly GithubRunnerRateSchedule[] = GITHUB_HOSTED_RATE_SCHEDULES): { costSavings: OverviewCostSavings; breakdown: CostCenterBreakdown[] } {
  const merged = new Map<string, CostCenterBreakdown>();
  for (const group of usage) {
    const minutes = Math.max(0, Math.floor(group.billableMinutes));
    const resolved = resolveGithubRate(group.usageDate, group.platform, group.requestedVcpu, schedules);
    const githubRunnerSku = resolved?.rate.sku ?? null;
    const githubRunnerVcpu = resolved?.rate.vcpu ?? null;
    const key = [group.organizationId, group.repositoryId, group.platform, group.requestedVcpu, githubRunnerSku, githubRunnerVcpu].join("|");
    const previous = merged.get(key);
    const pricedMinutes = resolved ? minutes : 0;
    const row: CostCenterBreakdown = previous ? {
      ...previous,
      jobCount: previous.jobCount + group.jobCount,
      selfHostedMinutes: previous.selfHostedMinutes + minutes,
      pricedMinutes: previous.pricedMinutes + pricedMinutes,
      unpricedMinutes: previous.unpricedMinutes + (minutes - pricedMinutes),
      estimatedSavingsMicros: previous.estimatedSavingsMicros + (resolved ? minutes * resolved.rate.rateMicros : 0),
    } : {
      organizationId: group.organizationId, repositoryId: group.repositoryId, repositoryName: group.repositoryName, platform: group.platform,
      requestedVcpu: group.requestedVcpu, githubRunnerSku, githubRunnerVcpu, jobCount: group.jobCount,
      selfHostedMinutes: minutes, pricedMinutes, unpricedMinutes: minutes - pricedMinutes,
      estimatedSavingsMicros: resolved ? minutes * resolved.rate.rateMicros : 0,
    };
    merged.set(key, row);
  }
  const breakdown = [...merged.values()].sort((a, b) => b.estimatedSavingsMicros - a.estimatedSavingsMicros || a.repositoryName.localeCompare(b.repositoryName) || a.platform.localeCompare(b.platform) || a.requestedVcpu - b.requestedVcpu || (a.githubRunnerSku ?? "").localeCompare(b.githubRunnerSku ?? ""));
  const costSavings = breakdown.reduce((sum, row) => ({
    ...sum,
    selfHostedMinutes: sum.selfHostedMinutes + row.selfHostedMinutes,
    pricedMinutes: sum.pricedMinutes + row.pricedMinutes,
    unpricedMinutes: sum.unpricedMinutes + row.unpricedMinutes,
    estimatedSavingsMicros: sum.estimatedSavingsMicros + row.estimatedSavingsMicros,
    latestRateEffectiveFrom: sum.latestRateEffectiveFrom,
  }), emptySavings());
  for (const group of usage) {
    const resolved = resolveGithubRate(group.usageDate, group.platform, group.requestedVcpu, schedules);
    if (resolved && (!costSavings.latestRateEffectiveFrom || resolved.schedule.effectiveFrom > costSavings.latestRateEffectiveFrom)) costSavings.latestRateEffectiveFrom = resolved.schedule.effectiveFrom;
  }
  return { costSavings, breakdown };
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

export async function getGithubRunnerCostCenter(db: DatabaseClient, organizationId: string, period: OverviewDto["period"], userId?: string): Promise<{ costSavings: OverviewCostSavings; breakdown: CostCenterBreakdown[] }> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT organization_id AS "organizationId", repository_id AS "repositoryId", repository_name AS "repositoryName",
      (completed_at AT TIME ZONE 'UTC')::date::text AS "usageDate", platform, requested_vcpu AS "requestedVcpu",
      COUNT(*)::bigint AS "jobCount", SUM(GREATEST(1, CEIL(execution_duration_ms / 60000.0)))::bigint AS "billableMinutes"
    FROM dashboard_job_timing_snapshots
    WHERE completed_at >= now() - (${periodInterval(period)})::interval
      AND ((${organizationId === "all"} AND organization_id IN (SELECT organization_id FROM memberships WHERE user_id=${userId ?? null}))
        OR (${organizationId !== "all"} AND organization_id=${organizationId === "all" ? null : organizationId}::uuid))
    GROUP BY organization_id, repository_id, repository_name, (completed_at AT TIME ZONE 'UTC')::date, platform, requested_vcpu
  `;
  return calculateGithubRunnerCostCenter(rows.map((row) => ({ organizationId: String(row.organizationId), repositoryId: String(row.repositoryId), repositoryName: String(row.repositoryName), usageDate: String(row.usageDate), platform: String(row.platform), requestedVcpu: Number(row.requestedVcpu), jobCount: Number(row.jobCount), billableMinutes: Number(row.billableMinutes) })));
}
