import { WorkerEvent, WorkerEventPayload, type JobResourceSample } from "@mars/contracts";
import type { DatabaseClient } from "./index.ts";

export type JobResourceSampleResult = "stored" | "duplicate" | "rejected";
export type JobResourceTelemetryDb = DatabaseClient;
const LEASE_HEARTBEAT_TTL_MS = 10 * 60_000;

export async function persistJobResourceSample(db: JobResourceTelemetryDb, workerId: string, input: unknown, now = Date.now()): Promise<JobResourceSampleResult> {
  const event = WorkerEvent.safeParse(input);
  if (!event.success || event.data.workerId !== workerId) return "rejected";
  const payload = WorkerEventPayload.safeParse({ type: event.data.type, payload: event.data.payload });
  if (!payload.success || payload.data.type !== "job.resource_sample") return "rejected";
  const sample = payload.data.payload;
  const occurredMs = Date.parse(sample.occurredAt);
  if (!Number.isFinite(occurredMs) || occurredMs > now + 30_000 || occurredMs < now - 24 * 60 * 60_000) return "rejected";
  const [lease] = await db<{ organizationId: string; runId: string }[]>`
    SELECT j.organization_id AS "organizationId", j.run_id AS "runId"
    FROM runner_leases l JOIN dashboard_jobs j ON j.github_job_id=l.github_job_id
    WHERE l.id=${sample.leaseId} AND l.worker_id=${workerId} AND j.id=${sample.jobId}
      AND l.state NOT IN ('completed','failed','reaped','expired')
    LIMIT 1
  `;
  if (!lease) return "rejected";
  const inserted = await db<{ occurredAt: string }[]>`
    INSERT INTO dashboard_job_resource_samples
      (organization_id,run_id,job_id,lease_id,occurred_at,cpu_usage_percent,cpu_time_ms,memory_working_set_bytes,memory_limit_bytes)
    VALUES (${lease.organizationId},${lease.runId},${sample.jobId},${sample.leaseId},${sample.occurredAt},${sample.cpuUsagePercent},${sample.cpuTimeMs},${sample.memoryWorkingSetBytes},${sample.memoryLimitBytes})
    ON CONFLICT (organization_id,job_id,occurred_at) DO NOTHING
    RETURNING occurred_at AS "occurredAt"
  `;
  if (inserted[0] && occurredMs >= now - LEASE_HEARTBEAT_TTL_MS) {
    await db`UPDATE runner_leases SET expires_at=GREATEST(expires_at,${new Date(now + LEASE_HEARTBEAT_TTL_MS).toISOString()}),updated_at=now()
      WHERE id=${sample.leaseId} AND worker_id=${workerId}
        AND state IN ('sandbox_ready','online','busy')`;
  }
  return inserted[0] ? "stored" : "duplicate";
}

export async function listJobResourceSamples(db: JobResourceTelemetryDb, organizationId: string, runId: string, jobId: string, after: string | null = null, limit = 100): Promise<{ items: JobResourceSample[]; nextCursor: string | null }> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await db<Record<string, unknown>[]>`
    SELECT organization_id AS "organizationId",run_id AS "runId",job_id AS "jobId",lease_id AS "leaseId",occurred_at AS "occurredAt",cpu_usage_percent AS "cpuUsagePercent",cpu_time_ms AS "cpuTimeMs",memory_working_set_bytes AS "memoryWorkingSetBytes",memory_limit_bytes AS "memoryLimitBytes"
    FROM dashboard_job_resource_samples
    WHERE organization_id=${organizationId} AND run_id=${runId} AND job_id=${jobId} AND (${after}::timestamptz IS NULL OR occurred_at > ${after}::timestamptz)
      AND occurred_at >= now() - interval '7 days'
    ORDER BY occurred_at ASC LIMIT ${safeLimit + 1}
  `;
  const items = rows.slice(0, safeLimit).map(row => ({ ...row, cpuUsagePercent: Number(row.cpuUsagePercent), cpuTimeMs: Number(row.cpuTimeMs), memoryWorkingSetBytes: Number(row.memoryWorkingSetBytes), memoryLimitBytes: Number(row.memoryLimitBytes), occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt) })) as JobResourceSample[];
  return { items, nextCursor: rows.length > safeLimit ? items.at(-1)?.occurredAt ?? null : null };
}
