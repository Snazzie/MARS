import type { Sql } from "@whitesmith/db";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WorkerBootstrapRequest, PendingWorkerRequest, ApproveWorkerRequest, WorkerConfiguration, WorkerConfigurePayload, validateWorkerGuestPlatforms, type GuestPlatform } from "@whitesmith/contracts";
import { jsonParameter } from "@whitesmith/db";
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
  const guestPlatforms: GuestPlatform[] = parsed.platform === "windows-x64" ? ["windows-x64"] : [parsed.platform];
  const lockKeys = [`machine:${parsed.machineUuid}`, `vm:${parsed.vmUuid}`, `fingerprint:${fp}`].sort();
  const outcome = await db.begin(async tx => {
    const telemetry = { doctor: parsed.doctor, capacity: parsed.capacity };
    for (const key of lockKeys) await tx`select pg_advisory_xact_lock(hashtext(${`whitesmith:worker:${key}`}))`;
    const [credential] = await tx<{ codeHash: Buffer }[]>`select code_hash as "codeHash" from worker_bootstrap_credentials where singleton=true and consumed_at is null for update`;
    const candidate = createHash("sha256").update(Buffer.from(parsed.code, "base64url")).digest();
    if (!credential || credential.codeHash.length !== candidate.length || !timingSafeEqual(credential.codeHash, candidate)) return { conflict: false as const, invalid: true as const };
    const rows = await tx<{ id: string; vmUuid: string | null; machineUuid: string | null; fingerprint: string | null; encryptionPublicKey: string | null }[]>`select id, vm_uuid as "vmUuid", machine_uuid as "machineUuid", fingerprint, encryption_public_key as "encryptionPublicKey" from workers where admission_state in ('pending','adopted') and (vm_uuid=${parsed.vmUuid} or machine_uuid=${parsed.machineUuid} or fingerprint=${fp}) for update`;
    const exact = rows.find(row => matchesWorkerIdentity(row, parsed, fp));
    if (exact) {
      if (exact.encryptionPublicKey && exact.encryptionPublicKey !== parsed.encryptionPublicKey) return { conflict: true as const, invalid: false as const };
      await tx`update worker_bootstrap_credentials set consumed_at=now() where singleton=true and consumed_at is null`;
      await tx`update workers set last_requested_at=now(), connection_state='offline', machine_uuid=${parsed.machineUuid}, encryption_public_key=${parsed.encryptionPublicKey}, doctor=${jsonParameter(tx, telemetry)}::jsonb, doctor_observed_at=now() where id=${exact.id}`;
      return { status: "existing" as const, workerId: exact.id };
    }
    if (rows.length) return { conflict: true as const, invalid: false as const };
    await tx`update worker_bootstrap_credentials set consumed_at=now() where singleton=true and consumed_at is null`;
    const [created] = await tx<{ id: string }[]>`insert into workers (name,platform,guest_platforms,admission_state,public_key,encryption_public_key,fingerprint,vm_uuid,machine_uuid,limits,doctor,last_requested_at,doctor_observed_at) values (${parsed.vmUuid},${parsed.platform},${jsonParameter(tx, guestPlatforms)}::jsonb,'pending',${parsed.publicKey},${parsed.encryptionPublicKey},${fp},${parsed.vmUuid},${parsed.machineUuid},null,${jsonParameter(tx, telemetry)}::jsonb,now(),now()) returning id`;
    await tx`insert into audit_events (actor,type,payload) values ('worker','worker.requested',${jsonParameter(tx, { workerId: created.id, vmUuid: parsed.vmUuid, fingerprint: fp, guestPlatforms })}::jsonb)`;
    return { status: "created" as const, workerId: created.id };
  });
  if ("invalid" in outcome && outcome.invalid) throw new WorkerRequestError("invalid_bootstrap");
  if ("conflict" in outcome && outcome.conflict) {
    await db`insert into audit_events (actor,type,payload) values ('worker','worker.request.identity_conflict',${jsonParameter(db, { vmUuid: parsed.vmUuid, fingerprint: fp })}::jsonb)`;
    throw new WorkerRequestError("identity_conflict");
  }
  if (source && limiter) limiter.clear(source);
  return outcome;
}

export async function approvePendingWorker(db: Sql<{}>, workerId: string, input: ApproveWorkerRequest, adminId: string): Promise<void> {
  const parsed = ApproveWorkerRequest.parse(input);
  await db.begin(async tx => {
    const rows = await tx`update workers set limits=${jsonParameter(tx, parsed.limits)}::jsonb, admission_state='adopted', configuration_state='unconfigured' where id=${workerId} and admission_state='pending' returning id`;
    if (rows.length !== 1) throw new Error("worker approval conflict");
    await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.approved',${jsonParameter(tx, { workerId, limits: parsed.limits })}::jsonb)`;
  });
}
export type WorkerConfigurationInput = { appliance: { vcpu: number; memoryBytes: number; storageBytes: number }; runtime: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number }; guestPlatforms?: GuestPlatform[] };
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
export async function configurePendingWorker(db: Sql<{}>, workerId: string, configuration: WorkerConfigurationInput, adminId: string, dispatcher?: WorkerCommandDispatcher, idempotencyKey?: string): Promise<{ revision: string; fingerprint: string; commandId?: string }> {
  const parsed = WorkerConfiguration.parse({ ...configuration, guestPlatforms: configuration.guestPlatforms ?? ["macos-arm64"] });
  const revision = createHash("sha256").update(canonical(parsed)).digest("hex");
  const fp = createHash("sha256").update(`${workerId}:${revision}`).digest("hex");
  const commandId = randomUUID();
  const payload = { workerId, appliance: parsed.appliance, runtime: parsed.runtime, guestPlatforms: parsed.guestPlatforms, revision, fingerprint: fp };
  const response = await db.begin(async tx => {
    if (idempotencyKey) {
      await tx`select pg_advisory_xact_lock(hashtext(${`whitesmith:configure:${workerId}:${idempotencyKey}`}))`;
      const prior = await tx<{ response: { revision: string; fingerprint: string; commandId?: string } | null }[]>`select response from worker_mutations where worker_id=${workerId} and idempotency_key=${idempotencyKey}`;
      if (prior[0]?.response) return prior[0].response;
    }
    const rows = await tx<{ id: string; doctor: unknown; admissionState: string; platform: GuestPlatform; guestPlatforms: GuestPlatform[]; draining: boolean }[]>`select id, doctor, admission_state as "admissionState", platform, guest_platforms as "guestPlatforms", draining from workers where id=${workerId} for update`;
    const row = rows[0]; if (!row || !["pending", "adopted"].includes(row.admissionState)) throw new Error("worker configuration conflict");
    if (!validateWorkerGuestPlatforms(row.platform, parsed.guestPlatforms)) throw new Error("worker guest platform configuration conflict");
    const priorPlatforms = Array.isArray(row.guestPlatforms) ? row.guestPlatforms : [row.platform];
    if (row.admissionState === "adopted" && canonical(priorPlatforms) !== canonical(parsed.guestPlatforms)) {
      const [{ count }] = await tx<{ count: number }[]>`select count(*)::int as count from runner_leases where worker_id=${workerId} and state not in ('completed','reaped','failed')`;
      if (!row.draining || Number(count) !== 0) throw new Error("worker guest platform configuration requires drained worker");
    }
    const telemetry = row.doctor && typeof row.doctor === "object" ? row.doctor as Record<string, unknown> : {};
    const capacity = telemetry.capacity && typeof telemetry.capacity === "object" ? telemetry.capacity as Record<string, number> : {};
    if (parsed.appliance.vcpu > (capacity.freeVcpu ?? 0) || parsed.appliance.memoryBytes > (capacity.freeMemoryBytes ?? 0) || parsed.appliance.storageBytes > (capacity.freeStorageBytes ?? 0)) throw new Error("worker configuration exceeds capacity");
    await tx`update workers set limits=${jsonParameter(tx, parsed.runtime)}::jsonb, guest_platforms=${jsonParameter(tx, parsed.guestPlatforms)}::jsonb, desired_configuration=${jsonParameter(tx, parsed)}::jsonb, admission_state='adopted', configuration_state='applying', configuration_revision=${revision}, configuration_command_id=${commandId} where id=${workerId}`;
    await tx`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${commandId},1,'worker.configure',${workerId},null,now(),${jsonParameter(tx, payload)}::jsonb)`;
    await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.configured',${jsonParameter(tx, { workerId, revision, fingerprint: fp, guestPlatforms: parsed.guestPlatforms })}::jsonb)`;
    const result = { revision, fingerprint: fp, commandId };
    if (idempotencyKey) await tx`insert into worker_mutations (worker_id,idempotency_key,response) values (${workerId},${idempotencyKey},${jsonParameter(tx, result)}::jsonb)`;
    return result;
  });
  if (response.commandId !== commandId) return response;
  await dispatcher?.replayConnected(workerId);
  return response;
}
export async function applyWorkerConfigurationAcknowledgement(db: Sql<{}>, event: { workerId: string; payload: unknown }): Promise<boolean> {
  const input = event.payload as Record<string, unknown>;
  const observed = WorkerConfiguration.safeParse(input?.observed);
  const commandId = typeof input?.commandId === "string" ? input.commandId : "";
  const revision = typeof input?.revision === "string" ? input.revision : "";
  const [worker] = await db<{ configurationRevision: string | null; configurationCommandId: string | null; desiredConfiguration: unknown }[]>`select configuration_revision as "configurationRevision", configuration_command_id as "configurationCommandId", desired_configuration as "desiredConfiguration" from workers where id=${event.workerId}`;
  let desiredInput = worker?.desiredConfiguration;
  if (typeof desiredInput === "string") {
    try { desiredInput = JSON.parse(desiredInput); } catch { desiredInput = null; }
  }
  const desired = WorkerConfiguration.safeParse(desiredInput);
  const exact = observed.success && desired.success && worker?.configurationCommandId === commandId && worker.configurationRevision === revision && canonical(observed.data) === canonical(desired.data);
  if (!exact) {
    if (worker?.configurationCommandId === commandId && worker.configurationRevision === revision) await db`update workers set configuration_state='error' where id=${event.workerId} and configuration_command_id=${commandId} and configuration_revision=${revision}`;
    return false;
  }
  return db.begin(async tx => {
    const updated = await tx`update workers set configuration_state='ready',applied_configuration_revision=configuration_revision,configuration_applied_at=now() where id=${event.workerId} and configuration_command_id=${commandId} and configuration_revision=${revision} returning id`;
    if (!updated[0]) return false;
    await tx`insert into audit_events (actor,type,payload) values ('worker','worker.configuration_applied',${jsonParameter(tx, { workerId: event.workerId, commandId, revision })}::jsonb)`;
    return true;
  });
}
export async function reconcileWorkerConfigurationOnConnect(db: Sql<{}>, workerId: string): Promise<{ state: "unconfigured" | "applying"; commandId: string | null }> {
  return db.begin(async tx => {
    const [worker] = await tx<{ desiredConfiguration: unknown; configurationRevision: string | null }[]>`select desired_configuration AS "desiredConfiguration", configuration_revision AS "configurationRevision" from workers where id=${workerId} for update`;
    if (!worker) throw new Error("worker configuration unavailable");
    let desiredInput = worker.desiredConfiguration;
    if (typeof desiredInput === "string") {
      try { desiredInput = JSON.parse(desiredInput); } catch { desiredInput = null; }
    }
    if (desiredInput === null || desiredInput === undefined) {
      await tx`update workers set configuration_state='unconfigured', configuration_command_id=null where id=${workerId}`;
      return { state: "unconfigured", commandId: null };
    }
    const desired = WorkerConfiguration.parse(desiredInput);
    const revision = worker.configurationRevision ?? createHash("sha256").update(canonical(desired)).digest("hex");
    const pending = await tx<{ id: string; payload: unknown }[]>`select id,payload from commands where worker_id=${workerId} and type='worker.configure' and state in ('pending','sent') order by occurred_at desc`;
    const reusable = pending.find(command => {
      let payload = command.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { return false; }
      }
      return Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>).revision === revision);
    });
    if (reusable) {
      await tx`update workers set configuration_state='applying', configuration_revision=${revision}, configuration_command_id=${reusable.id} where id=${workerId}`;
      return { state: "applying", commandId: reusable.id };
    }
    const commandId = randomUUID();
    const fingerprint = createHash("sha256").update(`${workerId}:${revision}`).digest("hex");
    const payload = { workerId, appliance: desired.appliance, runtime: desired.runtime, guestPlatforms: desired.guestPlatforms, revision, fingerprint };
    await tx`update commands set state='failed' where worker_id=${workerId} and type='worker.configure' and state in ('pending','sent')`;
    await tx`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${commandId},1,${"worker.configure"},${workerId},null,now(),${jsonParameter(tx, payload)}::jsonb)`;
    await tx`update workers set configuration_state='applying', configuration_revision=${revision}, configuration_command_id=${commandId} where id=${workerId}`;
    return { state: "applying", commandId };
  });
}
export async function rejectPendingWorker(db: Sql<{}>, workerId: string, adminId: string): Promise<void> { await db.begin(async tx => { const rows = await tx`update workers set admission_state='rejected', configuration_state='unconfigured' where id=${workerId} and admission_state in ('pending','adopted') returning id`; if (rows.length !== 1) throw new Error("worker rejection conflict"); await tx`update system_onboarding set worker_id=null where singleton=true and worker_id=${workerId}`; await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.rejected',${jsonParameter(tx, { workerId })}::jsonb)`; }); }
