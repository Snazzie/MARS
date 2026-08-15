import type { Sql } from "postgres";
import { randomBytes, randomUUID } from "node:crypto";

export type LeaseReservationInput = {
  organizationId: string;
  poolId: string;
  workerId: string;
  githubJobId?: number;
  routingKey: string;
  requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number };
  ttlMs: number;
};
export type LeaseReservation = { id: string; nonce: string; workerId: string; poolId: string; expiresAt: string };

export async function reserveRoutingSlot(sql: Sql<{}>, input: LeaseReservationInput): Promise<LeaseReservation> {
  const nonce = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  const rows = await sql.begin(async (tx) => {
    const eligible = await tx`SELECT p.id, p.resources, p.concurrency AS "poolConcurrency", w.id AS "workerId", w.limits, w.doctor
      FROM runner_pools p JOIN workers w ON w.id=${input.workerId}
      WHERE p.id=${input.poolId}
        AND p.enabled=true AND w.admission_state='adopted' AND w.connection_state='online'
        AND w.configuration_state='ready' AND w.draining=false FOR UPDATE OF p, w`;
    if (!eligible[0]) throw new Error("worker_not_ready");
    const poolResources = typeof eligible[0].resources === "string" ? JSON.parse(eligible[0].resources) : eligible[0].resources;
    const limits = typeof eligible[0].limits === "string" ? JSON.parse(eligible[0].limits) : eligible[0].limits;
    if (!poolResources || input.requested.storageBytes > Number(poolResources.storageBytes) || input.requested.concurrency > Number(poolResources.concurrency)) throw new Error("pool_resource_ceiling_exceeded");
    if (!limits || input.requested.vcpu > Number(limits.maxVcpuPerPod) || input.requested.memoryBytes > Number(limits.maxMemoryBytesPerPod) || input.requested.storageBytes > Number(limits.maxStorageBytesPerPod)) throw new Error("worker_resource_ceiling_exceeded");
    const active = await tx`SELECT count(*)::int AS count FROM runner_leases WHERE pool_id=${input.poolId} AND worker_id=${input.workerId} AND state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')`;
    if (Number(active[0]?.count ?? 0) >= Number(eligible[0].poolConcurrency)) throw new Error("pool_capacity_exhausted");
    const workerActive = await tx`SELECT count(*)::int AS count, COALESCE(SUM((requested->>'vcpu')::bigint),0)::bigint AS vcpu, COALESCE(SUM((requested->>'memoryBytes')::bigint),0)::bigint AS "memoryBytes", COALESCE(SUM((requested->>'storageBytes')::bigint),0)::bigint AS "storageBytes" FROM runner_leases WHERE worker_id=${input.workerId} AND state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')`;
    const doctor = typeof eligible[0].doctor === "string" ? JSON.parse(eligible[0].doctor) : eligible[0].doctor;
    const capacity = doctor?.capacity ?? {};
    if (Number(workerActive[0]?.count ?? 0) >= Number(limits.maxConcurrentPods) || (capacity.freeVcpu !== undefined && (Number(workerActive[0]?.vcpu ?? 0) + input.requested.vcpu > Number(capacity.freeVcpu) || Number(workerActive[0]?.memoryBytes ?? 0) + input.requested.memoryBytes > Number(capacity.freeMemoryBytes ?? 0) || Number(workerActive[0]?.storageBytes ?? 0) + input.requested.storageBytes > Number(capacity.freeStorageBytes ?? 0)))) throw new Error("worker_capacity_exhausted");
    const inserted = await tx`INSERT INTO runner_leases (id,organization_id,pool_id,worker_id,routing_key,github_job_id,state,requested,nonce,expires_at)
      VALUES (${id},${input.organizationId},${input.poolId},${input.workerId},${input.routingKey},${input.githubJobId ?? null},'reserved',${JSON.stringify(input.requested)},${nonce},${expiresAt})
      ON CONFLICT (github_job_id) DO UPDATE SET id=EXCLUDED.id,organization_id=EXCLUDED.organization_id,pool_id=EXCLUDED.pool_id,worker_id=EXCLUDED.worker_id,routing_key=EXCLUDED.routing_key,state='reserved',requested=EXCLUDED.requested,nonce=EXCLUDED.nonce,expires_at=EXCLUDED.expires_at,cleanup_state='none',terminal_result=null,updated_at=now()
      WHERE runner_leases.state IN ('failed','reaped')
      RETURNING id,nonce,worker_id AS "workerId",pool_id AS "poolId",expires_at AS "expiresAt"`;
    if (inserted[0] && input.githubJobId !== undefined) await tx`UPDATE dashboard_jobs SET requested=${JSON.stringify(input.requested)}::jsonb WHERE github_job_id=${input.githubJobId}`;
    if (!inserted[0]) throw new Error("job_already_claimed");
    return inserted;
  });
  const row = rows[0];
  if (!row) throw new Error("lease_reservation_failed");
  return { id: String(row.id), nonce: String(row.nonce), workerId: String(row.workerId), poolId: String(row.poolId), expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt) };
}

export async function bindLeaseToJob(sql: Sql<{}>, leaseId: string, githubJobId: number): Promise<void> {
  const rows = await sql`UPDATE runner_leases SET github_job_id=${githubJobId}, state='dispatched', updated_at=now() WHERE id=${leaseId} AND github_job_id IS NULL AND state IN ('reserved','requested') RETURNING id`;
  if (!rows[0]) {
    const existing = await sql`SELECT github_job_id FROM runner_leases WHERE id=${leaseId}`;
    if (existing[0]?.github_job_id === githubJobId) return;
    throw new Error("lease_job_conflict");
  }
}

export async function completeLease(sql: Sql<{}>, leaseId: string, result: { state: "completed" | "failed"; conclusion?: string | null }): Promise<void> {
  await sql`UPDATE runner_leases SET state=${result.state}, terminal_result=${JSON.stringify(result)}, updated_at=now() WHERE id=${leaseId} AND state NOT IN ('completed','failed','reaped')`;
}

export async function expireLeases(sql: Sql<{}>, now = new Date()): Promise<string[]> {
  const rows = await sql`UPDATE runner_leases SET state='failed', cleanup_state='pending', updated_at=now() WHERE expires_at < ${now.toISOString()} AND state NOT IN ('completed','failed','reaped') RETURNING worker_id AS "workerId"`;
  return rows.map((row) => String(row.workerId));
}
