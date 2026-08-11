import type { Sql } from "postgres";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WorkerBootstrapRequest, PendingWorkerRequest, ApproveWorkerRequest, WorkerConfiguration, WorkerConfigurePayload } from "@whitesmith/contracts";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";
import { fingerprint } from "./workers.ts";

export class WorkerRequestError extends Error {
  constructor(public readonly code: "invalid_bootstrap" | "identity_conflict", public readonly status = code === "identity_conflict" ? 409 : 401) { super(code); }
}
export type WorkerRequestResult = { status: "created" | "existing"; workerId: string };
export type RequestLimiter = { allow(source: string): boolean; clear(source: string): void };
export function createRequestLimiter(max = 5, windowMs = 60_000): RequestLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return { allow(source) { const now = Date.now(); for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key); const bucket = buckets.get(source); if (!bucket) { buckets.set(source, { count: 1, resetAt: now + windowMs }); return true; } if (bucket.count >= max) return false; bucket.count++; return true; }, clear(source) { buckets.delete(source); } };
}
export function matchesWorkerIdentity(row: { vmUuid: string | null; machineUuid: string | null; fingerprint: string | null }, input: Pick<WorkerBootstrapRequest, "vmUuid" | "machineUuid">, fingerprintValue: string): boolean { return row.vmUuid === input.vmUuid && row.machineUuid === input.machineUuid && row.fingerprint === fingerprintValue; }
export function hasMachineIdentity(row: Record<string, unknown>): boolean { return typeof row.machineUuid === "string" && row.machineUuid.length > 0; }
export function parseWorkerBootstrapRequest(input: unknown): WorkerBootstrapRequest { return WorkerBootstrapRequest.parse(input); }
export function parsePendingWorkerRequest(input: unknown): PendingWorkerRequest { return PendingWorkerRequest.parse(input); }
export function parseApproveWorkerRequest(input: unknown): ApproveWorkerRequest { return ApproveWorkerRequest.parse(input); }

export async function requestPendingWorker(db: Sql<{}>, input: WorkerBootstrapRequest, source?: string, limiter?: RequestLimiter): Promise<WorkerRequestResult> {
  const parsed = WorkerBootstrapRequest.parse(input);
  if (source && limiter && !limiter.allow(source)) throw new WorkerRequestError("invalid_bootstrap");
  const fp = fingerprint(parsed.publicKey);
  const lockKeys = [`machine:${parsed.machineUuid}`, `vm:${parsed.vmUuid}`, `fingerprint:${fp}`].sort();
  const outcome = await db.begin(async tx => {
    for (const key of lockKeys) await tx`select pg_advisory_xact_lock(hashtext(${`whitesmith:worker:${key}`}))`;
    const [credential] = await tx<{ codeHash: Buffer }[]>`select code_hash as "codeHash" from worker_bootstrap_credentials where singleton=true for update`;
    const candidate = createHash("sha256").update(Buffer.from(parsed.code, "base64url")).digest();
    if (!credential || credential.codeHash.length !== candidate.length || !timingSafeEqual(credential.codeHash, candidate)) return { conflict: false as const, invalid: true as const };
    const rows = await tx<{ id: string; vmUuid: string | null; machineUuid: string | null; fingerprint: string | null }[]>`select id, vm_uuid as "vmUuid", machine_uuid as "machineUuid", fingerprint from workers where admission_state in ('pending','adopted') and (vm_uuid=${parsed.vmUuid} or machine_uuid=${parsed.machineUuid} or fingerprint=${fp}) for update`;
    const exact = rows.find(row => matchesWorkerIdentity(row, parsed, fp));
    if (exact) {
      await tx`update workers set last_requested_at=now(), connection_state='online', machine_uuid=${parsed.machineUuid}, doctor=${JSON.stringify({ doctor: parsed.doctor, capacity: parsed.capacity })}::jsonb where id=${exact.id}`;
      return { status: "existing" as const, workerId: exact.id };
    }
    if (rows.length) return { conflict: true as const, invalid: false as const };
    const [created] = await tx<{ id: string }[]>`insert into workers (name,platform,admission_state,public_key,fingerprint,vm_uuid,machine_uuid,limits,doctor,last_requested_at) values (${parsed.vmUuid},${parsed.platform},'pending',${parsed.publicKey},${fp},${parsed.vmUuid},${parsed.machineUuid},null,${JSON.stringify({ doctor: parsed.doctor, capacity: parsed.capacity })}::jsonb,now()) returning id`;
    await tx`insert into audit_events (actor,type,payload) values ('worker','worker.requested',${JSON.stringify({ workerId: created.id, vmUuid: parsed.vmUuid, fingerprint: fp })}::jsonb)`;
    return { status: "created" as const, workerId: created.id };
  });
  if ("invalid" in outcome && outcome.invalid) throw new WorkerRequestError("invalid_bootstrap");
  if ("conflict" in outcome && outcome.conflict) {
    await db`insert into audit_events (actor,type,payload) values ('worker','worker.request.identity_conflict',${JSON.stringify({ vmUuid: parsed.vmUuid, fingerprint: fp })}::jsonb)`;
    throw new WorkerRequestError("identity_conflict");
  }
  if (source && limiter) limiter.clear(source);
  return outcome;
}

export async function approvePendingWorker(db: Sql<{}>, workerId: string, input: ApproveWorkerRequest, adminId: string): Promise<void> {
  const parsed = ApproveWorkerRequest.parse(input);
  await db.begin(async tx => {
    const rows = await tx`update workers set organization_id=${parsed.organizationId}, limits=${JSON.stringify(parsed.limits)}::jsonb, admission_state='adopted', configuration_state='unconfigured' where id=${workerId} and admission_state='pending' returning id`;
    if (rows.length !== 1) throw new Error("worker approval conflict");
    await tx`insert into audit_events (organization_id,actor,type,payload) values (${parsed.organizationId},${adminId},'worker.approved',${JSON.stringify({ workerId, limits: parsed.limits })}::jsonb)`;
  });
}
export type WorkerConfigurationInput = { appliance: { vcpu: number; memoryBytes: number; storageBytes: number }; runtime: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number } };
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
export async function configurePendingWorker(db: Sql<{}>, workerId: string, organizationId: string, configuration: WorkerConfigurationInput, adminId: string, dispatcher?: WorkerCommandDispatcher, idempotencyKey?: string): Promise<{ revision: string; fingerprint: string; commandId?: string }> {
  const parsed = WorkerConfiguration.parse(configuration);
  const revision = createHash("sha256").update(canonical(parsed)).digest("hex");
  const fp = createHash("sha256").update(`${workerId}:${organizationId}:${revision}`).digest("hex");
  const commandId = randomUUID();
  const payload = { workerId, appliance: parsed.appliance, runtime: parsed.runtime, revision, fingerprint: fp };
  await db.begin(async tx => {
    if (idempotencyKey) {
      await tx`select pg_advisory_xact_lock(hashtext(${`whitesmith:configure:${organizationId}:${idempotencyKey}`}))`;
      const prior = await tx`select response from dashboard_mutations where organization_id=${organizationId} and idempotency_key=${idempotencyKey}`;
      if (prior.length) throw new Error("configuration already completed");
    }
    const rows = await tx<{ id: string; doctor: unknown; admissionState: string; organizationId: string | null }[]>`select id, doctor, admission_state as "admissionState", organization_id as "organizationId" from workers where id=${workerId} for update`;
    const row = rows[0]; if (!row || row.admissionState !== "adopted" || row.organizationId !== organizationId) throw new Error("worker configuration conflict");
    const telemetry = row.doctor && typeof row.doctor === "object" ? row.doctor as Record<string, unknown> : {};
    const capacity = telemetry.capacity && typeof telemetry.capacity === "object" ? telemetry.capacity as Record<string, number> : {};
    if (parsed.appliance.vcpu > (capacity.freeVcpu ?? 0) || parsed.appliance.memoryBytes > (capacity.freeMemoryBytes ?? 0) || parsed.appliance.storageBytes > (capacity.freeStorageBytes ?? 0)) throw new Error("worker configuration exceeds capacity");
    if (parsed.runtime.maxVcpuPerPod * parsed.runtime.maxConcurrentPods > parsed.appliance.vcpu || parsed.runtime.maxMemoryBytesPerPod * parsed.runtime.maxConcurrentPods > parsed.appliance.memoryBytes || parsed.runtime.maxStorageBytesPerPod * parsed.runtime.maxConcurrentPods > parsed.appliance.storageBytes) throw new Error("worker configuration exceeds capacity");
    await tx`update workers set limits=${JSON.stringify(parsed.runtime)}::jsonb, configuration_state='unconfigured' where id=${workerId}`;
    await tx`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${commandId},1,'worker.configure',${workerId},null,now(),${JSON.stringify(payload)}::jsonb)`;
    await tx`insert into audit_events (organization_id,actor,type,payload) values (${organizationId},${adminId},'worker.configured',${JSON.stringify({ workerId, revision, fingerprint: fp })}::jsonb)`;
    if (idempotencyKey) await tx`insert into dashboard_mutations (organization_id,idempotency_key,response) values (${organizationId},${idempotencyKey},${JSON.stringify({ revision, fingerprint: fp, commandId })}::jsonb)`;
  });
  if (!dispatcher) return { revision, fingerprint: fp, commandId };
  const event = await dispatcher.dispatch({ type: "worker.configure", workerId, leaseId: null, payload });
  return { revision, fingerprint: fp, commandId: event.payload.commandId as string };
}
export async function applyWorkerConfigurationAcknowledgement(db: Sql<{}>, event: { workerId: string; payload: unknown }): Promise<boolean> {
  const input = event.payload as Record<string, unknown>;
  const observed = WorkerConfiguration.safeParse(input?.observed);
  const commandId = typeof input?.commandId === "string" ? input.commandId : "";
  const revision = typeof input?.revision === "string" ? input.revision : "";
  const [command] = await db<{ payload: unknown }[]>`select payload from commands where id=${commandId} and worker_id=${event.workerId} and type='worker.configure'`;
  const expected = command?.payload as Record<string, unknown> | undefined;
  const exact = observed.success && expected && revision === expected.revision && canonical(observed.data) === canonical({ appliance: expected.appliance, runtime: expected.runtime });
  if (!exact) { await db`update workers set configuration_state='error' where id=${event.workerId}`; return false; }
  await db`update workers set configuration_state='ready' where id=${event.workerId}`;
  return true;
}
export async function rejectPendingWorker(db: Sql<{}>, workerId: string, adminId: string): Promise<void> { await db.begin(async tx => { const rows = await tx`update workers set admission_state='rejected' where id=${workerId} and admission_state='pending' returning id`; if (rows.length !== 1) throw new Error("worker rejection conflict"); await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.rejected',${JSON.stringify({ workerId })}::jsonb)`; }); }
