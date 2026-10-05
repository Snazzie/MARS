import type { DatabaseClient } from "./index.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { supportsExclusiveCpuPlacement } from "@mars/contracts";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";

export type LeaseReservationInput = {
  organizationId: string; poolId: string; workerId: string; githubJobId?: number; routingKey: string;
  requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number }; ttlMs: number;
};
export type LeaseReservation = { id: string; jobId?: number; nonce: string; workerId: string; poolId: string; expiresAt: string; requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number }; cpuMode: "shared" | "exclusive"; cpuIds: number[] | null };

const activeStates = ["reserved", "requested", "dispatched", "provisioning", "sandbox_ready", "online", "busy"];
const createCommandTypes = ["linux-vm.create_lease", "linux-container.create_lease", "windows-container.create_lease", "hyperv.create_lease", "tart.create_lease"];
const leaseQueries = defineQueries((db) => ({
  eligible: db.select({ id: schema.runnerPools.id, resources: schema.runnerPools.resources, cpuMode: schema.runnerPools.cpuMode, platform: schema.runnerPools.platform, driver: schema.runnerPools.driver, imageDigest: schema.runnerPools.imageDigest, workerId: schema.workers.id, hostPlatform: schema.workers.platform, contractVersion: schema.workers.contractVersion, limits: schema.workers.limits, doctor: schema.workers.doctor }).from(schema.runnerPools)
    .innerJoin(schema.workers, eq(schema.workers.id, sql.placeholder("workerId")))
    .where(and(eq(schema.runnerPools.id, sql.placeholder("poolId")), eq(schema.runnerPools.enabled, true), eq(schema.workers.admissionState, "adopted"), eq(schema.workers.connectionState, "online"), eq(schema.workers.configurationState, "ready"), eq(schema.workers.configurationRevision, schema.workers.appliedConfigurationRevision), eq(schema.workers.draining, false), sql`${schema.workers.lastHeartbeatAt} > now()-interval '60 seconds'`, sql`${schema.workers.doctorObservedAt} > now()-interval '60 seconds'`, sql`${schema.runnerPools.platform}=ANY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(${schema.workers.guestPlatforms})='array' THEN ${schema.workers.guestPlatforms} ELSE (${schema.workers.guestPlatforms} #>> '{}')::jsonb END))`, sql`${schema.runnerPools.driver}=${schema.workers.desiredConfiguration}->>'selectedDriver'`, sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof((CASE WHEN jsonb_typeof(${schema.workers.doctor}->'doctor')='object' THEN ${schema.workers.doctor}->'doctor' ELSE ${schema.workers.doctor} END)->'capabilities')='array' THEN (CASE WHEN jsonb_typeof(${schema.workers.doctor}->'doctor')='object' THEN ${schema.workers.doctor}->'doctor' ELSE ${schema.workers.doctor} END)->'capabilities' ELSE '[]'::jsonb END) capability WHERE capability->>'driver'=${schema.runnerPools.driver} AND capability->>'guestPlatform'=${schema.runnerPools.platform} AND capability->>'ready'='true')`, sql`COALESCE((CASE WHEN jsonb_typeof(${schema.workers.doctor}->'doctor')='object' THEN ${schema.workers.doctor}->'doctor' ELSE ${schema.workers.doctor} END)->>'acceptingLeases','true') <> 'false'`))
    .for("update", { of: [schema.runnerPools, schema.workers] }).prepare("lease_eligible_worker_pool"),
  poolActive: db.select({ count: sql<number>`count(*)::int` }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.poolId, sql.placeholder("poolId")), eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), inArray(schema.runnerLeases.state, activeStates))).prepare("lease_active_pool_count"),
  workerActive: db.select({ count: sql<number>`count(*)::int`, vcpu: sql<bigint>`COALESCE(SUM((${schema.runnerLeases.requested}->>'vcpu')::bigint),0)::bigint`, memoryBytes: sql<bigint>`COALESCE(SUM((${schema.runnerLeases.requested}->>'memoryBytes')::bigint),0)::bigint`, storageBytes: sql<bigint>`COALESCE(SUM((${schema.runnerLeases.requested}->>'storageBytes')::bigint),0)::bigint` }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), sql`(CASE WHEN ${sql.placeholder("exclusive")} THEN ${schema.runnerLeases.state} <> 'reaped' ELSE ${schema.runnerLeases.state} IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy') END)`)).prepare("lease_active_worker_capacity"),
  cpuLeases: db.select({ cpuMode: schema.runnerLeases.cpuMode, cpuIds: schema.runnerLeases.cpuIds }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), ne(schema.runnerLeases.state, "reaped"))).prepare("lease_worker_cpu_claims"),
  reserve: db.insert(schema.runnerLeases).values({ id: sql.placeholder("id"), organizationId: sql.placeholder("organizationId"), poolId: sql.placeholder("poolId"), workerId: sql.placeholder("workerId"), routingKey: sql.placeholder("routingKey"), githubJobId: sql.placeholder("githubJobId"), state: "reserved", requested: sql.placeholder("requested"), cpuMode: sql.placeholder("cpuMode"), cpuIds: sql`${sql.placeholder("cpuIds")}::jsonb`, nonce: sql.placeholder("nonce"), expiresAt: sql.placeholder("expiresAt") }).onConflictDoUpdate({ target: schema.runnerLeases.githubJobId, set: { organizationId: sql`excluded.organization_id`, poolId: sql`excluded.pool_id`, workerId: sql`excluded.worker_id`, routingKey: sql`excluded.routing_key`, state: "reserved", requested: sql`excluded.requested`, cpuMode: sql`excluded.cpu_mode`, cpuIds: sql`excluded.cpu_ids`, nonce: sql`excluded.nonce`, expiresAt: sql`excluded.expires_at`, cleanupState: "none", terminalResult: null, updatedAt: sql`now()` }, setWhere: eq(schema.runnerLeases.state, "reaped") }).returning({ id: schema.runnerLeases.id, jobId: schema.runnerLeases.githubJobId, nonce: schema.runnerLeases.nonce, workerId: schema.runnerLeases.workerId, poolId: schema.runnerLeases.poolId, requested: schema.runnerLeases.requested, cpuMode: schema.runnerLeases.cpuMode, cpuIds: schema.runnerLeases.cpuIds, expiresAt: schema.runnerLeases.expiresAt }).prepare("lease_reserve_routing_slot"),
  invalidateCommands: db.update(schema.commands).set({ state: "failed" }).where(and(eq(schema.commands.leaseId, sql.placeholder("leaseId")), inArray(schema.commands.type, createCommandTypes), inArray(schema.commands.state, ["pending", "sent"]))).prepare("lease_invalidate_create_commands"),
  updateJobResources: db.update(schema.dashboardJobs).set({ requested: sql`${sql.placeholder("requested")}::jsonb` }).where(eq(schema.dashboardJobs.githubJobId, sql.placeholder("githubJobId"))).prepare("lease_update_job_resources"),
  bind: db.update(schema.runnerLeases).set({ githubJobId: sql`${sql.placeholder("githubJobId")}`, state: "dispatched", updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), sql`${schema.runnerLeases.githubJobId} IS NULL`, inArray(schema.runnerLeases.state, ["reserved", "requested"]))).returning({ id: schema.runnerLeases.id }).prepare("lease_bind_github_job"),
  byId: db.select({ githubJobId: schema.runnerLeases.githubJobId }).from(schema.runnerLeases).where(eq(schema.runnerLeases.id, sql.placeholder("leaseId"))).prepare("lease_get_job_binding"),
  complete: db.update(schema.runnerLeases).set({ state: sql`${sql.placeholder("state")}`, terminalResult: sql`${sql.placeholder("terminalResult")}::jsonb`, updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), notInArray(schema.runnerLeases.state, ["completed", "failed", "reaped"]))).prepare("lease_complete"),
}));

export async function reserveRoutingSlot(db: DatabaseClient, input: LeaseReservationInput): Promise<LeaseReservation> {
  const queries = leaseQueries(db);
  const nonce = randomBytes(32).toString("base64url"), id = randomUUID(), expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  const row = await db.transaction(async () => {
    const [eligible] = await queries.eligible.execute({ poolId: input.poolId, workerId: input.workerId });
    if (!eligible) throw new Error("worker_not_eligible");
    const poolResources = typeof eligible.resources === "string" ? JSON.parse(eligible.resources) : eligible.resources;
    const limits = typeof eligible.limits === "string" ? JSON.parse(eligible.limits) : eligible.limits;
    if (!poolResources || input.requested.storageBytes > Number(poolResources.storageBytes) || input.requested.concurrency > Number(poolResources.concurrency)) throw new Error("pool_resource_ceiling_exceeded");
    if (!limits || input.requested.vcpu > Number(limits.maxVcpuPerPod) || input.requested.memoryBytes > Number(limits.maxMemoryBytesPerPod) || input.requested.storageBytes > Number(limits.maxStorageBytesPerPod)) throw new Error("worker_resource_ceiling_exceeded");
    const [active] = await queries.poolActive.execute({ poolId: input.poolId, workerId: input.workerId });
    if (Number(active?.count ?? 0) >= Number(poolResources.concurrency)) throw new Error("pool_capacity_exhausted");
    const mode = eligible.cpuMode === "exclusive" ? "exclusive" : "shared";
    const [workerActive] = await queries.workerActive.execute({ workerId: input.workerId, exclusive: mode === "exclusive" });
    const doctor = typeof eligible.doctor === "string" ? JSON.parse(eligible.doctor) : eligible.doctor;
    const leases = await queries.cpuLeases.execute({ workerId: input.workerId });
    if (leases.some(lease => lease.cpuMode !== mode)) throw new Error("worker_capacity_exhausted");
    let cpuIds: number[] | null = null;
    if (mode === "exclusive") {
      if (!supportsExclusiveCpuPlacement(String(eligible.contractVersion ?? ""))) throw new Error("worker_not_eligible");
      if (String(eligible.hostPlatform).startsWith("linux-")) {
        const evidence = doctor?.doctor ?? doctor, inventory = evidence?.availableCpuIds;
        if (!Array.isArray(inventory) || inventory.length === 0 || inventory.some((cpu: unknown, index: number) => typeof cpu !== "number" || !Number.isInteger(cpu) || cpu < 0 || cpu > 65535 || index > 0 && cpu <= inventory[index - 1])) throw new Error("worker_capacity_exhausted");
        const used = new Set<number>();
        for (const lease of leases) {
          const claimed = typeof lease.cpuIds === "string" ? JSON.parse(lease.cpuIds) : lease.cpuIds;
          if (!Array.isArray(claimed)) throw new Error("worker_capacity_exhausted");
          for (const cpu of claimed) used.add(Number(cpu));
        }
        cpuIds = inventory.filter((cpu: number) => !used.has(cpu)).slice(0, input.requested.vcpu);
        if (cpuIds.length !== input.requested.vcpu) throw new Error("worker_capacity_exhausted");
      } else if (Number(limits.maxConcurrentPods) !== 1 || Number(poolResources.concurrency) !== 1 || leases.length > 0) throw new Error("worker_capacity_exhausted");
    }
    const capacity = doctor?.capacity ?? {}, activeVcpu = Number(workerActive?.vcpu ?? 0), activeMemoryBytes = Number(workerActive?.memoryBytes ?? 0), activeStorageBytes = Number(workerActive?.storageBytes ?? 0);
    const exceedsCurrentCapacity = capacity.freeVcpu !== undefined && (input.requested.vcpu > Number(capacity.freeVcpu) || input.requested.memoryBytes > Number(capacity.freeMemoryBytes ?? 0) || input.requested.storageBytes > Number(capacity.freeStorageBytes ?? 0));
    const exceedsConfiguredCapacity = capacity.actualVcpu !== undefined && (activeVcpu + input.requested.vcpu > Number(capacity.actualVcpu) || activeMemoryBytes + input.requested.memoryBytes > Number(capacity.actualMemoryBytes ?? 0) || activeStorageBytes + input.requested.storageBytes > Number(capacity.actualStorageBytes ?? 0));
    if (Number(workerActive?.count ?? 0) >= Number(limits.maxConcurrentPods) || exceedsCurrentCapacity || exceedsConfiguredCapacity) throw new Error("worker_capacity_exhausted");
    const [reserved] = await queries.reserve.execute({ id, organizationId: input.organizationId, poolId: input.poolId, workerId: input.workerId, routingKey: input.routingKey, githubJobId: input.githubJobId ?? null, requested: input.requested, cpuMode: mode, cpuIds: cpuIds === null ? null : JSON.stringify(cpuIds), nonce, expiresAt });
    if (!reserved) throw new Error("job_already_claimed");
    await queries.invalidateCommands.execute({ leaseId: reserved.id });
    if (input.githubJobId !== undefined) await queries.updateJobResources.execute({ githubJobId: input.githubJobId, requested: JSON.stringify(input.requested) });
    return reserved;
  });
  if (!row) throw new Error("lease_reservation_failed");
  const normalizedExpiresAt = new Date(String(row.expiresAt));
  if (!Number.isFinite(normalizedExpiresAt.getTime())) throw new Error("lease_expiration_invalid");
  return { id: String(row.id), jobId: row.jobId == null ? undefined : Number(row.jobId), nonce: String(row.nonce), workerId: String(row.workerId), poolId: String(row.poolId), expiresAt: normalizedExpiresAt.toISOString(), requested: typeof row.requested === "string" ? JSON.parse(row.requested) : row.requested, cpuMode: row.cpuMode === "exclusive" ? "exclusive" : "shared", cpuIds: row.cpuIds == null ? null : typeof row.cpuIds === "string" ? JSON.parse(row.cpuIds) : row.cpuIds };
}

export async function bindLeaseToJob(db: DatabaseClient, leaseId: string, githubJobId: number): Promise<void> {
  const queries = leaseQueries(db), rows = await queries.bind.execute({ leaseId, githubJobId });
  if (rows[0]) return;
  const [existing] = await queries.byId.execute({ leaseId });
  if (existing?.githubJobId === githubJobId) return;
  throw new Error("lease_job_conflict");
}
export async function completeLease(db: DatabaseClient, leaseId: string, result: { state: "completed" | "failed"; conclusion?: string | null }): Promise<void> {
  await leaseQueries(db).complete.execute({ leaseId, state: result.state, terminalResult: JSON.stringify(result) });
}
