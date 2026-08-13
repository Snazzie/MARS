import type { DatabaseClient } from "@whitesmith/db";
import { WorkerEvent, WorkerEventPayload } from "@whitesmith/contracts";
import type { AuthenticatedWorkerSocket, WorkerCommandDispatcher } from "./worker-dispatch.ts";

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
  if (payload.data.type === "command.accepted") return dispatcher.handleEvent(event.data, socket);
  if (payload.data.type === "job.log") return await persistWorkerLogEvent(db, event.data.workerId, payload.data.payload);
  await applyWorkerLeaseEvent(db, event.data);
  if (typeof event.data.payload.commandId === "string") dispatcher.handleEvent(event.data, socket);
  return true;
}

export async function applyWorkerLeaseEvent(db: DatabaseClient, input: unknown): Promise<boolean> {
  const parsedEvent = WorkerEvent.safeParse(input);
  if (!parsedEvent.success) return false;
  const event = parsedEvent.data;
  const parsedPayload = WorkerEventPayload.safeParse({ type: event.type, payload: event.payload });
  if (!parsedPayload.success || parsedPayload.data.type === "command.accepted" || parsedPayload.data.type === "job.log") return false;

  if (parsedPayload.data.type === "sandbox_attested") {
    const payload = parsedPayload.data.payload;
    const rows = await db`UPDATE runner_leases SET state='sandbox_ready',runtime_instance_id=${payload.runtimeInstanceId},terminal_result=${JSON.stringify({ observed: payload.observed })},updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state='dispatched' RETURNING id`;
    return Boolean(rows[0]);
  }
  if (parsedPayload.data.type === "runner.finished") {
    const payload = parsedPayload.data.payload;
    const state = payload.exitCode === 0 ? "completed" : "failed";
    const rows = await db`UPDATE runner_leases SET state=${state},terminal_result=${JSON.stringify({ exitCode: payload.exitCode })},cleanup_state='pending',updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state IN ('sandbox_ready','online','busy') RETURNING id`;
    return Boolean(rows[0]);
  }
  if (parsedPayload.data.type === "lease.failed") {
    const payload = parsedPayload.data.payload;
    if (payload.reason === "cleanup_failed") {
      const rows = await db`UPDATE runner_leases SET cleanup_state='failed',updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state IN ('completed','failed') RETURNING id`;
      return Boolean(rows[0]);
    }
    const rows = await db`UPDATE runner_leases SET state='failed',terminal_result=${JSON.stringify({ reason: payload.reason })},cleanup_state='pending',updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state IN ('dispatched','provisioning','sandbox_ready','online','busy') RETURNING id`;
    return Boolean(rows[0]);
  }
  const payload = parsedPayload.data.payload;
  const rows = await db`UPDATE runner_leases SET state='reaped',cleanup_state='completed',updated_at=now() WHERE id=${payload.leaseId} AND worker_id=${event.workerId} AND nonce=${payload.nonce} AND state IN ('completed','failed') RETURNING id`;
  return Boolean(rows[0]);
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
