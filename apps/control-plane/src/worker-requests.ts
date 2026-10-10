import type { DatabaseClient } from "@mars/db";
import { defineQueries, schema } from "@mars/db";
import { and, eq, inArray, or, isNull, count, sql } from "drizzle-orm";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WorkerBootstrapRequest, PendingWorkerRequest, ApproveWorkerRequest, WorkerConfiguration, WorkerConfigurePayload, WorkerObservedConfiguration, WorkerDoctorData, WorkerRunnerCachePurgePayload, validateWorkerGuestPlatforms, selectedRuntimeDriver, CURRENT_WORKER_CONTRACT_VERSION, parseWorkerContractVersion, type GuestPlatform, type RuntimeDriverName, type WorkerDoctorReport } from "@mars/contracts";
import { z } from "zod";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";
import { fingerprint } from "./workers.ts";

const queries = defineQueries(db => ({
  advisoryLock: db.select({ locked: sql`pg_advisory_xact_lock(hashtext(${sql.placeholder("key")}))` }).from(sql`(SELECT 1) AS singleton`).prepare("worker_request_advisory_lock"),
  bootstrapActive: db.select({ codeHash: schema.workerBootstrapCredentials.codeHash, consumedAt: schema.workerBootstrapCredentials.consumedAt }).from(schema.workerBootstrapCredentials).where(and(eq(schema.workerBootstrapCredentials.singleton, true), isNull(schema.workerBootstrapCredentials.consumedAt))).for("update").prepare("worker_request_bootstrap_active"),
  bootstrapConsumed: db.select({ codeHash: schema.workerBootstrapCredentials.codeHash, consumedAt: schema.workerBootstrapCredentials.consumedAt }).from(schema.workerBootstrapCredentials).where(and(eq(schema.workerBootstrapCredentials.singleton, true), sql`${schema.workerBootstrapCredentials.consumedAt} is not null`)).for("update").prepare("worker_request_bootstrap_consumed"),
  identityRows: db.select({ id: schema.workers.id, vmUuid: schema.workers.vmUuid, machineUuid: schema.workers.machineUuid, fingerprint: schema.workers.fingerprint, encryptionPublicKey: schema.workers.encryptionPublicKey, admissionState: schema.workers.admissionState, enrollmentCodeHash: schema.workers.enrollmentCodeHash, enrollmentAuthenticatedAt: schema.workers.enrollmentAuthenticatedAt }).from(schema.workers).where(and(inArray(schema.workers.admissionState, ["pending", "adopted"]), or(eq(schema.workers.vmUuid, sql.placeholder("vmUuid")), eq(schema.workers.machineUuid, sql.placeholder("machineUuid")), eq(schema.workers.fingerprint, sql.placeholder("fingerprint"))))).for("update").prepare("worker_request_identity_rows"),
  consumeBootstrap: db.update(schema.workerBootstrapCredentials).set({ consumedAt: sql`now()` }).where(and(eq(schema.workerBootstrapCredentials.singleton, true), isNull(schema.workerBootstrapCredentials.consumedAt))).prepare("worker_request_consume"),
  touchReplay: db.update(schema.workers).set({ name: sql`${sql.placeholder("name")}`, lastRequestedAt: sql`now()`, releaseVersion: sql`${sql.placeholder("releaseVersion")}`, contractVersion: sql`${sql.placeholder("contractVersion")}`, doctor: sql`${sql.placeholder("telemetry")}::jsonb`, doctorObservedAt: sql`now()` }).where(and(eq(schema.workers.id, sql.placeholder("id")), eq(schema.workers.admissionState, "pending"), isNull(schema.workers.enrollmentAuthenticatedAt))).prepare("worker_request_touch_replay"),
  updateIdentity: db.update(schema.workers).set({ name: sql`${sql.placeholder("name")}`, lastRequestedAt: sql`now()`, machineUuid: sql`${sql.placeholder("machineUuid")}`, encryptionPublicKey: sql`${sql.placeholder("encryptionPublicKey")}`, enrollmentCodeHash: sql`${sql.placeholder("candidate")}`, releaseVersion: sql`${sql.placeholder("releaseVersion")}`, contractVersion: sql`${sql.placeholder("contractVersion")}`, doctor: sql`${sql.placeholder("telemetry")}::jsonb`, doctorObservedAt: sql`now()` }).where(and(eq(schema.workers.id, sql.placeholder("id")), eq(schema.workers.admissionState, "pending"), isNull(schema.workers.enrollmentAuthenticatedAt))).prepare("worker_request_update_identity"),
  createWorker: db.insert(schema.workers).values({ name: sql.placeholder("name"), platform: sql.placeholder("platform"), releaseVersion: sql.placeholder("releaseVersion"), contractVersion: sql.placeholder("contractVersion"), guestPlatforms: sql`${sql.placeholder("guestPlatforms")}::jsonb`, admissionState: "pending", publicKey: sql.placeholder("publicKey"), encryptionPublicKey: sql.placeholder("encryptionPublicKey"), fingerprint: sql.placeholder("fingerprint"), vmUuid: sql.placeholder("vmUuid"), machineUuid: sql.placeholder("machineUuid"), enrollmentCodeHash: sql.placeholder("candidate"), limits: null, doctor: sql`${sql.placeholder("telemetry")}::jsonb`, lastRequestedAt: sql`now()`, doctorObservedAt: sql`now()` }).returning({ id: schema.workers.id }).prepare("worker_request_create"),
  audit: db.insert(schema.auditEvents).values({ actor: sql.placeholder("actor"), type: sql.placeholder("type"), payload: sql`${sql.placeholder("payload")}::jsonb` }).prepare("worker_request_audit"),
  approve: db.update(schema.workers).set({ limits: sql`${sql.placeholder("limits")}::jsonb`, admissionState: "adopted", configurationState: "unconfigured" }).where(and(eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.admissionState, "pending"))).returning({ id: schema.workers.id }).prepare("worker_request_approve"),
  workerForConfigure: db.select({ id: schema.workers.id, doctor: schema.workers.doctor, doctorObservedAt: schema.workers.doctorObservedAt, admissionState: schema.workers.admissionState, platform: schema.workers.platform, guestPlatforms: schema.workers.guestPlatforms, draining: schema.workers.draining, contractVersion: schema.workers.contractVersion, desiredConfiguration: schema.workers.desiredConfiguration }).from(schema.workers).where(eq(schema.workers.id, sql.placeholder("workerId"))).for("update").prepare("worker_request_configure_lock"),
  activeLeaseCount: db.select({ count: sql<number>`count(*)::int` }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), sql`${schema.runnerLeases.state} not in ('completed','reaped','failed')`)).prepare("worker_request_active_lease_count"),
  setWorkerConfiguration: db.update(schema.workers).set({ limits: sql`${sql.placeholder("runtime")}::jsonb`, guestPlatforms: sql`${sql.placeholder("guestPlatforms")}::jsonb`, desiredConfiguration: sql`${sql.placeholder("desired")}::jsonb`, admissionState: "adopted", configurationState: "applying", configurationRevision: sql`${sql.placeholder("revision")}`, configurationCommandId: sql`${sql.placeholder("commandId")}` }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_request_set_configuration"),
  insertCommand: db.insert(schema.commands).values({ id: sql.placeholder("commandId"), version: 1, type: sql.placeholder("type"), workerId: sql.placeholder("workerId"), leaseId: null, occurredAt: sql`now()`, payload: sql`${sql.placeholder("payload")}::jsonb` }).prepare("worker_request_insert_command"),
  mutationPrior: db.select({ response: schema.workerMutations.response }).from(schema.workerMutations).where(and(eq(schema.workerMutations.workerId, sql.placeholder("workerId")), eq(schema.workerMutations.idempotencyKey, sql.placeholder("idempotencyKey")))).prepare("worker_request_mutation_prior"),
  mutationInsert: db.insert(schema.workerMutations).values({ workerId: sql.placeholder("workerId"), idempotencyKey: sql.placeholder("idempotencyKey"), response: sql`${sql.placeholder("response")}::jsonb` }).prepare("worker_request_mutation_insert"),
  cacheWorkerLock: db.select({ id: schema.workers.id, admissionState: schema.workers.admissionState }).from(schema.workers).where(eq(schema.workers.id, sql.placeholder("workerId"))).for("update").prepare("worker_request_cache_worker_lock"),
  auditGeneric: db.insert(schema.auditEvents).values({ actor: sql.placeholder("actor"), type: sql.placeholder("type"), payload: sql`${sql.placeholder("payload")}::jsonb` }).prepare("worker_request_generic_audit"),
  appliedConfig: db.select({ configurationRevision: schema.workers.configurationRevision, configurationCommandId: schema.workers.configurationCommandId, desiredConfiguration: schema.workers.desiredConfiguration }).from(schema.workers).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_request_applied_config"),
  priorConfigureCommand: db.select({ id: schema.commands.id }).from(schema.commands).where(and(eq(schema.commands.id, sql.placeholder("commandId")), eq(schema.commands.workerId, sql.placeholder("workerId")), eq(schema.commands.type, "worker.configure"))).prepare("worker_request_prior_config_command"),
  setConfigurationError: db.update(schema.workers).set({ configurationState: "error" }).where(and(eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.configurationCommandId, sql.placeholder("commandId")), eq(schema.workers.configurationRevision, sql.placeholder("revision")))).returning({ id: schema.workers.id }).prepare("worker_request_config_error"),
  configurationReady: db.update(schema.workers).set({ configurationState: "ready", appliedConfigurationRevision: schema.workers.configurationRevision, configurationAppliedAt: sql`now()` }).where(and(eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.configurationCommandId, sql.placeholder("commandId")), eq(schema.workers.configurationRevision, sql.placeholder("revision")))).returning({ id: schema.workers.id }).prepare("worker_request_config_ready"),
  cacheStatusDisable: db.update(schema.workerCacheStatus).set({ ready: false, runnerCacheEnabled: false, runnerCacheObservedAt: sql`now()` }).where(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId"))).prepare("worker_request_disable_cache"),
  workerConnectLock: db.select({ desiredConfiguration: schema.workers.desiredConfiguration, configurationRevision: schema.workers.configurationRevision, appliedConfigurationRevision: schema.workers.appliedConfigurationRevision, configurationCommandId: schema.workers.configurationCommandId, configurationState: schema.workers.configurationState }).from(schema.workers).where(eq(schema.workers.id, sql.placeholder("workerId"))).for("update").prepare("worker_request_connect_lock"),
  commandsPendingConfig: db.select({ id: schema.commands.id, payload: schema.commands.payload }).from(schema.commands).where(and(eq(schema.commands.workerId, sql.placeholder("workerId")), eq(schema.commands.type, "worker.configure"), inArray(schema.commands.state, ["pending", "sent"]))).orderBy(sql`${schema.commands.occurredAt} desc`).prepare("worker_request_pending_config"),
  retryConfigurationEligible: db.select({ id: schema.workers.id }).from(schema.workers).where(and(eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.admissionState, "adopted"), eq(schema.workers.configurationState, "error"), sql`exists(select 1 from commands c where c.id=${schema.workers.configurationCommandId} and c.occurred_at < now()-interval '30 seconds')`)).prepare("worker_request_retry_configuration_eligible"),
  updateConfigurationCommandState: db.update(schema.commands).set({ state: sql`${sql.placeholder("state")}` }).where(and(eq(schema.commands.workerId, sql.placeholder("workerId")), eq(schema.commands.type, "worker.configure"), inArray(schema.commands.state, ["pending", "sent"]))).prepare("worker_request_configuration_command_state"),
  auditConfigure: db.insert(schema.auditEvents).values({ actor: sql.placeholder("actor"), type: sql.placeholder("type"), payload: sql`${sql.placeholder("payload")}::jsonb` }).prepare("worker_request_audit_configure"),
  reject: db.update(schema.workers).set({ admissionState: "rejected", configurationState: "unconfigured" }).where(and(eq(schema.workers.id, sql.placeholder("workerId")), inArray(schema.workers.admissionState, ["pending", "adopted"]))).returning({ id: schema.workers.id }).prepare("worker_request_reject"),
  rejectOnboarding: db.update(schema.systemOnboarding).set({ workerId: null }).where(and(eq(schema.systemOnboarding.singleton, true), eq(schema.systemOnboarding.workerId, sql.placeholder("workerId")))).prepare("worker_request_reject_onboarding"),
  connectUnconfigured: db.update(schema.workers).set({ configurationState: "unconfigured", configurationCommandId: null }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_request_connect_unconfigured"),
  connectError: db.update(schema.workers).set({ configurationState: "error" }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_request_connect_error"),
  connectApplying: db.update(schema.workers).set({ configurationState: "applying", configurationRevision: sql`${sql.placeholder("revision")}` }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_request_connect_applying"),
  connectReuseCommand: db.update(schema.workers).set({ configurationState: "applying", configurationRevision: sql`${sql.placeholder("revision")}`, configurationCommandId: sql`${sql.placeholder("commandId")}` }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_request_connect_reuse"),
  connectNewCommand: db.update(schema.workers).set({ configurationState: "applying", configurationRevision: sql`${sql.placeholder("revision")}`, configurationCommandId: sql`${sql.placeholder("commandId")}` }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_request_connect_new"),
}));

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

export async function requestPendingWorker(db: DatabaseClient, input: z.input<typeof WorkerBootstrapRequest>, source?: string, limiter?: RequestLimiter, credentialOverride?: { codeHash: Buffer; reusable: true }): Promise<WorkerRequestResult> {
  const parsed = WorkerBootstrapRequest.parse(input);
  if (source && limiter && !limiter.allow(source)) throw new WorkerRequestError("invalid_bootstrap");
  const fp = fingerprint(parsed.publicKey);
  const guestPlatforms: GuestPlatform[] = parsed.platform === "windows-arm64" ? ["linux-arm64"] : parsed.platform === "windows-x64" ? ["windows-x64"] : [parsed.platform];
  const lockKeys = [`machine:${parsed.machineUuid}`, `vm:${parsed.vmUuid}`, `fingerprint:${fp}`].sort();
  const outcome = await db.transaction(async tx => {
    const q = queries(tx);
    const telemetry = { doctor: parsed.doctor, capacity: parsed.capacity };
    for (const key of lockKeys) await q.advisoryLock.execute({ key: `mars:worker:${key}` });
    const candidate = createHash("sha256").update(Buffer.from(parsed.code, "base64url")).digest();
    const [activeCredential] = credentialOverride ? [credentialOverride] : await q.bootstrapActive.execute();
    const [credential] = activeCredential ? [activeCredential] : await q.bootstrapConsumed.execute();
    const codeMatches = credential && credential.codeHash.length === candidate.length && timingSafeEqual(credential.codeHash, candidate);
    if (!codeMatches) return { conflict: false as const, invalid: true as const };
    const rows = await q.identityRows.execute({ vmUuid: parsed.vmUuid, machineUuid: parsed.machineUuid, fingerprint: fp });
    const exactIdentity = rows.find(row => matchesWorkerIdentity(row, parsed, fp) && row.encryptionPublicKey === parsed.encryptionPublicKey);
    if (!credentialOverride && credential && "consumedAt" in credential && credential.consumedAt) {
      const replay = exactIdentity && exactIdentity.admissionState === "pending" && !exactIdentity.enrollmentAuthenticatedAt && exactIdentity.enrollmentCodeHash && exactIdentity.enrollmentCodeHash.length === candidate.length && timingSafeEqual(exactIdentity.enrollmentCodeHash, candidate);
      if (!exactIdentity || !replay) return { conflict: true as const, invalid: false as const };
      await q.touchReplay.execute({ id: exactIdentity.id, name: parsed.computerName, releaseVersion: parsed.releaseVersion, contractVersion: parsed.contractVersion, telemetry: JSON.stringify(telemetry) });
      return { status: "existing" as const, workerId: exactIdentity.id };
    }
    if (exactIdentity && exactIdentity.admissionState === "pending" && !exactIdentity.enrollmentAuthenticatedAt) {
      if (!credentialOverride) await q.consumeBootstrap.execute();
      await q.updateIdentity.execute({ id: exactIdentity.id, name: parsed.computerName, machineUuid: parsed.machineUuid, encryptionPublicKey: parsed.encryptionPublicKey, candidate, releaseVersion: parsed.releaseVersion, contractVersion: parsed.contractVersion, telemetry: JSON.stringify(telemetry) });
      return { status: "existing" as const, workerId: exactIdentity.id };
    }
    if (rows.length) return { conflict: true as const, invalid: false as const };
    if (!credentialOverride) await q.consumeBootstrap.execute();
    const [created] = await q.createWorker.execute({ name: parsed.computerName, platform: parsed.platform, releaseVersion: parsed.releaseVersion, contractVersion: parsed.contractVersion, guestPlatforms: JSON.stringify(guestPlatforms), publicKey: parsed.publicKey, encryptionPublicKey: parsed.encryptionPublicKey, fingerprint: fp, vmUuid: parsed.vmUuid, machineUuid: parsed.machineUuid, candidate, telemetry: JSON.stringify(telemetry) });
    await q.audit.execute({ actor: "worker", type: "worker.requested", payload: JSON.stringify({ workerId: created!.id, vmUuid: parsed.vmUuid, fingerprint: fp, guestPlatforms }) });
    return { status: "created" as const, workerId: created!.id };
  });
  if ("invalid" in outcome && outcome.invalid) throw new WorkerRequestError("invalid_bootstrap");
  if ("conflict" in outcome && outcome.conflict) {
    await queries(db).audit.execute({ actor: "worker", type: "worker.request.identity_conflict", payload: JSON.stringify({ vmUuid: parsed.vmUuid, fingerprint: fp }) });
    throw new WorkerRequestError("identity_conflict");
  }
  if (source && limiter) limiter.clear(source);
  return outcome;
}

export async function approvePendingWorker(db: DatabaseClient, workerId: string, input: ApproveWorkerRequest, adminId: string): Promise<void> {
  const parsed = ApproveWorkerRequest.parse(input);
  await db.transaction(async tx => {
    const rows = await queries(tx).approve.execute({ workerId, limits: JSON.stringify(parsed.limits) });
    if (rows.length !== 1) throw new Error("worker approval conflict");
    await queries(tx).audit.execute({ actor: adminId, type: "worker.approved", payload: JSON.stringify({ workerId, limits: parsed.limits }) });
  });
}
export type WorkerConfigurationInput = {
  appliance: { vcpu: number; memoryBytes: number; storageBytes: number };
  runtime: { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
  selectedDriver: RuntimeDriverName;
  guestPlatforms?: GuestPlatform[];
  cache?: { ttlSeconds?: number; runnerCacheEnabled?: boolean; runnerCacheMaxGiB?: number };
};
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
function compareContractVersions(left: string, right: string): number {
  try {
    const a = parseWorkerContractVersion(left);
    const b = parseWorkerContractVersion(right);
    return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  } catch {
    return -1;
  }
}
export async function configurePendingWorker(db: DatabaseClient, workerId: string, configuration: WorkerConfigurationInput, adminId: string, dispatcher?: WorkerCommandDispatcher, idempotencyKey?: string): Promise<{ revision: string; fingerprint: string; commandId?: string }> {
  const parsed = WorkerConfiguration.parse({ ...configuration, guestPlatforms: configuration.guestPlatforms ?? ["macos-arm64"] });
  const revision = createHash("sha256").update(canonical(parsed)).digest("hex");
  const fp = createHash("sha256").update(`${workerId}:${revision}`).digest("hex");
  const commandId = randomUUID();
  const payload: WorkerConfigurePayload = { workerId, appliance: parsed.appliance, runtime: parsed.runtime, guestPlatforms: parsed.guestPlatforms, selectedDriver: parsed.selectedDriver, cache: parsed.cache, revision, fingerprint: fp };
  const response = await db.transaction(async tx => {
    const q = queries(tx);
    if (idempotencyKey) {
      await q.advisoryLock.execute({ key: `mars:configure:${workerId}:${idempotencyKey}` });
      const prior = await q.mutationPrior.execute({ workerId, idempotencyKey });
      if (prior[0]?.response) return prior[0].response as { revision: string; fingerprint: string; commandId?: string };
    }
    const [row] = await q.workerForConfigure.execute({ workerId });
    if (!row || !["pending", "adopted"].includes(row.admissionState)) throw new Error("worker configuration conflict");
    const platform = row.platform as GuestPlatform;
    if (!validateWorkerGuestPlatforms(platform, parsed.guestPlatforms) || parsed.guestPlatforms.some(guest => selectedRuntimeDriver(platform, guest, parsed.selectedDriver) !== parsed.selectedDriver)) throw new Error("worker driver is incompatible with host or guest platform");
    const doctorInput = typeof row.doctor === "string" ? (() => { try { return JSON.parse(row.doctor); } catch { return null; } })() : row.doctor;
    const doctorReport = doctorInput && typeof doctorInput === "object" && "doctor" in doctorInput ? doctorInput.doctor : null;
    const doctor = WorkerDoctorData.safeParse(doctorReport);
    const ageMs = row.doctorObservedAt ? Date.now() - new Date(row.doctorObservedAt).getTime() : Number.POSITIVE_INFINITY;
    const fresh = ageMs >= 0 && ageMs <= 5 * 60_000;
    const capabilities = doctor.success ? doctor.data.capabilities : undefined;
    if (!fresh || !capabilities || parsed.guestPlatforms.some(guest => !capabilities.some(item => item.driver === parsed.selectedDriver && item.guestPlatform === guest && item.ready && typeof item.imageDigest === "string" && /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/.test(item.imageDigest)))) throw new Error("selected worker capability is not currently advertised and ready");
    if (parsed.guestPlatforms.length > 1 && (!row.contractVersion || compareContractVersions(row.contractVersion, CURRENT_WORKER_CONTRACT_VERSION) < 0)) throw new Error("worker contract does not support dual-platform configuration");
    const priorPlatforms = Array.isArray(row.guestPlatforms) ? row.guestPlatforms : [row.platform];
    let priorInput = row.desiredConfiguration;
    if (typeof priorInput === "string") { try { priorInput = JSON.parse(priorInput); } catch { priorInput = null; } }
    const prior = WorkerConfiguration.safeParse(priorInput);
    const priorDriver = prior.success ? prior.data.selectedDriver : null;
    if (row.admissionState === "adopted" && prior.success && (canonical(priorPlatforms) !== canonical(parsed.guestPlatforms) || priorDriver !== parsed.selectedDriver)) {
      const [{ count: activeCount }] = await q.activeLeaseCount.execute({ workerId });
      if (!row.draining || Number(activeCount) !== 0) throw new Error("worker driver or guest platform configuration requires drained worker");
    }
    await q.setWorkerConfiguration.execute({ workerId, runtime: JSON.stringify(parsed.runtime), guestPlatforms: JSON.stringify(parsed.guestPlatforms), desired: JSON.stringify(parsed), revision, commandId });
    await q.insertCommand.execute({ commandId, type: "worker.configure", workerId, payload: JSON.stringify(payload) });
    await q.audit.execute({ actor: adminId, type: "worker.configured", payload: JSON.stringify({ workerId, revision, fingerprint: fp, guestPlatforms: parsed.guestPlatforms }) });
    const result = { revision, fingerprint: fp, commandId };
    if (idempotencyKey) await q.mutationInsert.execute({ workerId, idempotencyKey, response: JSON.stringify(result) });
    return result;
  });
  if (response.commandId !== commandId) return response;
  await dispatcher?.replayConnected(workerId);
  return response;
}
export type WorkerRunnerCachePurgeResult = { workerId: string; commandId: string };
export async function purgeWorkerRunnerCache(
  db: DatabaseClient,
  workerId: string,
  adminId: string,
  dispatcher?: Pick<WorkerCommandDispatcher, "replayConnected">,
  idempotencyKey?: string,
): Promise<WorkerRunnerCachePurgeResult> {
  const commandId = randomUUID();
  const response = await db.transaction(async tx => {
    const q = queries(tx);
    if (idempotencyKey) {
      await q.advisoryLock.execute({ key: `mars:runner-cache-purge:${workerId}:${idempotencyKey}` });
      const prior = await q.mutationPrior.execute({ workerId, idempotencyKey });
      if (prior[0]?.response) return { result: prior[0].response as WorkerRunnerCachePurgeResult, created: false };
    }
    const [worker] = await q.cacheWorkerLock.execute({ workerId });
    if (!worker || !["pending", "adopted"].includes(worker.admissionState)) throw new Error("worker purge conflict");
    const payload = WorkerRunnerCachePurgePayload.parse({ workerId });
    await q.insertCommand.execute({ commandId, type: "worker.runner_cache_purge", workerId, payload: JSON.stringify(payload) });
    await q.audit.execute({ actor: adminId, type: "worker.runner_cache_purge_requested", payload: JSON.stringify({ workerId, commandId }) });
    const result = { workerId, commandId };
    if (idempotencyKey) await q.mutationInsert.execute({ workerId, idempotencyKey, response: JSON.stringify(result) });
    return { result, created: true };
  });
  if (response.created) await dispatcher?.replayConnected(workerId);
  return response.result;
}

export async function applyWorkerConfigurationAcknowledgement(db: DatabaseClient, event: { workerId: string; payload: unknown }): Promise<boolean | "stale"> {
  const input = event.payload as Record<string, unknown>;
  const observed = WorkerObservedConfiguration.safeParse(input?.observed);
  const commandId = typeof input?.commandId === "string" ? input.commandId : "";
  const revision = typeof input?.revision === "string" ? input.revision : "";
  const q = queries(db);
  const [worker] = await q.appliedConfig.execute({ workerId: event.workerId });
  let desiredInput = worker?.desiredConfiguration;
  if (typeof desiredInput === "string") {
    try { desiredInput = JSON.parse(desiredInput); } catch { desiredInput = null; }
  }
  const desired = WorkerConfiguration.safeParse(desiredInput);
  if (worker && (worker.configurationCommandId !== commandId || worker.configurationRevision !== revision)) {
    const [previous] = await q.priorConfigureCommand.execute({ commandId, workerId: event.workerId });
    return previous ? "stale" : false;
  }
  const exact = observed.success && desired.success && worker?.configurationCommandId === commandId && worker.configurationRevision === revision && canonical(observed.data) === canonical(desired.data);
  if (!exact) {
    if (worker?.configurationCommandId === commandId && worker.configurationRevision === revision) await q.setConfigurationError.execute({ workerId: event.workerId, commandId, revision });
    return false;
  }
  return db.transaction(async tx => {
    const q = queries(tx);
    const updated = await q.configurationReady.execute({ workerId: event.workerId, commandId, revision });
    if (!updated[0]) return false;
    if (!observed.data.cache.runnerCacheEnabled) await q.cacheStatusDisable.execute({ workerId: event.workerId });
    await q.audit.execute({ actor: "worker", type: "worker.configuration_applied", payload: JSON.stringify({ workerId: event.workerId, commandId, revision }) });
    return true;
  });
}

const WorkerConfigureFailure = z.object({ commandId: z.string().uuid(), workerId: z.string().uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(1).max(1000) }).strict();
export async function applyWorkerConfigurationFailure(db: DatabaseClient, event: { workerId: string; payload: unknown }): Promise<boolean | "stale"> {
  const payload = WorkerConfigureFailure.safeParse(event.payload);
  if (!payload.success || payload.data.workerId !== event.workerId) return false;
  return db.transaction(async tx => {
    const q = queries(tx);
    const rows = await q.setConfigurationError.execute({ workerId: event.workerId, commandId: payload.data.commandId, revision: payload.data.revision });
    if (!rows[0]) {
      const [previous] = await q.priorConfigureCommand.execute({ commandId: payload.data.commandId, workerId: event.workerId });
      return previous ? "stale" : false;
    }
    await q.audit.execute({ actor: "worker", type: "worker.configuration_failed", payload: JSON.stringify({ workerId: event.workerId, commandId: payload.data.commandId, revision: payload.data.revision, reason: payload.data.reason }) });
    return true;
  });
}
export async function reconcileWorkerConfigurationOnConnect(db: DatabaseClient, workerId: string, sameProcess = false): Promise<{ state: "unconfigured" | "applying" | "ready" | "error"; commandId: string | null }> {
  return db.transaction(async tx => {
    const q = queries(tx);
    const [worker] = await q.workerConnectLock.execute({ workerId });
    if (!worker) throw new Error("worker configuration unavailable");
    let desiredInput = worker.desiredConfiguration;
    if (typeof desiredInput === "string") {
      try { desiredInput = JSON.parse(desiredInput); } catch { desiredInput = null; }
    }
    if (desiredInput == null) {
      await q.connectUnconfigured.execute({ workerId });
      return { state: "unconfigured", commandId: null };
    }
    const parsedDesired = WorkerConfiguration.safeParse(desiredInput);
    if (!parsedDesired.success) {
      await q.connectError.execute({ workerId });
      return { state: "error", commandId: null };
    }
    const desired = parsedDesired.data;
    const revision = worker.configurationRevision ?? createHash("sha256").update(canonical(desired)).digest("hex");
    if (sameProcess && worker.configurationState === "ready" && worker.configurationRevision && worker.configurationRevision === worker.appliedConfigurationRevision) return { state: "ready", commandId: worker.configurationCommandId };
    if (worker.appliedConfigurationRevision === revision) await q.connectApplying.execute({ workerId, revision });
    const pending = await q.commandsPendingConfig.execute({ workerId });
    const reusable = pending.find(command => {
      let payload = command.payload;
      if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return false; } }
      const parsed = WorkerConfigurePayload.safeParse(payload);
      return parsed.success && parsed.data.revision === revision;
    });
    if (reusable) {
      await q.connectReuseCommand.execute({ workerId, revision, commandId: reusable.id });
      return { state: "applying", commandId: reusable.id };
    }
    const commandId = randomUUID();
    const fingerprintValue = createHash("sha256").update(`${workerId}:${revision}`).digest("hex");
    const payload: WorkerConfigurePayload = { workerId, appliance: desired.appliance, runtime: desired.runtime, guestPlatforms: desired.guestPlatforms, selectedDriver: desired.selectedDriver, cache: desired.cache, revision, fingerprint: fingerprintValue };
    await q.updateConfigurationCommandState.execute({ workerId, state: "failed" });
    await q.insertCommand.execute({ commandId, type: "worker.configure", workerId, payload: JSON.stringify(payload) });
    await q.connectNewCommand.execute({ workerId, revision, commandId });
    return { state: "applying", commandId };
  });
}

export async function recoverWorkerConfigurationFromDoctor(db: DatabaseClient, workerId: string, report: WorkerDoctorReport): Promise<boolean> {
  if (!report.doctor.inventoryObservedAt || Date.now() - Date.parse(report.doctor.inventoryObservedAt) >= 60_000 || !report.doctor.activeLeases || report.doctor.activeLeases.length) return false;
  return db.transaction(async tx => {
    const q = queries(tx);
    const [worker] = await q.workerConnectLock.execute({ workerId });
    if (!worker || worker.configurationState !== "error") return false;
    let desiredInput = worker.desiredConfiguration;
    if (typeof desiredInput === "string") {
      try { desiredInput = JSON.parse(desiredInput); } catch { return false; }
    }
    const desired = WorkerConfiguration.safeParse(desiredInput);
    if (!desired.success || !report.doctor.capabilities?.some(capability => capability.ready && capability.driver === desired.data.selectedDriver && desired.data.guestPlatforms.includes(capability.guestPlatform))) return false;
    if (!(await q.retryConfigurationEligible.execute({ workerId }))[0]) return false;
    const recovered = await reconcileWorkerConfigurationOnConnect(tx, workerId, true);
    return recovered.state === "applying";
  });
}
export async function rejectPendingWorker(db: DatabaseClient, workerId: string, adminId: string): Promise<void> {
  await db.transaction(async tx => {
    const q = queries(tx);
    const rows = await q.reject.execute({ workerId });
    if (rows.length !== 1) throw new Error("worker rejection conflict");
    await q.rejectOnboarding.execute({ workerId });
    await q.audit.execute({ actor: adminId, type: "worker.rejected", payload: JSON.stringify({ workerId }) });
  });
}
