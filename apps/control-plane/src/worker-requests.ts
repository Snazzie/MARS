import type { Sql } from "postgres";
import { verifyWorkerBootstrap } from "./worker-bootstrap.ts";
import { fingerprint } from "./workers.ts";
import { WorkerBootstrapRequest, PendingWorkerRequest, ApproveWorkerRequest } from "@whitesmith/contracts";

export class WorkerRequestError extends Error {
  constructor(public readonly code: "invalid_bootstrap" | "identity_conflict", public readonly status = code === "identity_conflict" ? 409 : 401) { super(code); }
}
export type WorkerRequestResult = { status: "created" | "existing"; workerId: string };
export type RequestLimiter = { allow(source: string): boolean; clear(source: string): void };
export function createRequestLimiter(max = 5, windowMs = 60_000): RequestLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return { allow(source) { const now = Date.now(); for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key); const bucket = buckets.get(source); if (!bucket) { buckets.set(source, { count: 1, resetAt: now + windowMs }); return true; } if (bucket.count >= max) return false; bucket.count++; return true; }, clear(source) { buckets.delete(source); } };
}
export function parseWorkerBootstrapRequest(input: unknown): WorkerBootstrapRequest { return WorkerBootstrapRequest.parse(input); }
export function parsePendingWorkerRequest(input: unknown): PendingWorkerRequest { return PendingWorkerRequest.parse(input); }
export function parseApproveWorkerRequest(input: unknown): ApproveWorkerRequest { return ApproveWorkerRequest.parse(input); }

export async function requestPendingWorker(db: Sql<{}>, input: WorkerBootstrapRequest, source?: string, limiter?: RequestLimiter): Promise<WorkerRequestResult> {
  const parsed = WorkerBootstrapRequest.parse(input);
  if (source && limiter && !limiter.allow(source)) throw new WorkerRequestError("invalid_bootstrap");
  if (!await verifyWorkerBootstrap(db, parsed.code)) throw new WorkerRequestError("invalid_bootstrap");
  if (source && limiter) limiter.clear(source);
  const fp = fingerprint(parsed.publicKey);
  return db.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext(${`whitesmith:worker:${parsed.machineUuid}`}))`;
    const rows = await tx<{ id: string; vmUuid: string | null; fingerprint: string | null }[]>`select id, vm_uuid as "vmUuid", fingerprint from workers where admission_state in ('pending','adopted') and (vm_uuid=${parsed.vmUuid} or fingerprint=${fp}) for update`;
    const exact = rows.find(row => row.vmUuid === parsed.vmUuid && row.fingerprint === fp);
    if (exact) {
      await tx`update workers set last_requested_at=now(), connection_state='online', doctor=${JSON.stringify(parsed.doctor)}::jsonb, limits=${JSON.stringify(parsed.limits)}::jsonb where id=${exact.id}`;
      return { status: "existing", workerId: exact.id };
    }
    if (rows.length) {
      await tx`insert into audit_events (actor,type,payload) values ('worker','worker.request.identity_conflict',${JSON.stringify({ vmUuid: parsed.vmUuid, fingerprint: fp })}::jsonb)`;
      throw new WorkerRequestError("identity_conflict");
    }
    const [created] = await tx<{ id: string }[]>`insert into workers (name,platform,admission_state,public_key,fingerprint,vm_uuid,limits,doctor,last_requested_at) values (${parsed.vmUuid},${parsed.platform},'pending',${parsed.publicKey},${fp},${parsed.vmUuid},${JSON.stringify(parsed.limits)}::jsonb,${JSON.stringify({ ...parsed.doctor, capacity: parsed.capacity })}::jsonb,now()) returning id`;
    await tx`insert into audit_events (actor,type,payload) values ('worker','worker.requested',${JSON.stringify({ workerId: created.id, vmUuid: parsed.vmUuid, fingerprint: fp })}::jsonb)`;
    return { status: "created", workerId: created.id };
  });
}

export async function approvePendingWorker(db: Sql<{}>, workerId: string, input: ApproveWorkerRequest, adminId: string): Promise<void> {
  const parsed = ApproveWorkerRequest.parse(input);
  await db.begin(async tx => {
    const rows = await tx`update workers set organization_id=${parsed.organizationId}, limits=${JSON.stringify(parsed.limits)}::jsonb, admission_state='adopted', configuration_state='unconfigured' where id=${workerId} and admission_state='pending' returning id`;
    if (rows.length !== 1) throw new Error("worker approval conflict");
    await tx`insert into audit_events (organization_id,actor,type,payload) values (${parsed.organizationId},${adminId},'worker.approved',${JSON.stringify({ workerId, limits: parsed.limits })}::jsonb)`;
  });
}
export async function rejectPendingWorker(db: Sql<{}>, workerId: string, adminId: string): Promise<void> { await db.begin(async tx => { const rows = await tx`update workers set admission_state='rejected' where id=${workerId} and admission_state='pending' returning id`; if (rows.length !== 1) throw new Error("worker rejection conflict"); await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.rejected',${JSON.stringify({ workerId })}::jsonb)`; }); }
