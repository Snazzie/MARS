import type { JobTimingAggregate, JobTimingSnapshot } from "@mars/contracts";
import { and, asc, desc, sql } from "drizzle-orm";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";
import type { DatabaseClient } from "./index.ts";
export type JobTimingSnapshotInput = Omit<JobTimingSnapshot, "createdAt"> & { createdAt?: string };
export type JobTimingDb = DatabaseClient;

const timingQueries = defineQueries((db) => {
  const t = schema.dashboardJobTimingSnapshots;
  const membershipScope = sql`((${sql.placeholder("isAll")}::boolean AND ${t.organizationId} IN (SELECT ${schema.memberships.organizationId} FROM ${schema.memberships} WHERE ${schema.memberships.userId}=${sql.placeholder("userId")}::uuid)) OR (NOT ${sql.placeholder("isAll")}::boolean AND ${t.organizationId}=${sql.placeholder("organizationId")}::uuid))`;
  const historyFilter = and(
    membershipScope,
    sql`(${sql.placeholder("from")}::timestamptz IS NULL OR ${t.completedAt} >= ${sql.placeholder("from")}::timestamptz)`,
    sql`(${sql.placeholder("to")}::timestamptz IS NULL OR ${t.completedAt} < ${sql.placeholder("to")}::timestamptz)`,
    sql`(${sql.placeholder("repositoryId")}::uuid IS NULL OR ${t.repositoryId}=${sql.placeholder("repositoryId")}::uuid)`,
    sql`(${sql.placeholder("workflow")}::text IS NULL OR ${t.workflowName}=${sql.placeholder("workflow")})`,
    sql`(${sql.placeholder("jobName")}::text IS NULL OR ${t.jobName}=${sql.placeholder("jobName")})`,
    sql`(${sql.placeholder("platform")}::text IS NULL OR ${t.platform}=${sql.placeholder("platform")})`,
    sql`(${sql.placeholder("driver")}::text IS NULL OR ${t.driver}=${sql.placeholder("driver")})`,
    sql`(${sql.placeholder("vcpu")}::bigint IS NULL OR ${t.requestedVcpu}=${sql.placeholder("vcpu")})`,
    sql`(${sql.placeholder("concurrency")}::bigint IS NULL OR ${t.effectiveConcurrency}=${sql.placeholder("concurrency")})`,
    sql`(${sql.placeholder("outcome")}::text IS NULL OR ${t.outcome}=${sql.placeholder("outcome")})`,
    sql`(${sql.placeholder("cursor")}::timestamptz IS NULL OR (${t.completedAt}, ${t.jobId}) < (${sql.placeholder("cursor")}::timestamptz, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))`,
  );
  const aggregateFilter = and(membershipScope,
    sql`(${sql.placeholder("from")}::timestamptz IS NULL OR ${t.completedAt} >= ${sql.placeholder("from")}::timestamptz)`,
    sql`(${sql.placeholder("to")}::timestamptz IS NULL OR ${t.completedAt} < ${sql.placeholder("to")}::timestamptz)`,
    sql`(${sql.placeholder("platform")}::text IS NULL OR ${t.platform}=${sql.placeholder("platform")})`);
  return {
    insert: db.insert(t).values({
      organizationId: sql.placeholder("organizationId"), jobId: sql.placeholder("jobId"), runId: sql.placeholder("runId"), repositoryId: sql.placeholder("repositoryId"),
      githubJobId: sql.placeholder("githubJobId"), repositoryName: sql.placeholder("repositoryName"), workflowName: sql.placeholder("workflowName"), jobName: sql.placeholder("jobName"),
      workerId: sql.placeholder("workerId"), platform: sql.placeholder("platform"), driver: sql.placeholder("driver"), runtimeBoundary: sql.placeholder("runtimeBoundary"),
      poolId: sql.placeholder("poolId"), artifactDigest: sql.placeholder("artifactDigest"), outcome: sql.placeholder("outcome"), completedAt: sql.placeholder("completedAt"),
      queuedAt: sql.placeholder("queuedAt"), startedAt: sql.placeholder("startedAt"), queueDurationMs: sql.placeholder("queueDurationMs"), startupDurationMs: sql.placeholder("startupDurationMs"),
      executionDurationMs: sql.placeholder("executionDurationMs"), cleanupDurationMs: sql.placeholder("cleanupDurationMs"), totalDurationMs: sql.placeholder("totalDurationMs"),
      requestedVcpu: sql.placeholder("requestedVcpu"), requestedMemoryBytes: sql.placeholder("requestedMemoryBytes"), requestedStorageBytes: sql.placeholder("requestedStorageBytes"),
      requestedConcurrency: sql.placeholder("requestedConcurrency"), observedVcpu: sql.placeholder("observedVcpu"), observedMemoryBytes: sql.placeholder("observedMemoryBytes"),
      observedStorageBytes: sql.placeholder("observedStorageBytes"), effectiveConcurrency: sql.placeholder("effectiveConcurrency"), telemetryState: sql.placeholder("telemetryState"),
      telemetrySampleCount: sql.placeholder("telemetrySampleCount"), cpuAveragePercent: sql.placeholder("cpuAveragePercent"), cpuP50Percent: sql.placeholder("cpuP50Percent"),
      cpuP95Percent: sql.placeholder("cpuP95Percent"), cpuPeakPercent: sql.placeholder("cpuPeakPercent"), cpuTimeMs: sql.placeholder("cpuTimeMs"),
      memoryAverageBytes: sql.placeholder("memoryAverageBytes"), memoryPeakBytes: sql.placeholder("memoryPeakBytes"), createdAt: sql.placeholder("createdAt"),
    }).onConflictDoNothing().returning({ jobId: t.jobId }).prepare("job_timing_insert"),
    history: db.select({
      organizationId: t.organizationId, jobId: t.jobId, runId: t.runId, repositoryId: t.repositoryId, githubJobId: t.githubJobId,
      repositoryName: t.repositoryName, workflowName: t.workflowName, jobName: t.jobName, workerId: t.workerId, platform: t.platform,
      driver: t.driver, runtimeBoundary: t.runtimeBoundary, poolId: t.poolId, artifactDigest: t.artifactDigest, outcome: t.outcome,
      completedAt: t.completedAt, queuedAt: t.queuedAt, startedAt: t.startedAt, queueDurationMs: t.queueDurationMs,
      startupDurationMs: t.startupDurationMs, executionDurationMs: t.executionDurationMs, cleanupDurationMs: t.cleanupDurationMs, totalDurationMs: t.totalDurationMs,
      requestedVcpu: t.requestedVcpu, requestedMemoryBytes: t.requestedMemoryBytes, requestedStorageBytes: t.requestedStorageBytes,
      requestedConcurrency: t.requestedConcurrency, observedVcpu: t.observedVcpu, observedMemoryBytes: t.observedMemoryBytes, observedStorageBytes: t.observedStorageBytes,
      effectiveConcurrency: t.effectiveConcurrency, telemetryState: t.telemetryState, telemetrySampleCount: t.telemetrySampleCount,
      cpuAveragePercent: t.cpuAveragePercent, cpuP50Percent: t.cpuP50Percent, cpuP95Percent: t.cpuP95Percent, cpuPeakPercent: t.cpuPeakPercent,
      cpuTimeMs: t.cpuTimeMs, memoryAverageBytes: t.memoryAverageBytes, memoryPeakBytes: t.memoryPeakBytes, createdAt: t.createdAt,
    }).from(t).where(historyFilter).orderBy(desc(t.completedAt), desc(t.jobId)).limit(sql.placeholder("limit")).prepare("job_timing_history"),
    aggregates: db.select({
      groupPlatform: t.platform, sampleCount: sql<number>`count(*)::int`, minMs: sql<number>`min(${t.executionDurationMs})::bigint`,
      maxMs: sql<number>`max(${t.executionDurationMs})::bigint`, p50Ms: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${t.executionDurationMs})::bigint`,
      p95Ms: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${t.executionDurationMs})::bigint`,
    }).from(t).where(aggregateFilter).groupBy(t.platform).orderBy(asc(t.platform)).prepare("job_timing_aggregates"),
  };
});

export async function recordJobTimingSnapshot(db: JobTimingDb, input: JobTimingSnapshotInput): Promise<boolean> {
  const [row] = await timingQueries(db).insert.execute({
    ...input, createdAt: input.createdAt ?? new Date().toISOString(),
  });
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
const encodeCursor = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const decodeCursor = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return Number.isFinite(Date.parse(decoded)) ? decoded : null;
  } catch {
    return null;
  }
};
function normalizeTiming(row: Record<string, unknown>): JobTimingSnapshot {
  return {
    ...row,
    githubJobId: asNumber(row.githubJobId), queueDurationMs: asNumber(row.queueDurationMs),
    startupDurationMs: asNumber(row.startupDurationMs), executionDurationMs: asNumber(row.executionDurationMs),
    cleanupDurationMs: asNumber(row.cleanupDurationMs), totalDurationMs: asNumber(row.totalDurationMs),
    requestedVcpu: asNumber(row.requestedVcpu), requestedMemoryBytes: asNumber(row.requestedMemoryBytes),
    requestedStorageBytes: asNumber(row.requestedStorageBytes), requestedConcurrency: asNumber(row.requestedConcurrency),
    effectiveConcurrency: asNumber(row.effectiveConcurrency),
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
  const cursor = decodeCursor(query.cursor);
  const rows = await timingQueries(db).history.execute({
    isAll: organizationId === "all", organizationId: organizationId === "all" ? null : organizationId, userId: userId ?? null,
    from: query.from ?? null, to: query.to ?? null, repositoryId: query.repositoryId ?? null, workflow: query.workflow ?? null,
    jobName: query.jobName ?? null, platform: query.platform ?? null, driver: query.driver ?? null, vcpu: query.vcpu ?? null,
    concurrency: query.concurrency ?? null, outcome: query.outcome ?? null, cursor, limit: limit + 1,
  }) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(normalizeTiming);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items.at(-1)?.completedAt ?? "") : null };
}

export async function getJobTimingAggregates(db: JobTimingDb, organizationId: string, query: Omit<JobTimingHistoryQuery, "cursor" | "limit"> = {}, userId?: string): Promise<JobTimingAggregate[]> {
  const rows = await timingQueries(db).aggregates.execute({
    isAll: organizationId === "all", organizationId: organizationId === "all" ? null : organizationId, userId: userId ?? null,
    from: query.from ?? null, to: query.to ?? null, platform: query.platform ?? null,
  }) as Record<string, unknown>[];
  return rows.map(row => ({ group: { platform: String(row.groupPlatform) }, sampleCount: asNumber(row.sampleCount), minMs: asNumber(row.minMs), maxMs: asNumber(row.maxMs), p50Ms: asNumber(row.p50Ms), p95Ms: asNumber(row.p95Ms) }));
}
