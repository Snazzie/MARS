import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineQueries, persistJobResourceSample, recordJobTimingSnapshot, applyWorkerCacheTelemetry, schema, type DatabaseClient, type JobTimingSnapshotInput } from "@mars/db";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { WorkerEvent, WorkerEventPayload, WorkerCacheTelemetry } from "@mars/contracts";
import type { AuthenticatedWorkerSocket, WorkerCommandDispatcher } from "./worker-dispatch.ts";
const queries = defineQueries(db => ({
  updateWorkerBuild: db.update(schema.workers).set({ doctor: sql`coalesce(${schema.workers.doctor},'{}'::jsonb) || ${sql.placeholder("doctor")}::jsonb`, doctorObservedAt: sql`now()`, lastHeartbeatAt: sql`now()`, connectionState: "online" }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_lifecycle_build_update"),
  terminalLogFence: db.select({ id: schema.dashboardJobs.id }).from(schema.dashboardJobs).innerJoin(schema.runnerLeases, eq(schema.runnerLeases.githubJobId, schema.dashboardJobs.githubJobId)).where(and(eq(schema.dashboardJobs.id, sql.placeholder("jobId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), inArray(schema.runnerLeases.state, ["reaped", "failed"]), sql`not exists (select 1 from runner_leases active where active.github_job_id=${schema.dashboardJobs.githubJobId} and active.worker_id=${sql.placeholder("workerId")} and active.state not in ('reaped','failed'))`)).limit(1).prepare("worker_lifecycle_terminal_log_fence"),
  reapedTiming: db.select({ jobId: schema.dashboardJobs.id, organizationId: schema.dashboardJobs.organizationId, runId: schema.dashboardJobs.runId, githubJobId: schema.dashboardJobs.githubJobId, jobName: schema.dashboardJobs.name, queuedAt: schema.dashboardJobs.queuedAt, startedAt: schema.dashboardJobs.startedAt, completedAt: schema.dashboardJobs.completedAt, conclusion: schema.dashboardJobs.conclusion, repositoryId: schema.dashboardRuns.repositoryId, repositoryName: schema.runnerPools.name, workflowName: schema.dashboardRuns.workflowName, workerId: schema.runnerLeases.workerId, runtimeBoundary: schema.dashboardRuns.runtimeBoundary, poolId: schema.runnerLeases.poolId, requested: schema.runnerLeases.requested, terminalResult: schema.runnerLeases.terminalResult, platform: schema.runnerPools.platform, driver: schema.runnerPools.driver, artifactDigest: schema.runnerPools.imageDigest, allocationStartedAt: schema.dashboardRunStages.startedAt, sandboxReadyAt: sql<string | null>`(select started_at from dashboard_run_stages where organization_id=${schema.dashboardJobs.organizationId} and run_id=${schema.dashboardJobs.runId} and stage='sandbox_ready')`, reapingStartedAt: schema.runnerLeases.updatedAt }).from(schema.dashboardJobs).innerJoin(schema.dashboardRuns, and(eq(schema.dashboardRuns.organizationId, schema.dashboardJobs.organizationId), eq(schema.dashboardRuns.id, schema.dashboardJobs.runId))).innerJoin(schema.runnerLeases, eq(schema.runnerLeases.githubJobId, schema.dashboardJobs.githubJobId)).leftJoin(schema.runnerPools, eq(schema.runnerPools.id, schema.runnerLeases.poolId)).leftJoin(schema.dashboardRunStages, and(eq(schema.dashboardRunStages.organizationId, schema.dashboardJobs.organizationId), eq(schema.dashboardRunStages.runId, schema.dashboardJobs.runId), eq(schema.dashboardRunStages.stage, "allocating"))).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.dashboardJobs.status, "completed"), sql`${schema.dashboardJobs.completedAt} is not null`)).limit(1).prepare("worker_lifecycle_reaped_timing"),
  resourceSamples: db.select({ occurredAt: schema.dashboardJobResourceSamples.occurredAt, cpuUsagePercent: schema.dashboardJobResourceSamples.cpuUsagePercent, cpuTimeMs: schema.dashboardJobResourceSamples.cpuTimeMs, memoryWorkingSetBytes: schema.dashboardJobResourceSamples.memoryWorkingSetBytes }).from(schema.dashboardJobResourceSamples).where(and(eq(schema.dashboardJobResourceSamples.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobResourceSamples.runId, sql.placeholder("runId")), eq(schema.dashboardJobResourceSamples.jobId, sql.placeholder("jobId")), eq(schema.dashboardJobResourceSamples.leaseId, sql.placeholder("leaseId")))).orderBy(schema.dashboardJobResourceSamples.occurredAt).prepare("worker_lifecycle_resource_samples"),
  attest: db.update(schema.runnerLeases).set({ state: "sandbox_ready", runtimeInstanceId: sql`${sql.placeholder("runtimeInstanceId")}`, terminalResult: sql`${sql.placeholder("terminalResult")}::jsonb`, expiresAt: sql`greatest(${schema.runnerLeases.expiresAt},now()+interval '10 minutes')`, updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), eq(schema.runnerLeases.state, "dispatched"))).returning({ id: schema.runnerLeases.id }).prepare("worker_lifecycle_attest"),
  decline: db.update(schema.runnerLeases).set({ state: "failed", cleanupState: "pending", terminalResult: sql`${sql.placeholder("terminalResult")}::jsonb`, updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), inArray(schema.runnerLeases.state, ["reserved", "dispatched"]))).returning({ id: schema.runnerLeases.id }).prepare("worker_lifecycle_decline"),
  finish: db.update(schema.runnerLeases).set({ state: sql`${sql.placeholder("state")}`, terminalResult: sql`${sql.placeholder("terminalResult")}::jsonb`, cleanupState: "pending", updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), inArray(schema.runnerLeases.state, ["sandbox_ready", "online", "busy"]))).returning({ id: schema.runnerLeases.id }).prepare("worker_lifecycle_finish"),
  cleanupFailed: db.update(schema.runnerLeases).set({ cleanupState: "failed", updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), inArray(schema.runnerLeases.state, ["completed", "failed"]))).returning({ id: schema.runnerLeases.id }).prepare("worker_lifecycle_cleanup_failed"),
  failStopCommand: db.update(schema.commands).set({ state: "failed" }).where(and(eq(schema.commands.id, sql.placeholder("commandId")), eq(schema.commands.workerId, sql.placeholder("workerId")), eq(schema.commands.leaseId, sql.placeholder("leaseId")), eq(schema.commands.state, "acknowledged"))).prepare("worker_lifecycle_fail_stop_command"),
  debugPreserve: db.update(schema.runnerLeases).set({ state: "failed", terminalResult: sql`coalesce(${schema.runnerLeases.terminalResult},'{}'::jsonb) || ${sql`${sql.placeholder("debugResult")}::jsonb`}`, cleanupState: "debug_preserved", updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), inArray(schema.runnerLeases.state, ["completed", "failed", "sandbox_ready", "online", "busy"]))).returning({ id: schema.runnerLeases.id }).prepare("worker_lifecycle_debug_preserve"),
  fail: db.update(schema.runnerLeases).set({ state: "failed", terminalResult: sql`${sql.placeholder("terminalResult")}::jsonb`, cleanupState: "pending", updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), inArray(schema.runnerLeases.state, ["dispatched", "provisioning", "sandbox_ready", "online", "busy"]))).returning({ id: schema.runnerLeases.id }).prepare("worker_lifecycle_fail"),
  reap: db.update(schema.runnerLeases).set({ state: "reaped", cleanupState: "completed", updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), inArray(schema.runnerLeases.state, ["completed", "failed"]))).returning({ id: schema.runnerLeases.id }).prepare("worker_lifecycle_reap"),
  reapContext: db.select({ commandType: schema.commands.type, terminalResult: schema.runnerLeases.terminalResult }).from(schema.runnerLeases).leftJoin(schema.commands, and(eq(schema.commands.id, sql.placeholder("commandId")), eq(schema.commands.leaseId, schema.runnerLeases.id), eq(schema.commands.workerId, schema.runnerLeases.workerId))).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")))).prepare("worker_lifecycle_reap_context"),
  workerLogJob: db.select({ organizationId: schema.dashboardJobs.organizationId, runId: schema.dashboardJobs.runId, jobId: schema.dashboardJobs.id }).from(schema.dashboardJobs).innerJoin(schema.runnerLeases, eq(schema.runnerLeases.githubJobId, schema.dashboardJobs.githubJobId)).where(and(eq(schema.dashboardJobs.id, sql.placeholder("jobId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), notInArray(schema.runnerLeases.state, ["reaped", "failed"]))).prepare("worker_lifecycle_log_job"),
  workerLogStep: db.select({ id: schema.dashboardJobSteps.id }).from(schema.dashboardJobSteps).where(and(eq(schema.dashboardJobSteps.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobSteps.runId, sql.placeholder("runId")), eq(schema.dashboardJobSteps.jobId, sql.placeholder("jobId")), eq(schema.dashboardJobSteps.id, sql.placeholder("stepId")))).prepare("worker_lifecycle_log_step"),
  workerLogChunk: db.insert(schema.dashboardLogChunks).values({ organizationId: sql.placeholder("organizationId"), runId: sql.placeholder("runId"), jobId: sql.placeholder("jobId"), sequence: sql.placeholder("sequence"), content: sql.placeholder("content"), occurredAt: sql.placeholder("occurredAt") }).onConflictDoNothing().prepare("worker_lifecycle_log_chunk"),
  workerStepLogChunk: db.insert(schema.dashboardStepLogChunks).values({ organizationId: sql.placeholder("organizationId"), runId: sql.placeholder("runId"), jobId: sql.placeholder("jobId"), stepId: sql.placeholder("stepId"), sequence: sql.placeholder("sequence"), content: sql.placeholder("content"), occurredAt: sql.placeholder("occurredAt") }).onConflictDoNothing().prepare("worker_lifecycle_step_log_chunk"),
}));
const q = queries;
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

async function persistDiagnosticChunk(workerId: string, payload: { jobId: string; leaseId: string; diagnosticId: string; sequence: number; content: string }): Promise<void> {
  const root = Bun.env.MARS_DIAGNOSTICS_ROOT ?? join(Bun.env.DATA_ROOT ?? "/var/lib/mars", "diagnostics");
  const directory = join(root, workerId, payload.diagnosticId);
  const path = join(directory, `${String(payload.sequence).padStart(8, "0")}.log`);
  await mkdir(directory, { recursive: true });
  const metadataPath = join(directory, "metadata.json");
  const metadata = JSON.stringify({ workerId, jobId: payload.jobId, leaseId: payload.leaseId, diagnosticId: payload.diagnosticId });
  try {
    await writeFile(metadataPath, metadata, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(metadataPath, "utf8") !== metadata) throw error;
  }
  try {
    await writeFile(path, payload.content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== payload.content) throw error;
  }
}

export async function handleAuthenticatedWorkerEvent(
  db: DatabaseClient,
  dispatcher: Pick<WorkerCommandDispatcher, "handleEvent">,
  input: unknown,
  socket: AuthenticatedWorkerSocket,
): Promise<boolean> {
  const event = WorkerEvent.safeParse(input);
  if (!event.success) return false;
  const cacheTelemetry = WorkerCacheTelemetry.safeParse({ type: event.data.type, payload: event.data.payload });
  if (cacheTelemetry.success) return await applyWorkerCacheTelemetry(db, { workerId: event.data.workerId, type: cacheTelemetry.data.type, payload: cacheTelemetry.data.payload });
  const payload = WorkerEventPayload.safeParse({ type: event.data.type, payload: event.data.payload });
  if (!payload.success) return false;
  if (payload.data.type === "diagnostic.chunk") {
    try {
      await persistDiagnosticChunk(event.data.workerId, payload.data.payload);
      return true;
    } catch (error) {
      console.error("Worker diagnostic chunk persistence failed", { workerId: event.data.workerId, workerName: socket.data?.workerName, diagnosticId: payload.data.payload.diagnosticId, sequence: payload.data.payload.sequence, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
  if (payload.data.type === "worker.logs") return dispatcher.handleEvent(event.data, socket);
  if (payload.data.type === "worker.build_completed" || payload.data.type === "worker.build_failed") {
    const ready = payload.data.payload.runtimeReady;
    await q(db).updateWorkerBuild.execute({ workerId: event.data.workerId, doctor: JSON.stringify({ runtimeReady: ready, runtimeBuildState: ready ? "ready" : "failed", runtimeBuildMessage: ready ? null : payload.data.payload.message, artifactSource: "worker_local", artifactIdentity: payload.data.payload.image, ...(payload.data.payload.imageId ? { artifactDigest: payload.data.payload.imageId } : {}), remediation: ready ? null : payload.data.payload.message }) });
    console.log("Windows image build event received", { workerId: event.data.workerId, workerName: socket.data?.workerName, type: payload.data.type, buildId: payload.data.payload.buildId, commandId: payload.data.payload.commandId, image: payload.data.payload.image, imageId: payload.data.payload.imageId, contentSha256: payload.data.payload.contentSha256, ...(payload.data.type === "worker.build_failed" ? { failureStage: payload.data.payload.failureStage, message: payload.data.payload.message } : {}) });
    dispatcher.handleEvent(event.data, socket);
    return true;
  }
  if (payload.data.type === "job.resource_sample") return (await persistJobResourceSample(db, event.data.workerId, event.data)) !== "rejected";
  if (payload.data.type === "job.log") {
    if (await persistWorkerLogEvent(db, event.data.workerId, payload.data.payload)) return true;
    const [terminal] = await q(db).terminalLogFence.execute({ jobId: payload.data.payload.jobId, workerId: event.data.workerId });
    if (!terminal) return false;
    console.warn("Discarding log for terminal worker lease", { workerId: event.data.workerId, workerName: socket.data?.workerName, jobId: payload.data.payload.jobId, eventId: event.data.id });
    return true;
  }
  await applyWorkerLeaseEvent(db, event.data, socket.data?.workerName);
  if (typeof event.data.payload.commandId === "string") dispatcher.handleEvent(event.data, socket);
  return true;
}

async function recordReapedJobTiming(db: DatabaseClient, leaseId: string, reapedAt: string): Promise<void> {
  const [row] = await q(db).reapedTiming.execute({ leaseId }) as Array<Record<string, unknown>>;
  if (!row) return;
  const requested = row.requested && typeof row.requested === "object" ? row.requested as Record<string, unknown> : null;
  const terminalResult = row.terminalResult && typeof row.terminalResult === "object" ? row.terminalResult as Record<string, unknown> : null;
  const asString = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;
  const queuedAt = asString(row.queuedAt), completedAt = asString(row.completedAt);
  if (!queuedAt || !completedAt || !requested) return;
  const startedAt = asString(row.startedAt);
  const telemetryRows = await q(db).resourceSamples.execute({ organizationId: String(row.organizationId), runId: String(row.runId), jobId: String(row.jobId), leaseId });
  const telemetry = aggregateResourceSamples(telemetryRows.map(sample => ({ occurredAt: asString(sample.occurredAt) ?? completedAt, cpuUsagePercent: Number(sample.cpuUsagePercent), cpuTimeMs: Number(sample.cpuTimeMs), memoryWorkingSetBytes: Number(sample.memoryWorkingSetBytes) })), startedAt ?? queuedAt, completedAt);
  const snapshot: JobTimingSnapshotInput = {
    organizationId: String(row.organizationId), jobId: String(row.jobId), runId: String(row.runId),
    repositoryId: String(row.repositoryId), githubJobId: Number(row.githubJobId), repositoryName: String(row.repositoryName),
    workflowName: String(row.workflowName), jobName: String(row.jobName), workerId: String(row.workerId), platform: String(row.platform),
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
export async function applyWorkerLeaseEvent(db: DatabaseClient, input: unknown, workerName?: string): Promise<boolean> {
  const parsedEvent = WorkerEvent.safeParse(input);
  if (!parsedEvent.success) return false;
  const event = parsedEvent.data;
  const parsedPayload = WorkerEventPayload.safeParse({ type: event.type, payload: event.payload });
  if (!parsedPayload.success || parsedPayload.data.type === "command.accepted" || parsedPayload.data.type === "worker.build_completed" || parsedPayload.data.type === "worker.build_failed" || parsedPayload.data.type === "worker.cache_entry_upsert" || parsedPayload.data.type === "worker.cache_entry_deleted" || parsedPayload.data.type === "worker.cache_snapshot_begin" || parsedPayload.data.type === "worker.cache_snapshot_page" || parsedPayload.data.type === "worker.cache_snapshot_end" || parsedPayload.data.type === "worker.runner_cache_status" || parsedPayload.data.type === "diagnostic.chunk" || parsedPayload.data.type === "worker.logs" || parsedPayload.data.type === "job.log" || parsedPayload.data.type === "job.resource_sample") return false;

  const transition = (applied: boolean, state: string): boolean => {
    console.log("Worker lease transition", { workerId: event.workerId, workerName, eventId: event.id, eventType: event.type, leaseId: event.payload.leaseId, commandId: event.payload.commandId, state, applied });
    return applied;
  };
  if (parsedPayload.data.type === "sandbox_attested") {
    const payload = parsedPayload.data.payload;
    const rows = await q(db).attest.execute({ runtimeInstanceId: payload.runtimeInstanceId, terminalResult: JSON.stringify({ observed: payload.observed }), leaseId: payload.leaseId, workerId: event.workerId, nonce: payload.nonce });
    if (!transition(Boolean(rows[0]), "sandbox_ready")) return false;
    return true;
  }
  if (parsedPayload.data.type === "lease.declined") {
    const payload = parsedPayload.data.payload;
    const rows = await q(db).decline.execute({ terminalResult: JSON.stringify({ reason: "pickup_paused" }), leaseId: payload.leaseId, workerId: event.workerId, nonce: payload.nonce });
    if (!transition(Boolean(rows[0]), "failed")) return false;
    return true;
  }
  if (parsedPayload.data.type === "runner.finished") {
    // Runner process completion is not GitHub job completion; startup can fail
    // while GitHub still has the job queued. Webhooks/discovery own job status.
    const payload = parsedPayload.data.payload;
    const outOfMemory = Boolean(payload.oom) || payload.termination?.container?.oomKilled === true;
    const failed = outOfMemory || payload.exitCode !== 0;
    const state = failed ? "failed" : "completed";
    const terminalResult = { exitCode: payload.exitCode, ...(outOfMemory ? { reason: "out_of_memory" } : {}), ...(payload.oom ? { oom: payload.oom } : {}), ...(payload.termination ? { termination: payload.termination } : {}), ...(payload.correlationId ? { correlationId: payload.correlationId } : {}) };
    const rows = await q(db).finish.execute({ state, terminalResult: JSON.stringify(terminalResult), leaseId: payload.leaseId, workerId: event.workerId, nonce: payload.nonce });
    if (!transition(Boolean(rows[0]), state)) return false;
    return true;
  }
  if (parsedPayload.data.type === "lease.failed") {
    const payload = parsedPayload.data.payload;
    if (payload.reason === "cleanup_failed") {
      return db.transaction(async tx => {
        const rows = await q(tx).cleanupFailed.execute({ leaseId: payload.leaseId, workerId: event.workerId, nonce: payload.nonce });
        if (!transition(Boolean(rows[0]), "cleanup_failed")) return false;
        if (typeof payload.commandId === "string") await q(tx).failStopCommand.execute({ commandId: payload.commandId, workerId: event.workerId, leaseId: payload.leaseId });
        return true;
      });
    }
    if (payload.reason === "debug_preserve") {
      const rows = await q(db).debugPreserve.execute({ debugResult: JSON.stringify({ debugPreserved: true }), leaseId: payload.leaseId, workerId: event.workerId, nonce: payload.nonce });
      if (!transition(Boolean(rows[0]), "debug_preserved")) return false;
      return true;
    }
    const terminalResult = { reason: payload.termination?.container?.oomKilled === true ? "out_of_memory" : payload.reason, ...(payload.oom ? { oom: payload.oom } : {}), ...(payload.termination ? { termination: payload.termination } : {}), ...(payload.correlationId ? { correlationId: payload.correlationId } : {}) };
    const rows = await q(db).fail.execute({ terminalResult: JSON.stringify(terminalResult), leaseId: payload.leaseId, workerId: event.workerId, nonce: payload.nonce });
    if (!transition(Boolean(rows[0]), "failed")) return false;
    return true;
  }
  if (parsedPayload.data.type !== "lease.reaped") return false;
  const payload = parsedPayload.data.payload;
  const rows = await q(db).reap.execute({ leaseId: payload.leaseId, workerId: event.workerId, nonce: payload.nonce });
  let context: { commandType: string | null; terminalResult: { reason?: string; exitCode?: number } | null } | undefined;
  try {
    [context] = await q(db).reapContext.execute({ commandId: payload.commandId ?? null, leaseId: payload.leaseId, workerId: event.workerId }) as typeof context[];
  } catch {
    // Observability must not prevent acknowledgement of a committed lease transition.
  }
  const source = context?.commandType?.endsWith(".stop_lease") ? "control_plane_stop" : context?.commandType?.endsWith(".create_lease") ? "worker_lifecycle" : "unknown";
  console.log("Worker lease transition", { workerId: event.workerId, workerName, eventId: event.id, eventType: event.type, leaseId: payload.leaseId, commandId: payload.commandId, state: "reaped", applied: Boolean(rows[0]), cleanupSource: source, terminalReason: context?.terminalResult?.reason ?? (context?.terminalResult?.exitCode === 0 ? "runner_succeeded" : context?.terminalResult?.exitCode != null ? "runner_failed" : "unknown") });
  if (!rows[0]) return false;
  await recordReapedJobTiming(db, payload.leaseId, event.occurredAt);
  return true;
}

type WorkerLogPayload = { jobId: string; stepId: string | null; sequence: number; content: string; occurredAt: string };

export async function persistWorkerLogEvent(db: DatabaseClient, workerId: string, payload: WorkerLogPayload): Promise<boolean> {
  const [job] = await q(db).workerLogJob.execute({ jobId: payload.jobId, workerId }) as Array<{ organizationId: string; runId: string; jobId: string }>;
  if (!job) return false;
  if (payload.stepId !== null) {
    const [step] = await q(db).workerLogStep.execute({ organizationId: job.organizationId, runId: job.runId, jobId: job.jobId, stepId: payload.stepId });
    if (!step) return false;
    await q(db).workerStepLogChunk.execute({ organizationId: job.organizationId, runId: job.runId, jobId: job.jobId, stepId: payload.stepId, sequence: payload.sequence, content: payload.content, occurredAt: payload.occurredAt });
  } else {
    await q(db).workerLogChunk.execute({ organizationId: job.organizationId, runId: job.runId, jobId: job.jobId, sequence: payload.sequence, content: payload.content, occurredAt: payload.occurredAt });
  }
  return true;
}
