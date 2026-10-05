import type { CostCenterBreakdown, CostCenterExternalBreakdown, CostCenterPricePoint, CostCenterPricingProvider, OverviewCostSavings, OverviewDto } from "@mars/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";
import type { DatabaseClient } from "./index.ts";

export type GithubRunnerPlatform = "linux-x64" | "linux-arm64" | "windows-x64" | "macos-arm64";
export type GithubRunnerRate = Readonly<{ platform: GithubRunnerPlatform; vcpu: number; sku: string; rateMicros: number }>;
export type GithubRunnerRateSchedule = Readonly<{ effectiveFrom: string; sourceUrl: string; rates: readonly GithubRunnerRate[] }>;
export type GithubRunnerUsageGroup = Readonly<{ usageDate: string; platform: string; requestedVcpu: number; billableMinutes: number }>;
export type GithubRunnerCostCenterUsageGroup = Readonly<{ organizationId: string; repositoryId: string; repositoryName: string; usageDate: string; platform: string; requestedVcpu: number; jobCount: number; billableMinutes: number }>;
export type GithubExternalUsageGroup = Readonly<{ organizationId: string; repositoryId: string; repositoryName: string; usageDate: string; platform: string; requestedVcpu: number; jobCount: number; billableMinutes: number }>;
const githubPricingUrl = "https://docs.github.com/en/billing/reference/actions-runner-pricing";
export const GITHUB_HOSTED_RATE_SCHEDULES: readonly GithubRunnerRateSchedule[] = Object.freeze([{
  effectiveFrom: "2026-01-01", sourceUrl: githubPricingUrl,
  rates: Object.freeze<GithubRunnerRate[]>([
    { platform: "linux-x64", vcpu: 1, sku: "actions_linux_slim", rateMicros: 2_000 }, { platform: "linux-x64", vcpu: 2, sku: "actions_linux", rateMicros: 6_000 }, { platform: "linux-x64", vcpu: 4, sku: "linux_4_core", rateMicros: 12_000 }, { platform: "linux-x64", vcpu: 8, sku: "linux_8_core", rateMicros: 22_000 }, { platform: "linux-x64", vcpu: 16, sku: "linux_16_core", rateMicros: 42_000 }, { platform: "linux-x64", vcpu: 32, sku: "linux_32_core", rateMicros: 82_000 }, { platform: "linux-x64", vcpu: 64, sku: "linux_64_core", rateMicros: 162_000 }, { platform: "linux-x64", vcpu: 96, sku: "linux_96_core", rateMicros: 252_000 },
    { platform: "linux-arm64", vcpu: 1, sku: "actions_linux_slim", rateMicros: 2_000 }, { platform: "linux-arm64", vcpu: 2, sku: "actions_linux", rateMicros: 6_000 }, { platform: "linux-arm64", vcpu: 4, sku: "linux_4_core", rateMicros: 12_000 }, { platform: "linux-arm64", vcpu: 8, sku: "linux_8_core", rateMicros: 22_000 }, { platform: "linux-arm64", vcpu: 16, sku: "linux_16_core", rateMicros: 42_000 }, { platform: "linux-arm64", vcpu: 32, sku: "linux_32_core", rateMicros: 82_000 }, { platform: "linux-arm64", vcpu: 64, sku: "linux_64_core", rateMicros: 162_000 }, { platform: "linux-arm64", vcpu: 96, sku: "linux_96_core", rateMicros: 252_000 },
    { platform: "windows-x64", vcpu: 2, sku: "actions_windows", rateMicros: 10_000 }, { platform: "windows-x64", vcpu: 4, sku: "windows_4_core", rateMicros: 22_000 }, { platform: "windows-x64", vcpu: 8, sku: "windows_8_core", rateMicros: 42_000 }, { platform: "windows-x64", vcpu: 16, sku: "windows_16_core", rateMicros: 82_000 }, { platform: "windows-x64", vcpu: 32, sku: "windows_32_core", rateMicros: 162_000 }, { platform: "windows-x64", vcpu: 64, sku: "windows_64_core", rateMicros: 322_000 }, { platform: "windows-x64", vcpu: 96, sku: "windows_96_core", rateMicros: 552_000 },
    { platform: "macos-arm64", vcpu: 4, sku: "actions_macos", rateMicros: 62_000 }, { platform: "macos-arm64", vcpu: 5, sku: "macos_xl", rateMicros: 102_000 },
  ]),
}]);

const blacksmithPricingUrl = "https://www.blacksmith.sh/pricing";
export const BLACKSMITH_HOSTED_RATE_SCHEDULES: readonly GithubRunnerRateSchedule[] = Object.freeze([{
  effectiveFrom: "2026-01-01", sourceUrl: blacksmithPricingUrl,
  rates: Object.freeze<GithubRunnerRate[]>([
    ...[2, 4, 8, 16, 32].map((vcpu) => ({ platform: "linux-x64" as const, vcpu, sku: `blacksmith_ubuntu_x64_${vcpu}`, rateMicros: 4_000 })),
    ...[2, 4, 8, 16, 32].map((vcpu) => ({ platform: "windows-x64" as const, vcpu, sku: `blacksmith_windows_x64_${vcpu}`, rateMicros: 8_000 })),
    ...[2, 4, 8, 16, 32].map((vcpu) => ({ platform: "macos-arm64" as const, vcpu, sku: `blacksmith_macos_m4_${vcpu}`, rateMicros: 80_000 })),
  ]),
}]);

const azureVmPricingUrl = "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/";
export const AZURE_VM_RATE_SCHEDULES: readonly GithubRunnerRateSchedule[] = Object.freeze([{
  effectiveFrom: "2026-01-01", sourceUrl: azureVmPricingUrl,
  rates: Object.freeze<GithubRunnerRate[]>([
    ...[2, 4, 8, 16, 32, 64].map((vcpu) => ({ platform: "linux-x64" as const, vcpu, sku: `Standard_D${vcpu}s_v5`, rateMicros: vcpu * 800 })),
    ...[2, 4, 8, 16, 32, 64].map((vcpu) => ({ platform: "linux-arm64" as const, vcpu, sku: `Standard_D${vcpu}ps_v5`, rateMicros: vcpu * 800 })),
    ...[2, 4, 8, 16, 32, 64].map((vcpu) => ({ platform: "windows-x64" as const, vcpu, sku: `Standard_D${vcpu}s_v5_windows`, rateMicros: vcpu * 1_600 })),
  ]),
}]);
const schedulesForProvider = (provider: CostCenterPricingProvider) => provider === "blacksmith" ? BLACKSMITH_HOSTED_RATE_SCHEDULES : provider === "azure-vm" ? AZURE_VM_RATE_SCHEDULES : GITHUB_HOSTED_RATE_SCHEDULES;
const emptySavings = (): OverviewCostSavings => ({ selfHostedMinutes: 0, pricedMinutes: 0, unpricedMinutes: 0, estimatedSavingsMicros: 0, currency: "USD", latestRateEffectiveFrom: null });
type ResolvedRate = { schedule: GithubRunnerRateSchedule; rate: GithubRunnerRate } | null;
function resolveRate(usageDate: string, platform: string, requestedVcpu: number, schedules: readonly GithubRunnerRateSchedule[]): ResolvedRate {
  const schedule = schedules.filter((candidate) => candidate.effectiveFrom <= usageDate).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const rate = schedule?.rates.filter((candidate) => candidate.platform === platform && candidate.vcpu >= requestedVcpu).sort((a, b) => a.vcpu - b.vcpu)[0];
  return schedule && rate ? { schedule, rate } : null;
}

export function calculateGithubRunnerCostSavings(usage: readonly GithubRunnerUsageGroup[], schedules: readonly GithubRunnerRateSchedule[] = GITHUB_HOSTED_RATE_SCHEDULES): OverviewCostSavings {
  let selfHostedMinutes = 0, pricedMinutes = 0, estimatedSavingsMicros = 0, latestRateEffectiveFrom: string | null = null;
  for (const group of usage) {
    const minutes = Math.max(0, Math.floor(group.billableMinutes)); selfHostedMinutes += minutes;
    const resolved = resolveRate(group.usageDate, group.platform, group.requestedVcpu, schedules); if (!resolved) continue;
    pricedMinutes += minutes; estimatedSavingsMicros += minutes * resolved.rate.rateMicros;
    if (!latestRateEffectiveFrom || resolved.schedule.effectiveFrom > latestRateEffectiveFrom) latestRateEffectiveFrom = resolved.schedule.effectiveFrom;
  }
  return { ...emptySavings(), selfHostedMinutes, pricedMinutes, unpricedMinutes: selfHostedMinutes - pricedMinutes, estimatedSavingsMicros, latestRateEffectiveFrom };
}

export function calculateGithubRunnerCostCenter(usage: readonly GithubRunnerCostCenterUsageGroup[], schedules: readonly GithubRunnerRateSchedule[] = GITHUB_HOSTED_RATE_SCHEDULES): { costSavings: OverviewCostSavings; priceOverTime: CostCenterPricePoint[]; breakdown: CostCenterBreakdown[] } {
  const merged = new Map<string, CostCenterBreakdown>(), daily = new Map<string, number>();
  for (const group of usage) {
    const minutes = Math.max(0, Math.floor(group.billableMinutes)), resolved = resolveRate(group.usageDate, group.platform, group.requestedVcpu, schedules);
    const githubRunnerSku = resolved?.rate.sku ?? null, githubRunnerVcpu = resolved?.rate.vcpu ?? null, key = [group.organizationId, group.repositoryId, group.platform, group.requestedVcpu, githubRunnerSku, githubRunnerVcpu].join("|");
    const pricedMinutes = resolved ? minutes : 0, estimatedSavingsMicros = resolved ? minutes * resolved.rate.rateMicros : 0, previous = merged.get(key);
    merged.set(key, previous ? { ...previous, jobCount: previous.jobCount + group.jobCount, selfHostedMinutes: previous.selfHostedMinutes + minutes, pricedMinutes: previous.pricedMinutes + pricedMinutes, unpricedMinutes: previous.unpricedMinutes + minutes - pricedMinutes, estimatedSavingsMicros: previous.estimatedSavingsMicros + estimatedSavingsMicros } : { organizationId: group.organizationId, repositoryId: group.repositoryId, repositoryName: group.repositoryName, platform: group.platform, requestedVcpu: group.requestedVcpu, githubRunnerSku, githubRunnerVcpu, jobCount: group.jobCount, selfHostedMinutes: minutes, pricedMinutes, unpricedMinutes: minutes - pricedMinutes, estimatedSavingsMicros });
    daily.set(group.usageDate, (daily.get(group.usageDate) ?? 0) + estimatedSavingsMicros);
  }
  const breakdown = [...merged.values()].sort((a, b) => b.estimatedSavingsMicros - a.estimatedSavingsMicros || a.repositoryName.localeCompare(b.repositoryName) || a.platform.localeCompare(b.platform) || a.requestedVcpu - b.requestedVcpu || (a.githubRunnerSku ?? "").localeCompare(b.githubRunnerSku ?? ""));
  const priceOverTime = [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, estimatedSavingsMicros]) => ({ date, estimatedSavingsMicros }));
  const costSavings = breakdown.reduce((sum, row) => ({ ...sum, selfHostedMinutes: sum.selfHostedMinutes + row.selfHostedMinutes, pricedMinutes: sum.pricedMinutes + row.pricedMinutes, unpricedMinutes: sum.unpricedMinutes + row.unpricedMinutes, estimatedSavingsMicros: sum.estimatedSavingsMicros + row.estimatedSavingsMicros }), emptySavings());
  for (const group of usage) { const resolved = resolveRate(group.usageDate, group.platform, group.requestedVcpu, schedules); if (resolved && (!costSavings.latestRateEffectiveFrom || resolved.schedule.effectiveFrom > costSavings.latestRateEffectiveFrom)) costSavings.latestRateEffectiveFrom = resolved.schedule.effectiveFrom; }
  return { costSavings, priceOverTime, breakdown };
}
export function calculateGithubExternalCostCenter(usage: readonly GithubExternalUsageGroup[], schedules: readonly GithubRunnerRateSchedule[] = GITHUB_HOSTED_RATE_SCHEDULES): { externalMinutes: number; externalPricedMinutes: number; externalUnpricedMinutes: number; estimatedExternalCostMicros: number; externalBreakdown: CostCenterExternalBreakdown[] } {
  const merged = new Map<string, CostCenterExternalBreakdown>();
  for (const group of usage) {
    const minutes = Math.max(0, Math.floor(group.billableMinutes));
    const resolved = resolveRate(group.usageDate, group.platform, group.requestedVcpu, schedules);
    const githubRunnerSku = resolved?.rate.sku ?? null;
    const githubRunnerVcpu = resolved?.rate.vcpu ?? null;
    const key = [group.organizationId, group.repositoryId, group.platform, group.requestedVcpu, githubRunnerSku, githubRunnerVcpu].join("|");
    const pricedMinutes = resolved ? minutes : 0;
    const estimatedCostMicros = resolved ? minutes * resolved.rate.rateMicros : 0;
    const previous = merged.get(key);
    merged.set(key, previous
      ? { ...previous, jobCount: previous.jobCount + group.jobCount, billableMinutes: previous.billableMinutes + minutes, pricedMinutes: previous.pricedMinutes + pricedMinutes, unpricedMinutes: previous.unpricedMinutes + minutes - pricedMinutes, estimatedCostMicros: previous.estimatedCostMicros + estimatedCostMicros }
      : { organizationId: group.organizationId, repositoryId: group.repositoryId, repositoryName: group.repositoryName, platform: group.platform, requestedVcpu: group.requestedVcpu, githubRunnerSku, githubRunnerVcpu, jobCount: group.jobCount, billableMinutes: minutes, pricedMinutes, unpricedMinutes: minutes - pricedMinutes, estimatedCostMicros });
  }
  const externalBreakdown = [...merged.values()].sort((a, b) => b.estimatedCostMicros - a.estimatedCostMicros || a.repositoryName.localeCompare(b.repositoryName));
  return externalBreakdown.reduce((totals, row) => ({
    externalMinutes: totals.externalMinutes + row.billableMinutes,
    externalPricedMinutes: totals.externalPricedMinutes + row.pricedMinutes,
    externalUnpricedMinutes: totals.externalUnpricedMinutes + row.unpricedMinutes,
    estimatedExternalCostMicros: totals.estimatedExternalCostMicros + row.estimatedCostMicros,
    externalBreakdown,
  }), { externalMinutes: 0, externalPricedMinutes: 0, externalUnpricedMinutes: 0, estimatedExternalCostMicros: 0, externalBreakdown });
}

const costQueries = defineQueries((db) => {
  const timing = schema.dashboardJobTimingSnapshots;
  const jobs = schema.dashboardJobs;
  const membershipScope = (org: AnyPgColumn) => sql`(${sql.placeholder("isAll")}::boolean AND ${org} IN (SELECT ${schema.memberships.organizationId} FROM ${schema.memberships} WHERE ${schema.memberships.userId}=${sql.placeholder("userId")}::uuid)) OR (NOT ${sql.placeholder("isAll")}::boolean AND ${org}=${sql.placeholder("organizationId")}::uuid)`;
  const date = (at: AnyPgColumn) => sql<string>`(${at} AT TIME ZONE 'UTC')::date::text`;
  const minutes = (duration: AnyPgColumn) => sql<number>`SUM(GREATEST(1, CEIL(${duration} / 60000.0)))::bigint`;
  const externalLabelText = sql<string>`(SELECT lower(string_agg(value, ' ')) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${jobs.requestedLabels})='array' THEN ${jobs.requestedLabels} ELSE '[]'::jsonb END))`;
  const hostedPlatform = sql<string>`CASE WHEN ${externalLabelText} LIKE '%macos%' THEN 'macos-arm64' WHEN ${externalLabelText} LIKE '%windows%' THEN 'windows-x64' WHEN ${externalLabelText} LIKE '%ubuntu%' OR ${externalLabelText} LIKE '%linux%' THEN 'linux-x64' ELSE NULL END`;
  const externalScope = and(eq(jobs.status, "completed"), sql`${jobs.completedAt} IS NOT NULL`, sql`${jobs.startedAt} IS NOT NULL`,
    sql`${jobs.completedAt} >= now() - ${sql.placeholder("period")}::interval`, sql`NOT EXISTS (SELECT 1 FROM ${timing} s WHERE s.organization_id=${jobs.organizationId} AND s.job_id=${jobs.id})`,
    sql`(${membershipScope(jobs.organizationId)})`, sql`${externalLabelText} LIKE '%macos%' OR ${externalLabelText} LIKE '%windows%' OR ${externalLabelText} LIKE '%ubuntu%' OR ${externalLabelText} LIKE '%linux%'`);
  const externalQuery = db.select({
    organizationId: jobs.organizationId, repositoryId: schema.dashboardRuns.repositoryId, repositoryName: schema.dashboardRepositories.fullName,
    usageDate: date(jobs.completedAt), platform: hostedPlatform, requestedVcpu: sql<number>`4`,
    jobCount: sql<number>`COUNT(*)::bigint`, billableMinutes: sql<number>`SUM(GREATEST(1, CEIL(EXTRACT(EPOCH FROM (${jobs.completedAt} - ${jobs.startedAt})) / 60.0)))::bigint`,
  }).from(jobs).innerJoin(schema.dashboardRuns, and(eq(schema.dashboardRuns.organizationId, jobs.organizationId), eq(schema.dashboardRuns.id, jobs.runId)))
    .innerJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId)))
    .where(externalScope).groupBy(jobs.organizationId, schema.dashboardRuns.repositoryId, schema.dashboardRepositories.fullName, date(jobs.completedAt), hostedPlatform);
  return {
    savings: db.select({ usageDate: date(timing.completedAt), platform: timing.platform, requestedVcpu: timing.requestedVcpu, billableMinutes: minutes(timing.executionDurationMs) })
      .from(timing).where(and(sql`${timing.completedAt} >= now() - ${sql.placeholder("period")}::interval`, membershipScope(timing.organizationId)))
      .groupBy(date(timing.completedAt), timing.platform, timing.requestedVcpu).prepare("github_runner_cost_savings"),
    center: db.select({
      organizationId: timing.organizationId, repositoryId: timing.repositoryId, repositoryName: timing.repositoryName,
      usageDate: date(timing.completedAt), platform: timing.platform, requestedVcpu: timing.requestedVcpu,
      jobCount: sql<number>`COUNT(*)::bigint`, billableMinutes: minutes(timing.executionDurationMs),
    }).from(timing).where(and(sql`${timing.completedAt} >= now() - ${sql.placeholder("period")}::interval`, membershipScope(timing.organizationId)))
      .groupBy(timing.organizationId, timing.repositoryId, timing.repositoryName, date(timing.completedAt), timing.platform, timing.requestedVcpu).prepare("github_runner_cost_center"),
    external: externalQuery.prepare("github_runner_external_cost_center"),
  };
});
const periodInterval = (period: OverviewDto["period"]) => period === "24h" ? "24 hours" : period === "7d" ? "7 days" : "30 days";

export async function getGithubRunnerCostSavings(db: DatabaseClient, organizationId: string, period: OverviewDto["period"], userId?: string, provider: CostCenterPricingProvider = "github"): Promise<OverviewCostSavings> {
  const rows = await costQueries(db).savings.execute({ period: periodInterval(period), isAll: organizationId === "all", organizationId: organizationId === "all" ? null : organizationId, userId: userId ?? null }) as Record<string, unknown>[];
  return calculateGithubRunnerCostSavings(rows.map((row) => ({ usageDate: String(row.usageDate), platform: String(row.platform), requestedVcpu: Number(row.requestedVcpu), billableMinutes: Number(row.billableMinutes) })), schedulesForProvider(provider));
}

export async function getGithubRunnerCostCenter(db: DatabaseClient, organizationId: string, period: OverviewDto["period"], userId?: string, provider: CostCenterPricingProvider = "github"): Promise<{ costSavings: OverviewCostSavings; externalMinutes: number; externalPricedMinutes: number; externalUnpricedMinutes: number; estimatedExternalCostMicros: number; breakdown: CostCenterBreakdown[]; externalBreakdown: CostCenterExternalBreakdown[]; priceOverTime: CostCenterPricePoint[] }> {
  const [rows, externalRows] = await Promise.all([
    costQueries(db).center.execute({ period: periodInterval(period), isAll: organizationId === "all", organizationId: organizationId === "all" ? null : organizationId, userId: userId ?? null }),
    costQueries(db).external.execute({ period: periodInterval(period), isAll: organizationId === "all", organizationId: organizationId === "all" ? null : organizationId, userId: userId ?? null }),
  ]) as [Record<string, unknown>[], Record<string, unknown>[]];
  const result = calculateGithubRunnerCostCenter(rows.map((row) => ({ organizationId: String(row.organizationId), repositoryId: String(row.repositoryId), repositoryName: String(row.repositoryName), usageDate: String(row.usageDate), platform: String(row.platform), requestedVcpu: Number(row.requestedVcpu), jobCount: Number(row.jobCount), billableMinutes: Number(row.billableMinutes) })), schedulesForProvider(provider));
  const external = calculateGithubExternalCostCenter(externalRows.filter((row) => row.platform).map((row) => ({ organizationId: String(row.organizationId), repositoryId: String(row.repositoryId), repositoryName: String(row.repositoryName), usageDate: String(row.usageDate), platform: String(row.platform), requestedVcpu: Number(row.requestedVcpu), jobCount: Number(row.jobCount), billableMinutes: Number(row.billableMinutes) })), schedulesForProvider(provider));
  return { ...result, ...external };
}
