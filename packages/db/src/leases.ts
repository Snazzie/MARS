import type { DatabaseClient } from "./index.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { jsonParameter } from "./json.ts";

export type LeaseReservationInput = {
  organizationId: string;
  poolId: string;
  workerId: string;
  githubJobId?: number;
  routingKey: string;
  requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number };
  ttlMs: number;
};
export type LeaseReservation = { id: string; jobId?: number; nonce: string; workerId: string; poolId: string; expiresAt: string; requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number } };

export async function reserveRoutingSlot(sql: DatabaseClient, input: LeaseReservationInput): Promise<LeaseReservation> {
  const nonce = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  const rows = await sql.begin(async (tx) => {
    const eligible = await tx`SELECT p.id, p.resources, w.id AS "workerId", w.limits, w.doctor
      FROM runner_pools p JOIN workers w ON w.id=${input.workerId}
      WHERE p.id=${input.poolId}
        AND p.enabled=true AND w.admission_state='adopted'
        AND w.configuration_state='ready' AND w.draining=false FOR UPDATE OF p, w`;
    if (!eligible[0]) throw new Error("worker_not_eligible");
    const [organization] = await tx`SELECT max_vcpu_per_pod AS "maxVcpuPerPod", max_memory_bytes_per_pod AS "maxMemoryBytesPerPod", max_storage_bytes_per_pod AS "maxStorageBytesPerPod", max_concurrent_pods AS "maxConcurrentPods" FROM organization_settings WHERE organization_id=${input.organizationId}`;
    if (organization && (input.requested.vcpu > Number(organization.maxVcpuPerPod) || input.requested.memoryBytes > Number(organization.maxMemoryBytesPerPod) || input.requested.storageBytes > Number(organization.maxStorageBytesPerPod))) throw new Error("organization_limit");
    if (organization) {
      const [activeOrganization] = await tx`SELECT count(*)::int AS count FROM runner_leases WHERE organization_id=${input.organizationId} AND state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')`;
      if (Number(activeOrganization?.count ?? 0) >= Number(organization.maxConcurrentPods)) throw new Error("organization_limit");
    }
    const poolResources = typeof eligible[0].resources === "string" ? JSON.parse(eligible[0].resources) : eligible[0].resources;
    const limits = typeof eligible[0].limits === "string" ? JSON.parse(eligible[0].limits) : eligible[0].limits;
    if (!poolResources || input.requested.storageBytes > Number(poolResources.storageBytes) || input.requested.concurrency > Number(poolResources.concurrency)) throw new Error("pool_resource_ceiling_exceeded");
    if (!limits || input.requested.vcpu > Number(limits.maxVcpuPerPod) || input.requested.memoryBytes > Number(limits.maxMemoryBytesPerPod) || input.requested.storageBytes > Number(limits.maxStorageBytesPerPod)) throw new Error("worker_resource_ceiling_exceeded");
    const active = await tx`SELECT count(*)::int AS count FROM runner_leases WHERE pool_id=${input.poolId} AND worker_id=${input.workerId} AND state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')`;
    if (Number(active[0]?.count ?? 0) >= Number(poolResources.concurrency)) throw new Error("pool_capacity_exhausted");
    const workerActive = await tx`SELECT count(*)::int AS count, COALESCE(SUM((requested->>'vcpu')::bigint),0)::bigint AS vcpu, COALESCE(SUM((requested->>'memoryBytes')::bigint),0)::bigint AS "memoryBytes", COALESCE(SUM((requested->>'storageBytes')::bigint),0)::bigint AS "storageBytes" FROM runner_leases WHERE worker_id=${input.workerId} AND state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')`;
    const doctor = typeof eligible[0].doctor === "string" ? JSON.parse(eligible[0].doctor) : eligible[0].doctor;
    const capacity = doctor?.capacity ?? {};
    if (Number(workerActive[0]?.count ?? 0) >= Number(limits.maxConcurrentPods) || (capacity.freeVcpu !== undefined && (input.requested.vcpu > Number(capacity.freeVcpu) || input.requested.memoryBytes > Number(capacity.freeMemoryBytes ?? 0) || input.requested.storageBytes > Number(capacity.freeStorageBytes ?? 0)))) throw new Error("worker_capacity_exhausted");
    const inserted = await tx`INSERT INTO runner_leases (id,organization_id,pool_id,worker_id,routing_key,github_job_id,state,requested,nonce,expires_at)
      VALUES (${id},${input.organizationId},${input.poolId},${input.workerId},${input.routingKey},${input.githubJobId ?? null},'reserved',${jsonParameter(tx, input.requested)},${nonce},${expiresAt})
      ON CONFLICT (github_job_id) DO UPDATE SET organization_id=EXCLUDED.organization_id,pool_id=EXCLUDED.pool_id,worker_id=EXCLUDED.worker_id,routing_key=EXCLUDED.routing_key,state='reserved',requested=EXCLUDED.requested,nonce=EXCLUDED.nonce,expires_at=EXCLUDED.expires_at,cleanup_state='none',terminal_result=null,updated_at=now()
      WHERE runner_leases.state IN ('failed','reaped')
      RETURNING id,github_job_id AS "jobId",nonce,worker_id AS "workerId",pool_id AS "poolId",requested,expires_at AS "expiresAt"`;
    if (inserted[0] && input.githubJobId !== undefined) await tx`UPDATE dashboard_jobs SET requested=${jsonParameter(tx, input.requested)}::jsonb WHERE github_job_id=${input.githubJobId}`;
    if (!inserted[0]) throw new Error("job_already_claimed");
    return inserted;
  });
  const row = rows[0];
  if (!row) throw new Error("lease_reservation_failed");
  const normalizedExpiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt));
  if (!Number.isFinite(normalizedExpiresAt.getTime())) throw new Error("lease_expiration_invalid");
  return { id: String(row.id), jobId: row.jobId === null || row.jobId === undefined ? undefined : Number(row.jobId), nonce: String(row.nonce), workerId: String(row.workerId), poolId: String(row.poolId), expiresAt: normalizedExpiresAt.toISOString(), requested: typeof row.requested === "string" ? JSON.parse(row.requested) : row.requested };
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
