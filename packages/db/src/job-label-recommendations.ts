import type { JobLabelRecommendation, JobLabelRecommendationQuery, ParsedRunnerLabel } from "@mars/contracts";
import { JobLabelRecommendationQuery as JobLabelRecommendationQuerySchema, formatRunnerLabel, parseRunnerLabels } from "@mars/contracts";
import type { DatabaseClient } from "./index.ts";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

const MIN_SUCCESSFUL_RUNS = 5;
const MIN_TELEMETRY_COVERAGE_PERCENT = 80;
const SAFETY_FACTOR = 1.25;
const BYTES_PER_GIB = 1024 ** 3;

export type ResourceLabelRecommendationInput = {
  cpuP95: number | null;
  memoryP95Bytes: number | null;
  successfulRuns: number;
  coveredRuns: number;
  currentVcpu?: number | null;
  currentMemoryGiB?: number | null;
};

export type ResourceLabelRecommendation = {
  status: "available" | "unavailable";
  vcpu: number | null;
  memoryGiB: number | null;
  reason: string | null;
};

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function recommendedCpu(cpuP95: number | null, currentVcpu: number | null | undefined): number | null {
  if (cpuP95 === null) return positiveSafeInteger(currentVcpu) ? currentVcpu : null;
  if (!Number.isFinite(cpuP95) || cpuP95 < 0) return null;
  const value = Math.ceil(cpuP95 / 100 * SAFETY_FACTOR);
  return positiveSafeInteger(value) ? value : null;
}

function recommendedMemory(memoryP95Bytes: number | null, currentMemoryGiB: number | null | undefined): number | null {
  if (memoryP95Bytes === null) return positiveSafeInteger(currentMemoryGiB) ? currentMemoryGiB : null;
  if (!Number.isFinite(memoryP95Bytes) || memoryP95Bytes < 0) return null;
  const value = Math.ceil(memoryP95Bytes / BYTES_PER_GIB * SAFETY_FACTOR);
  return positiveSafeInteger(value) ? value : null;
}

export function recommendResourceLabels(input: ResourceLabelRecommendationInput): ResourceLabelRecommendation {
  const { successfulRuns, coveredRuns } = input;
  if (!Number.isSafeInteger(successfulRuns) || successfulRuns < MIN_SUCCESSFUL_RUNS) {
    return { status: "unavailable", vcpu: null, memoryGiB: null, reason: "insufficient_history" };
  }
  if (!Number.isSafeInteger(coveredRuns) || coveredRuns < 0 || coveredRuns > successfulRuns
    || coveredRuns / successfulRuns * 100 < MIN_TELEMETRY_COVERAGE_PERCENT) {
    return { status: "unavailable", vcpu: null, memoryGiB: null, reason: "insufficient_telemetry_coverage" };
  }

  const vcpu = recommendedCpu(input.cpuP95, input.currentVcpu);
  const memoryGiB = recommendedMemory(input.memoryP95Bytes, input.currentMemoryGiB);
  if (vcpu === null && memoryGiB === null) {
    return { status: "unavailable", vcpu: null, memoryGiB: null, reason: "missing_resource_telemetry" };
  }
  if (vcpu === null) {
    return { status: "unavailable", vcpu: null, memoryGiB: null, reason: "missing_cpu_telemetry" };
  }
  if (memoryGiB === null) {
    return { status: "unavailable", vcpu: null, memoryGiB: null, reason: "missing_memory_telemetry" };
  }
  return { status: "available", vcpu, memoryGiB, reason: null };
}

function selectRank(label: ParsedRunnerLabel, platform: string | null): number {
  const normalizedPlatform = platform?.trim().toLowerCase() ?? "";
  if (normalizedPlatform && label.route === `mars-${normalizedPlatform}`) return 3;
  if (normalizedPlatform === "linux-x64" && /^mars-ubuntu-(22|24|26)$/.test(label.route)) return 3;
  if (label.route === "mars-any-x64" && normalizedPlatform.endsWith("-x64")) return 2;
  if (label.route === "mars-any") return 1;
  return 0;
}

export function selectRoutingLabel(labels: readonly string[], platform: string | null): ParsedRunnerLabel | null {
  const parsed = parseRunnerLabels(labels);
  if (!parsed) return null;
  let selected: ParsedRunnerLabel | null = null;
  let rank = 0;
  for (const option of parsed) {
    const optionRank = selectRank(option, platform);
    if (optionRank > rank) {
      selected = option;
      rank = optionRank;
    }
  }
  return selected;
}

export function buildOptimizedLabels(labels: readonly string[], vcpu: number, memoryGiB: number, selectedRoutingLabel?: string | null): string[] {
  if (!positiveSafeInteger(vcpu) || !positiveSafeInteger(memoryGiB)) throw new RangeError("Optimized labels require positive safe integers");
  const parsed = parseRunnerLabels(labels);
  if (!parsed) throw new RangeError("Optimized labels require valid composite runner labels");
  const selected = selectedRoutingLabel
    ? parsed.find((option) => option.original.toLowerCase() === selectedRoutingLabel.trim().toLowerCase())
    : parsed[0];
  if (!selected) throw new RangeError("Optimized label is not one of the requested alternatives");
  return labels.map((label) => label.trim().toLowerCase() === selected.original.toLowerCase()
    ? formatRunnerLabel(selected.route, vcpu, memoryGiB)
    : label);
}

type RecommendationRow = Record<string, unknown>;

const recommendationQueries = defineQueries((db) => {
  const snapshots = schema.dashboardJobTimingSnapshots;
  const jobs = schema.dashboardJobs;
  const scoped = db.$with("scoped").as(db.select({
    platform: snapshots.platform,
    outcome: snapshots.outcome,
    completedAt: snapshots.completedAt,
    jobId: snapshots.jobId,
    cpuPeakPercent: snapshots.cpuPeakPercent,
    memoryPeakBytes: snapshots.memoryPeakBytes,
    requestedLabels: jobs.requestedLabels,
    latestOrdinal: sql<number>`row_number() OVER (ORDER BY ${snapshots.completedAt} DESC, ${snapshots.jobId} DESC)`.as("latest_ordinal"),
  }).from(snapshots).innerJoin(jobs, and(
    eq(jobs.organizationId, snapshots.organizationId),
    eq(jobs.id, snapshots.jobId),
    eq(jobs.runId, snapshots.runId),
  )).where(and(
    or(
      and(sql`${sql.placeholder("organizationId")}='all'`, inArray(snapshots.organizationId, db.select({ organizationId: schema.memberships.organizationId }).from(schema.memberships).where(eq(schema.memberships.userId, sql.placeholder("userId"))))),
      and(sql`${sql.placeholder("organizationId")}<>'all'`, eq(snapshots.organizationId, sql`${sql.placeholder("scopedOrganizationId")}::uuid`)),
    ),
    gte(snapshots.completedAt, sql.placeholder("from")),
    lt(snapshots.completedAt, sql.placeholder("to")),
    eq(snapshots.repositoryId, sql.placeholder("repositoryId")),
    eq(snapshots.workflowName, sql.placeholder("workflowName")),
    eq(snapshots.jobName, sql.placeholder("jobName")),
  )));
  const latest = db.$with("latest").as(db.select({
    platform: scoped.platform,
    requestedLabels: scoped.requestedLabels,
  }).from(scoped).where(eq(scoped.latestOrdinal, 1)));
  const successful = db.$with("successful").as(db.select({
    cpuPeakPercent: scoped.cpuPeakPercent,
    memoryPeakBytes: scoped.memoryPeakBytes,
  }).from(scoped).innerJoin(latest, eq(latest.platform, scoped.platform)).where(eq(scoped.outcome, "success")));
  const aggregate = db.$with("aggregate").as(db.select({
    successfulRunCount: sql<number>`count(*)::bigint`.as("successful_run_count"),
    coveredRunCount: sql<number>`count(*) FILTER (WHERE ${successful.cpuPeakPercent} IS NOT NULL AND ${successful.memoryPeakBytes} IS NOT NULL)::bigint`.as("covered_run_count"),
    p95CpuPeakPercent: sql<number | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${successful.cpuPeakPercent}) FILTER (WHERE ${successful.cpuPeakPercent} IS NOT NULL)`.as("p95_cpu_peak_percent"),
    p95MemoryPeakBytes: sql<number | null>`round((percentile_cont(0.95) WITHIN GROUP (ORDER BY ${successful.memoryPeakBytes}) FILTER (WHERE ${successful.memoryPeakBytes} IS NOT NULL))::numeric)::bigint`.as("p95_memory_peak_bytes"),
  }).from(successful));
  return {
    get: db.with(scoped, latest, successful, aggregate).select({
      currentLabels: latest.requestedLabels,
      currentPlatform: latest.platform,
      successfulRunCount: aggregate.successfulRunCount,
      coveredRunCount: aggregate.coveredRunCount,
      p95CpuPeakPercent: aggregate.p95CpuPeakPercent,
      p95MemoryPeakBytes: aggregate.p95MemoryPeakBytes,
    }).from(aggregate).leftJoin(latest, sql`true`).prepare("job_label_recommendation"),
  };
});


function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function countValue(value: unknown): number {
  const normalized = numberValue(value);
  return normalized !== null && Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function labelsValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((label): label is string => typeof label === "string");
  if (typeof value !== "string") return [];
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) ? decoded.filter((label): label is string => typeof label === "string") : [];
  } catch {
    return [];
  }
}

function normalizeRecommendation(row: RecommendationRow): JobLabelRecommendation {
  const successfulRunCount = countValue(row.successfulRunCount);
  const coveredRunCount = countValue(row.coveredRunCount);
  const p95CpuPeakPercent = numberValue(row.p95CpuPeakPercent);
  const memoryP95 = numberValue(row.p95MemoryPeakBytes);
  const p95MemoryPeakBytes = memoryP95 === null ? null : Math.round(memoryP95);
  const currentLabels = labelsValue(row.currentLabels ?? row.labels);
  const currentPlatform = stringValue(row.currentPlatform);
  const current = selectRoutingLabel(currentLabels, currentPlatform);
  const policy = recommendResourceLabels({
    cpuP95: p95CpuPeakPercent,
    memoryP95Bytes: p95MemoryPeakBytes,
    successfulRuns: successfulRunCount,
    coveredRuns: coveredRunCount,
    currentVcpu: current?.vcpu,
    currentMemoryGiB: current?.memoryGiB,
  });
  return {
    status: policy.status,
    currentLabels,
    currentRoutingLabel: current?.original ?? null,
    currentPlatform,
    workflowPath: null,
    workflowJobId: null,
    recommendedVcpu: policy.vcpu,
    recommendedMemoryGiB: policy.memoryGiB,
    p95CpuPeakPercent,
    p95MemoryPeakBytes,
    successfulRunCount,
    telemetryCoveragePercent: successfulRunCount === 0 ? 0 : coveredRunCount / successfulRunCount * 100,
    reason: policy.reason,
  };
}

export async function getJobLabelRecommendation(
  db: DatabaseClient,
  organizationId: string,
  query: JobLabelRecommendationQuery,
  userId?: string,
): Promise<JobLabelRecommendation> {
  const validated = JobLabelRecommendationQuerySchema.parse(query);
  const rows = await recommendationQueries(db).get.execute({
    organizationId,
    scopedOrganizationId: organizationId === "all" ? null : organizationId,
    from: validated.from,
    to: validated.to,
    repositoryId: validated.repositoryId,
    workflowName: validated.workflowName,
    jobName: validated.jobName,
    userId: userId ?? null,
  });
  return normalizeRecommendation((rows[0] ?? {}) as RecommendationRow);
}

