import type { JobTimingAggregate, JobTimingSnapshot } from "@whitesmith/contracts";
import type { DatabaseClient } from "./index.ts";

export type JobTimingSnapshotInput = Omit<JobTimingSnapshot, "createdAt"> & { createdAt?: string };
export type JobTimingDb = DatabaseClient;

export async function recordJobTimingSnapshot(db: JobTimingDb, input: JobTimingSnapshotInput): Promise<boolean> {
  const [row] = await db<{ jobId: string }[]>`
    INSERT INTO dashboard_job_timing_snapshots (
      organization_id, job_id, run_id, repository_id, github_job_id,
      repository_name, workflow_name, job_name, platform, driver, runtime_boundary,
      pool_id, artifact_digest, outcome, completed_at, queued_at, started_at,
      queue_duration_ms, startup_duration_ms, execution_duration_ms, cleanup_duration_ms, total_duration_ms,
      requested_vcpu, requested_memory_bytes, requested_storage_bytes, requested_concurrency,
      observed_vcpu, observed_memory_bytes, observed_storage_bytes, effective_concurrency,
      telemetry_state, telemetry_sample_count, cpu_average_percent, cpu_p50_percent, cpu_p95_percent, cpu_peak_percent, cpu_time_ms, memory_average_bytes, memory_peak_bytes, created_at
    ) VALUES (
      ${input.organizationId}, ${input.jobId}, ${input.runId}, ${input.repositoryId}, ${input.githubJobId},
      ${input.repositoryName}, ${input.workflowName}, ${input.jobName}, ${input.platform}, ${input.driver}, ${input.runtimeBoundary},
      ${input.poolId}, ${input.artifactDigest}, ${input.outcome}, ${input.completedAt}, ${input.queuedAt}, ${input.startedAt},
      ${input.queueDurationMs}, ${input.startupDurationMs}, ${input.executionDurationMs}, ${input.cleanupDurationMs}, ${input.totalDurationMs},
      ${input.requestedVcpu}, ${input.requestedMemoryBytes}, ${input.requestedStorageBytes}, ${input.requestedConcurrency},
      ${input.observedVcpu}, ${input.observedMemoryBytes}, ${input.observedStorageBytes}, ${input.effectiveConcurrency},
      ${input.telemetryState}, ${input.telemetrySampleCount}, ${input.cpuAveragePercent}, ${input.cpuP50Percent}, ${input.cpuP95Percent}, ${input.cpuPeakPercent}, ${input.cpuTimeMs}, ${input.memoryAverageBytes}, ${input.memoryPeakBytes}, ${input.createdAt ?? new Date().toISOString()}
    )
    ON CONFLICT (organization_id, job_id) DO NOTHING
    RETURNING job_id AS "jobId"
  `;
  return Boolean(row);
}
export type JobTimingHistoryQuery = {
  limit?: number;
  cursor?: string | null;
  from?: string;
  to?: string;
  repositoryId?: string;
  workflow?: string;
  jobName?: string;
  platform?: string;
  driver?: string;
  vcpu?: number;
  concurrency?: number;
  outcome?: JobTimingSnapshot["outcome"];
};

const asIso = (value: unknown) => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return String(value);
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
};
const asNumber = (value: unknown) => Number(value ?? 0);
function normalizeTiming(row: Record<string, unknown>): JobTimingSnapshot {
  return {
    ...row,
    githubJobId: asNumber(row.githubJobId), queueDurationMs: asNumber(row.queueDurationMs),
    startupDurationMs: asNumber(row.startupDurationMs), executionDurationMs: asNumber(row.executionDurationMs),
    cleanupDurationMs: asNumber(row.cleanupDurationMs), totalDurationMs: asNumber(row.totalDurationMs),
    requestedVcpu: asNumber(row.requestedVcpu), requestedMemoryBytes: asNumber(row.requestedMemoryBytes),
    requestedStorageBytes: asNumber(row.requestedStorageBytes), requestedConcurrency: asNumber(row.requestedConcurrency),
    telemetryState: row.telemetryState === "available" || row.telemetryState === "partial" ? row.telemetryState : "unavailable",
    telemetrySampleCount: asNumber(row.telemetrySampleCount),
    cpuAveragePercent: row.cpuAveragePercent == null ? null : asNumber(row.cpuAveragePercent),
    cpuP50Percent: row.cpuP50Percent == null ? null : asNumber(row.cpuP50Percent),
    cpuP95Percent: row.cpuP95Percent == null ? null : asNumber(row.cpuP95Percent),
    cpuPeakPercent: row.cpuPeakPercent == null ? null : asNumber(row.cpuPeakPercent),
    cpuTimeMs: row.cpuTimeMs == null ? null : asNumber(row.cpuTimeMs),
    memoryAverageBytes: row.memoryAverageBytes == null ? null : asNumber(row.memoryAverageBytes),
    memoryPeakBytes: row.memoryPeakBytes == null ? null : asNumber(row.memoryPeakBytes),
    completedAt: asIso(row.completedAt), queuedAt: asIso(row.queuedAt),
    startedAt: row.startedAt === null ? null : asIso(row.startedAt), createdAt: asIso(row.createdAt),
  } as JobTimingSnapshot;
}
export async function listJobTimingHistory(db: JobTimingDb, organizationId: string, query: JobTimingHistoryQuery = {}, userId?: string): Promise<{ items: JobTimingSnapshot[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 50)));
  const rows = await db<Record<string, unknown>[]>`
    SELECT organization_id AS "organizationId", job_id AS "jobId", run_id AS "runId", repository_id AS "repositoryId",
      github_job_id AS "githubJobId", repository_name AS "repositoryName", workflow_name AS "workflowName", job_name AS "jobName",
      platform, driver, runtime_boundary AS "runtimeBoundary", pool_id AS "poolId", artifact_digest AS "artifactDigest",
      outcome, completed_at AS "completedAt", queued_at AS "queuedAt", started_at AS "startedAt",
      queue_duration_ms AS "queueDurationMs", startup_duration_ms AS "startupDurationMs",
      execution_duration_ms AS "executionDurationMs", cleanup_duration_ms AS "cleanupDurationMs", total_duration_ms AS "totalDurationMs",
      requested_vcpu AS "requestedVcpu", requested_memory_bytes AS "requestedMemoryBytes", requested_storage_bytes AS "requestedStorageBytes",
      requested_concurrency AS "requestedConcurrency", observed_vcpu AS "observedVcpu", observed_memory_bytes AS "observedMemoryBytes",
      observed_storage_bytes AS "observedStorageBytes", effective_concurrency AS "effectiveConcurrency",
      telemetry_state AS "telemetryState", telemetry_sample_count AS "telemetrySampleCount", cpu_average_percent AS "cpuAveragePercent", cpu_p50_percent AS "cpuP50Percent", cpu_p95_percent AS "cpuP95Percent", cpu_peak_percent AS "cpuPeakPercent", cpu_time_ms AS "cpuTimeMs", memory_average_bytes AS "memoryAverageBytes", memory_peak_bytes AS "memoryPeakBytes", created_at AS "createdAt"
    FROM dashboard_job_timing_snapshots
    WHERE (
      (${organizationId === "all"} AND organization_id IN (SELECT organization_id FROM memberships WHERE user_id=${userId ?? null}))
      OR (${organizationId !== "all"} AND organization_id=${organizationId === "all" ? null : organizationId}::uuid)
    )
      AND (${query.from ?? null}::timestamptz IS NULL OR completed_at >= ${query.from ?? null}::timestamptz)
      AND (${query.to ?? null}::timestamptz IS NULL OR completed_at < ${query.to ?? null}::timestamptz)
      AND (${query.repositoryId ?? null}::uuid IS NULL OR repository_id=${query.repositoryId ?? null})
      AND (${query.workflow ?? null}::text IS NULL OR workflow_name=${query.workflow ?? null})
      AND (${query.jobName ?? null}::text IS NULL OR job_name=${query.jobName ?? null})
      AND (${query.platform ?? null}::text IS NULL OR platform=${query.platform ?? null})
      AND (${query.driver ?? null}::text IS NULL OR driver=${query.driver ?? null})
      AND (${query.vcpu ?? null}::bigint IS NULL OR requested_vcpu=${query.vcpu ?? null})
      AND (${query.concurrency ?? null}::bigint IS NULL OR effective_concurrency=${query.concurrency ?? null})
      AND (${query.outcome ?? null}::text IS NULL OR outcome=${query.outcome ?? null})
      AND (${query.cursor ?? null}::timestamptz IS NULL OR (completed_at, job_id) < (${query.cursor ?? null}::timestamptz, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    ORDER BY completed_at DESC, job_id DESC
    LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit).map(normalizeTiming);
  return { items, nextCursor: rows.length > limit ? items.at(-1)?.completedAt ?? null : null };
}

export async function getJobTimingAggregates(db: JobTimingDb, organizationId: string, query: Omit<JobTimingHistoryQuery, "cursor" | "limit"> = {}, userId?: string): Promise<JobTimingAggregate[]> {
  const rows = await db<Record<string, unknown>[]>`
    SELECT platform AS "groupPlatform", count(*)::int AS "sampleCount",
      min(execution_duration_ms)::bigint AS "minMs", max(execution_duration_ms)::bigint AS "maxMs",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY execution_duration_ms)::bigint AS "p50Ms",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY execution_duration_ms)::bigint AS "p95Ms"
    FROM dashboard_job_timing_snapshots
    WHERE (
      (${organizationId === "all"} AND organization_id IN (SELECT organization_id FROM memberships WHERE user_id=${userId ?? null}))
      OR (${organizationId !== "all"} AND organization_id=${organizationId === "all" ? null : organizationId}::uuid)
    )
      AND (${query.from ?? null}::timestamptz IS NULL OR completed_at >= ${query.from ?? null}::timestamptz)
      AND (${query.to ?? null}::timestamptz IS NULL OR completed_at < ${query.to ?? null}::timestamptz)
      AND (${query.platform ?? null}::text IS NULL OR platform=${query.platform ?? null})
    GROUP BY platform ORDER BY platform
  `;
  return rows.map(row => ({ group: { platform: String(row.groupPlatform) }, sampleCount: asNumber(row.sampleCount), minMs: asNumber(row.minMs), maxMs: asNumber(row.maxMs), p50Ms: asNumber(row.p50Ms), p95Ms: asNumber(row.p95Ms) }));
}
