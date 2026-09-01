import type { Sql } from "@mars/db";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WorkerBootstrapRequest, PendingWorkerRequest, ApproveWorkerRequest, WorkerConfiguration, WorkerConfigurePayload, WorkerObservedConfiguration, WorkerRunnerCachePurgePayload, validateWorkerGuestPlatforms, type GuestPlatform } from "@mars/contracts";
import { z } from "zod";
import { jsonParameter } from "@mars/db";
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

export async function requestPendingWorker(db: Sql<{}>, input: z.input<typeof WorkerBootstrapRequest>, source?: string, limiter?: RequestLimiter): Promise<WorkerRequestResult> {
  const parsed = WorkerBootstrapRequest.parse(input);
  if (source && limiter && !limiter.allow(source)) throw new WorkerRequestError("invalid_bootstrap");
  const fp = fingerprint(parsed.publicKey);
  const guestPlatforms: GuestPlatform[] = parsed.platform === "windows-x64" ? ["windows-x64"] : [parsed.platform];
  const lockKeys = [`machine:${parsed.machineUuid}`, `vm:${parsed.vmUuid}`, `fingerprint:${fp}`].sort();
  const outcome = await db.begin(async tx => {
    const telemetry = { doctor: parsed.doctor, capacity: parsed.capacity };
    for (const key of lockKeys) await tx`select pg_advisory_xact_lock(hashtext(${`mars:worker:${key}`}))`;
    const [activeCredential] = await tx<{ codeHash: Buffer; consumedAt: string | Date | null }[]>`select code_hash as "codeHash", consumed_at as "consumedAt" from worker_bootstrap_credentials where singleton=true and consumed_at is null for update`;
    const [credential] = activeCredential ? [activeCredential] : await tx<{ codeHash: Buffer; consumedAt: string | Date | null }[]>`select code_hash as "codeHash", consumed_at as "consumedAt" from worker_bootstrap_credentials where singleton=true and consumed_at is not null for update`;
    const candidate = createHash("sha256").update(Buffer.from(parsed.code, "base64url")).digest();
    const codeMatches = credential && credential.codeHash.length === candidate.length && timingSafeEqual(credential.codeHash, candidate);
    if (!codeMatches) return { conflict: false as const, invalid: true as const };
    const rows = await tx<{
      id: string;
      vmUuid: string | null;
      machineUuid: string | null;
      fingerprint: string | null;
      encryptionPublicKey: string | null;
      admissionState: string;
      enrollmentCodeHash: Buffer | null;
      enrollmentAuthenticatedAt: string | Date | null;
    }[]>`select id, vm_uuid as "vmUuid", machine_uuid as "machineUuid", fingerprint, encryption_public_key as "encryptionPublicKey", admission_state as "admissionState", enrollment_code_hash as "enrollmentCodeHash", enrollment_authenticated_at as "enrollmentAuthenticatedAt" from workers where admission_state in ('pending','adopted') and (vm_uuid=${parsed.vmUuid} or machine_uuid=${parsed.machineUuid} or fingerprint=${fp}) for update`;
    const exactIdentity = rows.find(row =>
      matchesWorkerIdentity(row, parsed, fp)
      && row.encryptionPublicKey === parsed.encryptionPublicKey,
    );
    if (credential!.consumedAt) {
      const replay = exactIdentity
        && exactIdentity.admissionState === "pending"
        && !exactIdentity.enrollmentAuthenticatedAt
        && exactIdentity.enrollmentCodeHash
        && exactIdentity.enrollmentCodeHash.length === candidate.length
        && timingSafeEqual(exactIdentity.enrollmentCodeHash, candidate);
      if (!exactIdentity || !replay) return { conflict: true as const, invalid: false as const };
      await tx`update workers set last_requested_at=now(), doctor=${jsonParameter(tx, telemetry)}::jsonb, doctor_observed_at=now() where id=${exactIdentity.id} and admission_state='pending' and enrollment_authenticated_at is null`;
      return { status: "existing" as const, workerId: exactIdentity.id };
    }
    if (exactIdentity && exactIdentity.admissionState === "pending" && !exactIdentity.enrollmentAuthenticatedAt) {
      await tx`update worker_bootstrap_credentials set consumed_at=now() where singleton=true and consumed_at is null`;
      await tx`update workers set last_requested_at=now(), machine_uuid=${parsed.machineUuid}, encryption_public_key=${parsed.encryptionPublicKey}, enrollment_code_hash=${candidate}, doctor=${jsonParameter(tx, telemetry)}::jsonb, doctor_observed_at=now() where id=${exactIdentity.id} and admission_state='pending' and enrollment_authenticated_at is null`;
      return { status: "existing" as const, workerId: exactIdentity.id };
    }
    if (rows.length) return { conflict: true as const, invalid: false as const };
    await tx`update worker_bootstrap_credentials set consumed_at=now() where singleton=true and consumed_at is null`;
    const [created] = await tx<{ id: string }[]>`insert into workers (name,platform,guest_platforms,admission_state,public_key,encryption_public_key,fingerprint,vm_uuid,machine_uuid,enrollment_code_hash,limits,doctor,last_requested_at,doctor_observed_at) values (${parsed.vmUuid},${parsed.platform},${jsonParameter(tx, guestPlatforms)}::jsonb,'pending',${parsed.publicKey},${parsed.encryptionPublicKey},${fp},${parsed.vmUuid},${parsed.machineUuid},${candidate},null,${jsonParameter(tx, telemetry)}::jsonb,now(),now()) returning id`;
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
export type WorkerConfigurationInput = { appliance: { vcpu: number; memoryBytes: number; storageBytes: number }; runtime: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number }; guestPlatforms?: GuestPlatform[]; cache?: { ttlSeconds: number } };
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
export async function configurePendingWorker(db: Sql<{}>, workerId: string, configuration: WorkerConfigurationInput, adminId: string, dispatcher?: WorkerCommandDispatcher, idempotencyKey?: string): Promise<{ revision: string; fingerprint: string; commandId?: string }> {
  const parsed = WorkerConfiguration.parse({ ...configuration, guestPlatforms: configuration.guestPlatforms ?? ["macos-arm64"] });
  const revision = createHash("sha256").update(canonical(parsed)).digest("hex");
  const fp = createHash("sha256").update(`${workerId}:${revision}`).digest("hex");
  const commandId = randomUUID();
  const payload: WorkerConfigurePayload = { workerId, appliance: parsed.appliance, runtime: parsed.runtime, guestPlatforms: parsed.guestPlatforms, cache: parsed.cache, revision, fingerprint: fp };
  const response = await db.begin(async tx => {
    if (idempotencyKey) {
      await tx`select pg_advisory_xact_lock(hashtext(${`mars:configure:${workerId}:${idempotencyKey}`}))`;
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
export type WorkerRunnerCachePurgeResult = { workerId: string; commandId: string };
export async function purgeWorkerRunnerCache(
  db: Sql<{}>,
  workerId: string,
  adminId: string,
  dispatcher?: Pick<WorkerCommandDispatcher, "replayConnected">,
  idempotencyKey?: string,
): Promise<WorkerRunnerCachePurgeResult> {
  const commandId = randomUUID();
  const response = await db.begin(async tx => {
    if (idempotencyKey) {
      await tx`select pg_advisory_xact_lock(hashtext(${`mars:runner-cache-purge:${workerId}:${idempotencyKey}`}))`;
      const prior = await tx<{ response: WorkerRunnerCachePurgeResult | null }[]>`select response from worker_mutations where worker_id=${workerId} and idempotency_key=${idempotencyKey}`;
      if (prior[0]?.response) return { result: prior[0].response, created: false };
    }
    const [worker] = await tx<{ id: string; admissionState: string }[]>`select id,admission_state as "admissionState" from workers where id=${workerId} for update`;
    if (!worker || !["pending", "adopted"].includes(worker.admissionState)) throw new Error("worker purge conflict");
    const payload = WorkerRunnerCachePurgePayload.parse({ workerId });
    await tx`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${commandId},1,'worker.runner_cache_purge',${workerId},null,now(),${jsonParameter(tx, payload)}::jsonb)`;
    await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.runner_cache_purge_requested',${jsonParameter(tx, { workerId, commandId })}::jsonb)`;
    const result = { workerId, commandId };
    if (idempotencyKey) await tx`insert into worker_mutations (worker_id,idempotency_key,response) values (${workerId},${idempotencyKey},${jsonParameter(tx, result)}::jsonb)`;
    return { result, created: true };
  });
  if (response.created) await dispatcher?.replayConnected(workerId);
  return response.result;
}

export async function applyWorkerConfigurationAcknowledgement(db: Sql<{}>, event: { workerId: string; payload: unknown }): Promise<boolean> {
  const input = event.payload as Record<string, unknown>;
  const observed = WorkerObservedConfiguration.safeParse(input?.observed);
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
export async function reconcileWorkerConfigurationOnConnect(db: Sql<{}>, workerId: string): Promise<{ state: "unconfigured" | "applying" | "ready"; commandId: string | null }> {
  return db.begin(async tx => {
    const [worker] = await tx<{ desiredConfiguration: unknown; configurationRevision: string | null; appliedConfigurationRevision: string | null; configurationCommandId: string | null }[]>`select desired_configuration AS "desiredConfiguration", configuration_revision AS "configurationRevision", applied_configuration_revision AS "appliedConfigurationRevision", configuration_command_id AS "configurationCommandId" from workers where id=${workerId} for update`;
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
    if (worker.appliedConfigurationRevision === revision) {
      await tx`update workers set configuration_state='applying', configuration_revision=${revision} where id=${workerId}`;
    }
    const pending = await tx<{ id: string; payload: unknown }[]>`select id,payload from commands where worker_id=${workerId} and type='worker.configure' and state in ('pending','sent') order by occurred_at desc`;
    const reusable = pending.find(command => {
      let payload = command.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { return false; }
      }
      const parsed = WorkerConfigurePayload.safeParse(payload);
      return parsed.success && parsed.data.revision === revision;
    });
    if (reusable) {
      await tx`update workers set configuration_state='applying', configuration_revision=${revision}, configuration_command_id=${reusable.id} where id=${workerId}`;
      return { state: "applying", commandId: reusable.id };
    }
    const commandId = randomUUID();
    const fingerprint = createHash("sha256").update(`${workerId}:${revision}`).digest("hex");
    const payload: WorkerConfigurePayload = { workerId, appliance: desired.appliance, runtime: desired.runtime, guestPlatforms: desired.guestPlatforms, cache: desired.cache, revision, fingerprint };
    await tx`update commands set state='failed' where worker_id=${workerId} and type='worker.configure' and state in ('pending','sent')`;
    await tx`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${commandId},1,${"worker.configure"},${workerId},null,now(),${jsonParameter(tx, payload)}::jsonb)`;
    await tx`update workers set configuration_state='applying', configuration_revision=${revision}, configuration_command_id=${commandId} where id=${workerId}`;
    return { state: "applying", commandId };
  });
}
export async function rejectPendingWorker(db: Sql<{}>, workerId: string, adminId: string): Promise<void> { await db.begin(async tx => { const rows = await tx`update workers set admission_state='rejected', configuration_state='unconfigured' where id=${workerId} and admission_state in ('pending','adopted') returning id`; if (rows.length !== 1) throw new Error("worker rejection conflict"); await tx`update system_onboarding set worker_id=null where singleton=true and worker_id=${workerId}`; await tx`insert into audit_events (actor,type,payload) values (${adminId},'worker.rejected',${jsonParameter(tx, { workerId })}::jsonb)`; }); }
