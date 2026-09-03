import type { JobLabelRecommendation, JobLabelRecommendationQuery } from "@mars/contracts";
import { JobLabelRecommendationQuery as JobLabelRecommendationQuerySchema } from "@mars/contracts";
import type { DatabaseClient } from "./index.ts";

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

function numericLabel(label: string): boolean {
  return /^\d+(?:VCPU|G)$/i.test(label.trim());
}

function isWindowsRoutingLabel(label: string): boolean {
  return /^(?:mars-)?windows(?:[-_][a-z0-9._-]+)*$/i.test(label.trim());
}

function windowsRoutingRank(label: string): number {
  return /^mars-windows(?:[-_]|$)/i.test(label.trim()) ? 2 : 1;
}

export function parseCurrentResourceLabels(labels: readonly string[]): {
  windowsLabel: string | null;
  vcpu: number | null;
  memoryGiB: number | null;
} {
  let windowsLabel: string | null = null;
  let windowsRank = 0;
  let vcpu: number | null = null;
  let memoryGiB: number | null = null;
  for (const label of labels) {
    const normalized = label.trim();
    if (isWindowsRoutingLabel(normalized) && windowsRoutingRank(normalized) > windowsRank) {
      windowsLabel = label;
      windowsRank = windowsRoutingRank(normalized);
    }
    const vcpuMatch = /^(\d+)VCPU$/i.exec(normalized);
    if (vcpuMatch && positiveSafeInteger(Number(vcpuMatch[1]))) vcpu = Number(vcpuMatch[1]);
    const memoryMatch = /^(\d+)G$/i.exec(normalized);
    if (memoryMatch && positiveSafeInteger(Number(memoryMatch[1]))) memoryGiB = Number(memoryMatch[1]);
  }
  return { windowsLabel, vcpu, memoryGiB };
}

export function buildOptimizedLabels(labels: readonly string[], vcpu: number, memoryGiB: number): string[] {
  if (!positiveSafeInteger(vcpu) || !positiveSafeInteger(memoryGiB)) throw new RangeError("Optimized labels require positive safe integers");
  return [...labels.filter(label => !numericLabel(label)), `${vcpu}VCPU`, `${memoryGiB}G`];
}

const RECOMMENDATION_SQL = `WITH scoped AS (
  SELECT s.*, j.requested_labels,
    row_number() OVER (ORDER BY s.completed_at DESC, s.job_id DESC) AS latest_ordinal
  FROM dashboard_job_timing_snapshots s
  JOIN dashboard_jobs j
    ON j.organization_id=s.organization_id AND j.id=s.job_id AND j.run_id=s.run_id
  WHERE (
    ($1 = 'all' AND s.organization_id IN (SELECT organization_id FROM memberships WHERE user_id=$7::uuid))
    OR ($1 <> 'all' AND s.organization_id=$1::uuid)
  )
    AND s.completed_at >= $2::timestamptz
    AND s.completed_at < $3::timestamptz
    AND s.repository_id=$4::uuid
    AND s.workflow_name=$5::text
    AND s.job_name=$6::text
), successful AS (
  SELECT * FROM scoped WHERE outcome='success'
), aggregate AS (
  SELECT count(*)::bigint AS "successfulRunCount",
    count(*) FILTER (WHERE cpu_peak_percent IS NOT NULL AND memory_peak_bytes IS NOT NULL)::bigint AS "coveredRunCount",
    percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_peak_percent) FILTER (WHERE cpu_peak_percent IS NOT NULL) AS "p95CpuPeakPercent",
    round((percentile_cont(0.95) WITHIN GROUP (ORDER BY memory_peak_bytes) FILTER (WHERE memory_peak_bytes IS NOT NULL))::numeric)::bigint AS "p95MemoryPeakBytes"
  FROM successful
)
SELECT latest.requested_labels AS "currentLabels",
  aggregate."successfulRunCount", aggregate."coveredRunCount",
  aggregate."p95CpuPeakPercent", aggregate."p95MemoryPeakBytes"
FROM aggregate
LEFT JOIN scoped latest ON latest.latest_ordinal=1`;

type RecommendationRow = Record<string, unknown>;

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
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
  const current = parseCurrentResourceLabels(labelsValue(row.currentLabels ?? row.labels));
  const policy = recommendResourceLabels({
    cpuP95: p95CpuPeakPercent,
    memoryP95Bytes: p95MemoryPeakBytes,
    successfulRuns: successfulRunCount,
    coveredRuns: coveredRunCount,
    currentVcpu: current.vcpu,
    currentMemoryGiB: current.memoryGiB,
  });
  return {
    status: policy.status,
    currentLabels: labelsValue(row.currentLabels ?? row.labels),
    currentWindowsLabel: current.windowsLabel,
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
  const rows = await db.unsafe<RecommendationRow[]>(RECOMMENDATION_SQL, [
    organizationId,
    validated.from,
    validated.to,
    validated.repositoryId,
    validated.workflowName,
    validated.jobName,
    userId ?? null,
  ]);
  return normalizeRecommendation(rows[0] ?? {});
}
