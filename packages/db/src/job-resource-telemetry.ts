import { WorkerEvent, WorkerEventPayload, type JobResourceSample } from "@mars/contracts";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";
import type { DatabaseClient } from "./index.ts";
export type JobResourceSampleResult = "stored" | "duplicate" | "ignored" | "rejected";
export type JobResourceTelemetryDb = DatabaseClient;
const LEASE_HEARTBEAT_TTL_MS = 10 * 60_000;

const telemetryQueries = defineQueries((db) => ({
  lease: db.select({ organizationId: schema.dashboardJobs.organizationId, runId: schema.dashboardJobs.runId, state: schema.runnerLeases.state })
    .from(schema.runnerLeases).innerJoin(schema.dashboardJobs, eq(schema.dashboardJobs.githubJobId, schema.runnerLeases.githubJobId))
    .where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.dashboardJobs.id, sql.placeholder("jobId"))))
    .limit(1).prepare("job_resource_telemetry_lease"),
  insert: db.insert(schema.dashboardJobResourceSamples).values({
    organizationId: sql.placeholder("organizationId"), runId: sql.placeholder("runId"), jobId: sql.placeholder("jobId"),
    leaseId: sql.placeholder("leaseId"), occurredAt: sql.placeholder("occurredAt"), cpuUsagePercent: sql.placeholder("cpuUsagePercent"),
    cpuTimeMs: sql.placeholder("cpuTimeMs"), memoryWorkingSetBytes: sql.placeholder("memoryWorkingSetBytes"),
    memoryLimitBytes: sql.placeholder("memoryLimitBytes"), diskUsageBytes: sql.placeholder("diskUsageBytes"),
  }).onConflictDoNothing().returning({ occurredAt: schema.dashboardJobResourceSamples.occurredAt }).prepare("job_resource_telemetry_insert"),
  renew: db.update(schema.runnerLeases).set({ expiresAt: sql`GREATEST(${schema.runnerLeases.expiresAt}, ${sql.placeholder("expiresAt")})`, updatedAt: sql`now()` })
    .where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), inArray(schema.runnerLeases.state, ["online", "busy"])))
    .prepare("job_resource_telemetry_renew"),
  list: db.select({
    organizationId: schema.dashboardJobResourceSamples.organizationId, runId: schema.dashboardJobResourceSamples.runId,
    jobId: schema.dashboardJobResourceSamples.jobId, leaseId: schema.dashboardJobResourceSamples.leaseId,
    occurredAt: schema.dashboardJobResourceSamples.occurredAt, cpuUsagePercent: schema.dashboardJobResourceSamples.cpuUsagePercent,
    cpuTimeMs: schema.dashboardJobResourceSamples.cpuTimeMs, memoryWorkingSetBytes: schema.dashboardJobResourceSamples.memoryWorkingSetBytes,
    memoryLimitBytes: schema.dashboardJobResourceSamples.memoryLimitBytes, diskUsageBytes: schema.dashboardJobResourceSamples.diskUsageBytes,
  }).from(schema.dashboardJobResourceSamples)
    .where(and(eq(schema.dashboardJobResourceSamples.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobResourceSamples.runId, sql.placeholder("runId")),
      eq(schema.dashboardJobResourceSamples.jobId, sql.placeholder("jobId")), sql`(${sql.placeholder("after")}::timestamptz IS NULL OR ${schema.dashboardJobResourceSamples.occurredAt} > ${sql.placeholder("after")}::timestamptz)`,
      gte(schema.dashboardJobResourceSamples.occurredAt, sql`now() - interval '7 days'`)))
    .orderBy(asc(schema.dashboardJobResourceSamples.occurredAt)).limit(sql.placeholder("limit")).prepare("job_resource_telemetry_list"),
}));

export async function persistJobResourceSample(db: JobResourceTelemetryDb, workerId: string, input: unknown, now = Date.now()): Promise<JobResourceSampleResult> {
  const event = WorkerEvent.safeParse(input);
  if (!event.success || event.data.workerId !== workerId) return "rejected";
  const payload = WorkerEventPayload.safeParse({ type: event.data.type, payload: event.data.payload });
  if (!payload.success || payload.data.type !== "job.resource_sample") return "rejected";
  const sample = payload.data.payload;
  const occurredMs = Date.parse(sample.occurredAt);
  if (!Number.isFinite(occurredMs) || occurredMs > now + 30_000) return "rejected";
  if (occurredMs < now - 24 * 60 * 60_000) return "ignored";
  const [lease] = await telemetryQueries(db).lease.execute({ leaseId: sample.leaseId, workerId, jobId: sample.jobId }) as { organizationId: string; runId: string; state: string }[];
  if (!lease) return "rejected";
  if (lease.state === "completed" || lease.state === "failed" || lease.state === "reaped" || lease.state === "expired") return "ignored";
  const inserted = await telemetryQueries(db).insert.execute({ organizationId: lease.organizationId, runId: lease.runId, jobId: sample.jobId, leaseId: sample.leaseId, occurredAt: sample.occurredAt, cpuUsagePercent: sample.cpuUsagePercent, cpuTimeMs: sample.cpuTimeMs, memoryWorkingSetBytes: sample.memoryWorkingSetBytes, memoryLimitBytes: sample.memoryLimitBytes, diskUsageBytes: sample.diskUsageBytes ?? null });
  if (inserted[0] && occurredMs >= now - LEASE_HEARTBEAT_TTL_MS) {
    await telemetryQueries(db).renew.execute({ expiresAt: new Date(now + LEASE_HEARTBEAT_TTL_MS).toISOString(), leaseId: sample.leaseId, workerId });
  }
  return inserted[0] ? "stored" : "duplicate";
}

export async function listJobResourceSamples(db: JobResourceTelemetryDb, organizationId: string, runId: string, jobId: string, after: string | null = null, limit = 100): Promise<{ items: JobResourceSample[]; nextCursor: string | null }> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await telemetryQueries(db).list.execute({ organizationId, runId, jobId, after, limit: safeLimit + 1 });
  const items = rows.slice(0, safeLimit).map(row => ({ ...row, cpuUsagePercent: Number(row.cpuUsagePercent), cpuTimeMs: Number(row.cpuTimeMs), memoryWorkingSetBytes: Number(row.memoryWorkingSetBytes), memoryLimitBytes: Number(row.memoryLimitBytes), diskUsageBytes: row.diskUsageBytes == null ? null : Number(row.diskUsageBytes), occurredAt: new Date(row.occurredAt).toISOString() })) as JobResourceSample[];
  return { items, nextCursor: rows.length > safeLimit ? items.at(-1)?.occurredAt ?? null : null };
}
