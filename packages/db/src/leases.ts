import type { DatabaseClient } from "./index.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { jsonParameter } from "./json.ts";
import { supportsExclusiveCpuPlacement } from "@mars/contracts";

export type LeaseReservationInput = {
  organizationId: string;
  poolId: string;
  workerId: string;
  githubJobId?: number;
  routingKey: string;
  requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number };
  ttlMs: number;
};
export type LeaseReservation = { id: string; jobId?: number; nonce: string; workerId: string; poolId: string; expiresAt: string; requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number }; cpuMode: "shared" | "exclusive"; cpuIds: number[] | null };

export async function reserveRoutingSlot(sql: DatabaseClient, input: LeaseReservationInput): Promise<LeaseReservation> {
  const nonce = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  const rows = await sql.begin(async (tx) => {
    const eligible = await tx`SELECT p.id, p.resources, p.cpu_mode AS "cpuMode", p.platform, p.driver, p.image_digest AS "imageDigest", w.id AS "workerId", w.platform AS "hostPlatform", w.contract_version AS "contractVersion", w.limits, w.doctor
      FROM runner_pools p JOIN workers w ON w.id=${input.workerId}
      CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(w.doctor->'doctor')='object' THEN w.doctor->'doctor' ELSE w.doctor END AS evidence) e
      WHERE p.id=${input.poolId}
        AND p.enabled=true AND w.admission_state='adopted' AND w.connection_state='online'
        AND w.configuration_state='ready' AND w.configuration_revision=w.applied_configuration_revision AND w.draining=false
        AND w.last_heartbeat_at > now()-interval '60 seconds' AND w.doctor_observed_at > now()-interval '60 seconds'
        AND p.platform=ANY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(w.guest_platforms)='array' THEN w.guest_platforms ELSE (w.guest_platforms #>> '{}')::jsonb END))
        AND p.driver=w.desired_configuration->>'selectedDriver'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.evidence->'capabilities')='array' THEN e.evidence->'capabilities' ELSE '[]'::jsonb END) capability WHERE capability->>'driver'=p.driver AND capability->>'guestPlatform'=p.platform AND capability->>'ready'='true' AND capability->>'imageDigest'=p.image_digest)
        AND COALESCE(e.evidence->>'acceptingLeases','true') <> 'false' FOR UPDATE OF p, w`;
    if (!eligible[0]) throw new Error("worker_not_eligible");
    const poolResources = typeof eligible[0].resources === "string" ? JSON.parse(eligible[0].resources) : eligible[0].resources;
    const limits = typeof eligible[0].limits === "string" ? JSON.parse(eligible[0].limits) : eligible[0].limits;
    if (!poolResources || input.requested.storageBytes > Number(poolResources.storageBytes) || input.requested.concurrency > Number(poolResources.concurrency)) throw new Error("pool_resource_ceiling_exceeded");
    if (!limits || input.requested.vcpu > Number(limits.maxVcpuPerPod) || input.requested.memoryBytes > Number(limits.maxMemoryBytesPerPod) || input.requested.storageBytes > Number(limits.maxStorageBytesPerPod)) throw new Error("worker_resource_ceiling_exceeded");
    const active = await tx`SELECT count(*)::int AS count FROM runner_leases WHERE pool_id=${input.poolId} AND worker_id=${input.workerId} AND state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')`;
    if (Number(active[0]?.count ?? 0) >= Number(poolResources.concurrency)) throw new Error("pool_capacity_exhausted");
    const workerActive = await tx`SELECT count(*)::int AS count, COALESCE(SUM((requested->>'vcpu')::bigint),0)::bigint AS vcpu, COALESCE(SUM((requested->>'memoryBytes')::bigint),0)::bigint AS "memoryBytes", COALESCE(SUM((requested->>'storageBytes')::bigint),0)::bigint AS "storageBytes" FROM runner_leases WHERE worker_id=${input.workerId} AND (CASE WHEN ${eligible[0].cpuMode}='exclusive' THEN state <> 'reaped' ELSE state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy') END)`;
    const doctor = typeof eligible[0].doctor === "string" ? JSON.parse(eligible[0].doctor) : eligible[0].doctor;
    const mode = eligible[0].cpuMode === "exclusive" ? "exclusive" : "shared";
    const leases = await tx`SELECT cpu_mode AS "cpuMode",cpu_ids AS "cpuIds" FROM runner_leases WHERE worker_id=${input.workerId} AND state <> 'reaped'`;
    if (leases.some(lease => lease.cpuMode !== mode)) throw new Error("worker_capacity_exhausted");
    let cpuIds: number[] | null = null;
    if (mode === "exclusive") {
      if (!supportsExclusiveCpuPlacement(String(eligible[0].contractVersion ?? ""))) throw new Error("worker_not_eligible");
      if (String(eligible[0].hostPlatform).startsWith("linux-")) {
        const evidence = doctor?.doctor ?? doctor;
        const inventory = evidence?.availableCpuIds;
        if (!Array.isArray(inventory) || inventory.length === 0 || inventory.some((id: unknown, index: number) => typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 65535 || index > 0 && id <= inventory[index - 1])) throw new Error("worker_capacity_exhausted");
        const used = new Set<number>();
        for (const lease of leases) {
          const claimed = typeof lease.cpuIds === "string" ? JSON.parse(lease.cpuIds) : lease.cpuIds;
          if (!Array.isArray(claimed)) throw new Error("worker_capacity_exhausted");
          for (const id of claimed) used.add(Number(id));
        }
        cpuIds = inventory.filter((id: number) => !used.has(id)).slice(0, input.requested.vcpu);
        if (cpuIds.length !== input.requested.vcpu) throw new Error("worker_capacity_exhausted");
      } else if (Number(limits.maxConcurrentPods) !== 1 || Number(poolResources.concurrency) !== 1 || leases.length > 0) throw new Error("worker_capacity_exhausted");
    }
    const capacity = doctor?.capacity ?? {};
    const activeVcpu = Number(workerActive[0]?.vcpu ?? 0);
    const activeMemoryBytes = Number(workerActive[0]?.memoryBytes ?? 0);
    const activeStorageBytes = Number(workerActive[0]?.storageBytes ?? 0);
    const exceedsCurrentCapacity = capacity.freeVcpu !== undefined && (input.requested.vcpu > Number(capacity.freeVcpu) || input.requested.memoryBytes > Number(capacity.freeMemoryBytes ?? 0) || input.requested.storageBytes > Number(capacity.freeStorageBytes ?? 0));
    const exceedsConfiguredCapacity = capacity.actualVcpu !== undefined && (activeVcpu + input.requested.vcpu > Number(capacity.actualVcpu) || activeMemoryBytes + input.requested.memoryBytes > Number(capacity.actualMemoryBytes ?? 0) || activeStorageBytes + input.requested.storageBytes > Number(capacity.actualStorageBytes ?? 0));
    if (Number(workerActive[0]?.count ?? 0) >= Number(limits.maxConcurrentPods) || exceedsCurrentCapacity || exceedsConfiguredCapacity) throw new Error("worker_capacity_exhausted");
    const inserted = await tx`INSERT INTO runner_leases (id,organization_id,pool_id,worker_id,routing_key,github_job_id,state,requested,cpu_mode,cpu_ids,nonce,expires_at)
      VALUES (${id},${input.organizationId},${input.poolId},${input.workerId},${input.routingKey},${input.githubJobId ?? null},'reserved',${jsonParameter(tx, input.requested)},${mode},${cpuIds === null ? null : jsonParameter(tx, cpuIds)},${nonce},${expiresAt})
      ON CONFLICT (github_job_id) DO UPDATE SET organization_id=EXCLUDED.organization_id,pool_id=EXCLUDED.pool_id,worker_id=EXCLUDED.worker_id,routing_key=EXCLUDED.routing_key,state='reserved',requested=EXCLUDED.requested,cpu_mode=EXCLUDED.cpu_mode,cpu_ids=EXCLUDED.cpu_ids,nonce=EXCLUDED.nonce,expires_at=EXCLUDED.expires_at,cleanup_state='none',terminal_result=null,updated_at=now()
      WHERE runner_leases.state='reaped'
      RETURNING id,github_job_id AS "jobId",nonce,worker_id AS "workerId",pool_id AS "poolId",requested,cpu_mode AS "cpuMode",cpu_ids AS "cpuIds",expires_at AS "expiresAt"`;
    if (!inserted[0]) throw new Error("job_already_claimed");
    await tx`UPDATE commands SET state='failed'
      WHERE lease_id=${inserted[0].id}
        AND type IN ('linux-vm.create_lease','linux-container.create_lease','windows-container.create_lease','hyperv.create_lease','tart.create_lease')
        AND state IN ('pending','sent')`;
    if (input.githubJobId !== undefined) await tx`UPDATE dashboard_jobs SET requested=${jsonParameter(tx, input.requested)}::jsonb WHERE github_job_id=${input.githubJobId}`;
    return inserted;
  });
  const row = rows[0];
  if (!row) throw new Error("lease_reservation_failed");
  const normalizedExpiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt));
  if (!Number.isFinite(normalizedExpiresAt.getTime())) throw new Error("lease_expiration_invalid");
  return { id: String(row.id), jobId: row.jobId === null || row.jobId === undefined ? undefined : Number(row.jobId), nonce: String(row.nonce), workerId: String(row.workerId), poolId: String(row.poolId), expiresAt: normalizedExpiresAt.toISOString(), requested: typeof row.requested === "string" ? JSON.parse(row.requested) : row.requested, cpuMode: row.cpuMode === "exclusive" ? "exclusive" : "shared", cpuIds: row.cpuIds == null ? null : typeof row.cpuIds === "string" ? JSON.parse(row.cpuIds) : row.cpuIds };
}

export async function bindLeaseToJob(sql: DatabaseClient, leaseId: string, githubJobId: number): Promise<void> {
  const rows = await sql`UPDATE runner_leases SET github_job_id=${githubJobId}, state='dispatched', updated_at=now() WHERE id=${leaseId} AND github_job_id IS NULL AND state IN ('reserved','requested') RETURNING id`;
  if (!rows[0]) {
    const existing = await sql`SELECT github_job_id FROM runner_leases WHERE id=${leaseId}`;
    if (existing[0]?.github_job_id === githubJobId) return;
    throw new Error("lease_job_conflict");
  }
}
export async function completeLease(sql: DatabaseClient, leaseId: string, result: { state: "completed" | "failed"; conclusion?: string | null }): Promise<void> {
  await sql`UPDATE runner_leases SET state=${result.state}, terminal_result=${jsonParameter(sql, result)}, updated_at=now() WHERE id=${leaseId} AND state NOT IN ('completed','failed','reaped')`;
}
