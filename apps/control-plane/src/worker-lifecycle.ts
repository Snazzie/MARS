import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonParameter, persistJobResourceSample, recordJobTimingSnapshot, type DatabaseClient, type JobTimingSnapshotInput } from "@whitesmith/db";
import { WorkerEvent, WorkerEventPayload } from "@whitesmith/contracts";
import type { AuthenticatedWorkerSocket, WorkerCommandDispatcher } from "./worker-dispatch.ts";
export type TimingBoundaryInputs = {
  queuedAt: string;
  startedAt: string | null;
  completedAt: string;
  allocationStartedAt: string | null;
  sandboxReadyAt: string | null;
  reapingStartedAt: string | null;
  reapedAt: string | null;
};

export function timingDurations(input: TimingBoundaryInputs) {
  const ms = (from: string | null, to: string | null) => from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : 0;
  const queueDurationMs = ms(input.queuedAt, input.startedAt ?? input.completedAt);
  const startupDurationMs = ms(input.allocationStartedAt ?? input.startedAt, input.sandboxReadyAt);
  const executionDurationMs = ms(input.sandboxReadyAt ?? input.startedAt, input.completedAt);
  const cleanupDurationMs = ms(input.reapingStartedAt, input.reapedAt);
  return {
    queueDurationMs,
    startupDurationMs,
    executionDurationMs,
    cleanupDurationMs,
    totalDurationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.queuedAt)),
  };
}
export function aggregateResourceSamples(samples: Array<{ occurredAt: string; cpuUsagePercent: number; cpuTimeMs: number; memoryWorkingSetBytes: number }>, executionStart: string, completedAt: string) {
  if (!samples.length) return { telemetryState: "unavailable" as const, telemetrySampleCount: 0, cpuAveragePercent: null, cpuP50Percent: null, cpuP95Percent: null, cpuPeakPercent: null, cpuTimeMs: null, memoryAverageBytes: null, memoryPeakBytes: null };
  const ordered = [...samples].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const cpu = ordered.map(sample => sample.cpuUsagePercent).sort((a, b) => a - b);
  const percentile = (values: number[], p: number) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))]!;
  const gaps = ordered.slice(1).map((sample, index) => Date.parse(sample.occurredAt) - Date.parse(ordered[index]!.occurredAt));
  const coverage = Math.abs(Date.parse(ordered[0]!.occurredAt) - Date.parse(executionStart)) <= 10_000 && Math.abs(Date.parse(completedAt) - Date.parse(ordered.at(-1)!.occurredAt)) <= 10_000 && gaps.every(gap => gap <= 15_000);
  return { telemetryState: (coverage ? "available" : "partial") as "available" | "partial", telemetrySampleCount: ordered.length, cpuAveragePercent: cpu.reduce((sum, value) => sum + value, 0) / cpu.length, cpuP50Percent: percentile(cpu, 0.5), cpuP95Percent: percentile(cpu, 0.95), cpuPeakPercent: Math.max(...cpu), cpuTimeMs: ordered.reduce((sum, sample) => sum + sample.cpuTimeMs, 0), memoryAverageBytes: Math.round(ordered.reduce((sum, sample) => sum + sample.memoryWorkingSetBytes, 0) / ordered.length), memoryPeakBytes: Math.max(...ordered.map(sample => sample.memoryWorkingSetBytes)) };
}

async function persistDiagnosticChunk(workerId: string, payload: { diagnosticId: string; sequence: number; content: string }): Promise<void> {
  const root = Bun.env.WHITESMITH_DIAGNOSTICS_ROOT ?? join(Bun.env.DATA_ROOT ?? "/var/lib/whitesmith", "diagnostics");
  const directory = join(root, workerId, payload.diagnosticId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${String(payload.sequence).padStart(8, "0")}.log`), payload.content, { encoding: "utf8", flag: "wx" });
}

export async function handleAuthenticatedWorkerEvent(
  db: DatabaseClient,
  dispatcher: Pick<WorkerCommandDispatcher, "handleEvent">,
  input: unknown,
  socket: AuthenticatedWorkerSocket,
): Promise<boolean> {
  const event = WorkerEvent.safeParse(input);
  if (!event.success) return false;
  const payload = WorkerEventPayload.safeParse({ type: event.data.type, payload: event.data.payload });
  if (!payload.success) return false;
  if (payload.data.type === "diagnostic.chunk") {
    try {
      await persistDiagnosticChunk(event.data.workerId, payload.data.payload);
      return true;
    } catch (error) {
      console.error("Worker diagnostic chunk persistence failed", { workerId: event.data.workerId, diagnosticId: payload.data.payload.diagnosticId, sequence: payload.data.payload.sequence, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
  if (payload.data.type === "job.resource_sample") return (await persistJobResourceSample(db, event.data.workerId, event.data)) !== "rejected";
  if (payload.data.type === "job.log") return await persistWorkerLogEvent(db, event.data.workerId, payload.data.payload);
  await applyWorkerLeaseEvent(db, event.data);
  if (typeof event.data.payload.commandId === "string") dispatcher.handleEvent(event.data, socket);
  return true;
}

async function recordReapedJobTiming(db: DatabaseClient, leaseId: string, reapedAt: string): Promise<void> {
  const [row] = await db<Record<string, unknown>[]>`
    SELECT j.id AS "jobId", j.organization_id AS "organizationId", j.run_id AS "runId",
      j.github_job_id AS "githubJobId", j.name AS "jobName", j.queued_at AS "queuedAt",
      j.started_at AS "startedAt", j.completed_at AS "completedAt", j.conclusion,
      r.repository_id AS "repositoryId", p.name AS "repositoryName", r.workflow_name AS "workflowName",
      r.runtime_boundary AS "runtimeBoundary", l.pool_id AS "poolId", l.requested,
      l.terminal_result AS "terminalResult", p.platform, p.driver, p.image_digest AS "artifactDigest",
      s.started_at AS "allocationStartedAt",
      (SELECT started_at FROM dashboard_run_stages WHERE organization_id=j.organization_id AND run_id=j.run_id AND stage='sandbox_ready') AS "sandboxReadyAt",
      l.updated_at AS "reapingStartedAt"
    FROM dashboard_jobs j
    JOIN dashboard_runs r ON r.organization_id=j.organization_id AND r.id=j.run_id
    JOIN runner_leases l ON l.github_job_id=j.github_job_id
    LEFT JOIN runner_pools p ON p.id=l.pool_id
    LEFT JOIN dashboard_run_stages s ON s.organization_id=j.organization_id AND s.run_id=j.run_id AND s.stage='allocating'
    WHERE l.id=${leaseId} AND j.status='completed' AND j.completed_at IS NOT NULL
    LIMIT 1
  `;
  if (!row) return;
  const requested = row.requested && typeof row.requested === "object" ? row.requested as Record<string, unknown> : null;
  const terminalResult = row.terminalResult && typeof row.terminalResult === "object" ? row.terminalResult as Record<string, unknown> : null;
  const asString = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;
  const queuedAt = asString(row.queuedAt), completedAt = asString(row.completedAt);
  if (!queuedAt || !completedAt || !requested) return;
  const startedAt = asString(row.startedAt);
  const telemetryRows = await db<Record<string, unknown>[]>`SELECT occurred_at AS "occurredAt",cpu_usage_percent AS "cpuUsagePercent",cpu_time_ms AS "cpuTimeMs",memory_working_set_bytes AS "memoryWorkingSetBytes" FROM dashboard_job_resource_samples WHERE organization_id=${String(row.organizationId)} AND run_id=${String(row.runId)} AND job_id=${String(row.jobId)} AND lease_id=${leaseId} ORDER BY occurred_at`;
  const telemetry = aggregateResourceSamples(telemetryRows.map(sample => ({ occurredAt: asString(sample.occurredAt) ?? completedAt, cpuUsagePercent: Number(sample.cpuUsagePercent), cpuTimeMs: Number(sample.cpuTimeMs), memoryWorkingSetBytes: Number(sample.memoryWorkingSetBytes) })), startedAt ?? queuedAt, completedAt);
  const snapshot: JobTimingSnapshotInput = {
    organizationId: String(row.organizationId), jobId: String(row.jobId), runId: String(row.runId),
    repositoryId: String(row.repositoryId), githubJobId: Number(row.githubJobId), repositoryName: String(row.repositoryName),
    workflowName: String(row.workflowName), jobName: String(row.jobName), platform: String(row.platform),
    driver: String(row.driver), runtimeBoundary: row.runtimeBoundary ? String(row.runtimeBoundary) : null,
    poolId: row.poolId ? String(row.poolId) : null, artifactDigest: row.artifactDigest ? String(row.artifactDigest) : null,
    outcome: String(row.conclusion ?? (Number(terminalResult?.exitCode) === 0 ? "success" : "failure")) as JobTimingSnapshotInput["outcome"],
    completedAt, queuedAt, startedAt,
    ...timingDurations({ queuedAt, startedAt, completedAt, allocationStartedAt: asString(row.allocationStartedAt), sandboxReadyAt: asString(row.sandboxReadyAt), reapingStartedAt: asString(row.reapingStartedAt), reapedAt }),
    requestedVcpu: Number(requested.vcpu), requestedMemoryBytes: Number(requested.memoryBytes), requestedStorageBytes: Number(requested.storageBytes),
    requestedConcurrency: Number(requested.concurrency), observedVcpu: null, observedMemoryBytes: null, observedStorageBytes: null,
    effectiveConcurrency: Number(requested.concurrency), ...telemetry,
  };
  if (Object.values(snapshot).some(value => value === "undefined" || (typeof value === "number" && !Number.isFinite(value)))) return;
  await recordJobTimingSnapshot(db, snapshot);
}
export async function applyWorkerLeaseEvent(db: DatabaseClient, input: unknown): Promise<boolean> {
  const parsedEvent = WorkerEvent.safeParse(input);
  if (!parsedEvent.success) return false;
  const event = parsedEvent.data;
  const parsedPayload = WorkerEventPayload.safeParse({ type: event.type, payload: event.payload });
  if (!parsedPayload.success || parsedPayload.data.type === "command.accepted" || parsedPayload.data.type === "diagnostic.chunk" || parsedPayload.data.type === "job.log" || parsedPayload.data.type === "job.resource_sample") return false;

  if (parsedPayload.data.type === "sandbox_attested") {
    const payload = parsedPayload.data.payload;
    const rows = await db`UPDATE runner_leases SET state='sandbox_ready',runtime_instance_id=${payload.runtimeInstanceId},terminal_result=${jsonParameter(db, { observed: payload.observed })},updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state='dispatched' RETURNING id`;
    if (!rows[0]) return false;
    const [job] = await db`SELECT j.id,j.organization_id AS "organizationId",j.run_id AS "runId" FROM dashboard_jobs j JOIN runner_leases l ON l.github_job_id=j.github_job_id WHERE l.id=${payload.leaseId}`;
    if (job) {
      await db`UPDATE dashboard_jobs SET status='in_progress',stage='running',started_at=COALESCE(started_at,now()) WHERE id=${job.id} AND status='queued'`;
      await db`UPDATE dashboard_runs SET status='in_progress',started_at=COALESCE(started_at,now()) WHERE organization_id=${job.organizationId} AND id=${job.runId} AND status='queued'`;
    }
    return true;
  }
  if (parsedPayload.data.type === "runner.finished") {
    const payload = parsedPayload.data.payload;
    const state = payload.oom ? "failed" : payload.exitCode === 0 ? "completed" : "failed";
    const terminalResult = payload.oom ? { exitCode: payload.exitCode, reason: "out_of_memory", oom: payload.oom } : { exitCode: payload.exitCode };
    const rows = await db`UPDATE runner_leases SET state=${state},terminal_result=${jsonParameter(db, terminalResult)},cleanup_state='pending',updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state IN ('sandbox_ready','online','busy') RETURNING id`;
    return Boolean(rows[0]);
  }
  if (parsedPayload.data.type === "lease.failed") {
    const payload = parsedPayload.data.payload;
    if (payload.reason === "cleanup_failed") {
      const rows = await db`UPDATE runner_leases SET cleanup_state='failed',updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state IN ('completed','failed') RETURNING id`;
      return Boolean(rows[0]);
    }
    const terminalResult = payload.oom ? { reason: payload.reason, oom: payload.oom } : { reason: payload.reason };
    const rows = await db`UPDATE runner_leases SET state='failed',terminal_result=${jsonParameter(db, terminalResult)},cleanup_state='pending',updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state IN ('dispatched','provisioning','sandbox_ready','online','busy') RETURNING id`;
    return Boolean(rows[0]);
  }
  const payload = parsedPayload.data.payload;
  const rows = await db`UPDATE runner_leases SET state='reaped',cleanup_state='completed',updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state IN ('completed','failed') RETURNING id`;
  if (!rows[0]) return false;
  await recordReapedJobTiming(db, payload.leaseId, event.occurredAt);
  return true;
}

type WorkerLogPayload = { jobId: string; stepId: string | null; sequence: number; content: string; occurredAt: string };

export async function persistWorkerLogEvent(db: DatabaseClient, workerId: string, payload: WorkerLogPayload): Promise<boolean> {
  const [job] = await db`SELECT j.organization_id AS "organizationId", j.run_id AS "runId", j.id AS "jobId"
    FROM dashboard_jobs j JOIN runner_leases l ON l.github_job_id=j.github_job_id
    WHERE j.id=${payload.jobId} AND l.worker_id=${workerId} AND l.state NOT IN ('reaped','failed')`;
  if (!job) return false;
  if (payload.stepId !== null) {
    const [step] = await db`SELECT id FROM dashboard_job_steps
      WHERE organization_id=${job.organizationId} AND run_id=${job.runId} AND job_id=${job.jobId} AND id=${payload.stepId}`;
    if (!step) return false;
    await db`INSERT INTO dashboard_step_log_chunks (organization_id,run_id,job_id,step_id,sequence,content,occurred_at)
      VALUES (${job.organizationId},${job.runId},${job.jobId},${payload.stepId},${payload.sequence},${payload.content},${payload.occurredAt})
      ON CONFLICT (organization_id,run_id,job_id,step_id,sequence) DO NOTHING`;
  } else {
    await db`INSERT INTO dashboard_log_chunks (organization_id,run_id,job_id,sequence,content,occurred_at)
      VALUES (${job.organizationId},${job.runId},${job.jobId},${payload.sequence},${payload.content},${payload.occurredAt})
      ON CONFLICT (organization_id,run_id,job_id,sequence) DO NOTHING`;
  }
  return true;
}
