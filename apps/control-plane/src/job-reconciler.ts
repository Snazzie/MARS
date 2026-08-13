import type { DatabaseClient } from "@whitesmith/db";
import { reserveRoutingSlot } from "@whitesmith/db";
import { PoolResources as PoolResourcesSchema, type RunnerJitConfig, type LeaseBootstrapEnvelope } from "@whitesmith/contracts";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";
import { GithubJobsClient } from "./github-jobs.ts";
import { dispatchLeaseBootstrap } from "./lease-dispatch.ts";
import { reconcileQueuedJobs, type ReconcileReport } from "./reconcile.ts";
import { reason } from "./scheduler.ts";
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const LEASE_STARTUP_TTL_MS = 10 * 60_000;
type Dispatch = Pick<WorkerCommandDispatcher, "dispatch">;

export interface JobReconciliationDeps {
  db: DatabaseClient;
  installationToken: (installationId: number) => Promise<string>;
  dispatcher: Dispatch;
  workerConnected?: (workerId: string) => boolean;
  githubFetch?: Fetcher;
}
function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function stringArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

export async function runQueuedJobReconciliation(deps: JobReconciliationDeps): Promise<ReconcileReport> {
  const queuedRows = await deps.db`
    SELECT j.id AS "dashboardJobId", j.github_job_id AS "jobId", r.id AS "runId", r.repository_id AS "repositoryId",
      r.organization_id AS "organizationId", i.github_installation_id AS "installationId",
      repo.full_name AS repository, j.requested_labels AS labels
    FROM dashboard_jobs j
    JOIN dashboard_runs r ON r.id=j.run_id
    JOIN dashboard_repositories repo ON repo.id=r.repository_id
      AND repo.organization_id=r.organization_id AND repo.available=true AND repo.approved=true
    JOIN dashboard_installations i ON i.id=repo.installation_id
      AND i.organization_id=r.organization_id AND i.state='approved'
    WHERE j.status='queued' AND r.status='queued'
    ORDER BY j.github_job_id ASC
    FOR UPDATE OF j SKIP LOCKED`;
  if (!queuedRows.length) return { reserved: 0, skipped: 0, failed: 0 };

  const candidateRows = await deps.db`
    SELECT p.id AS "poolId", p.organization_id AS "organizationId", p.worker_id AS "poolWorkerId",
      w.id AS "workerId", p.enabled, p.image_digest AS "imageDigest", p.resources, p.labels, p.trigger_label AS "triggerLabel",
      w.admission_state AS "admissionState", w.connection_state AS "connectionState", w.configuration_state AS "configurationState",
      w.limits, w.encryption_public_key AS "encryptionPublicKey",
      (SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.worker_id=w.id
        AND l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')) AS active
    FROM runner_pools p
    JOIN workers w ON (p.worker_id IS NULL OR p.worker_id=w.id) AND w.platform=p.platform
    WHERE p.enabled=true AND w.draining=false`;

  const organizationByJob = new Map<number, string>();
  const installationByJob = new Map<number, number>();
  const dashboardJobByGithubJob = new Map<number, string>();
  const dashboardJobByLease = new Map<string, string>();
  const githubByInstallation = new Map<number, GithubJobsClient>();
  const workerByPool = new Map<string, { workerId: string; encryptionPublicKey: string; imageDigest: string; resources: ReturnType<typeof PoolResourcesSchema.parse> }>();

  const candidates = candidateRows.filter((row) => !deps.workerConnected || deps.workerConnected(String(row.workerId))).map((row) => {
    const resources = PoolResourcesSchema.parse(jsonValue(row.resources));
    const poolId = String(row.poolId);
    const workerId = String(row.workerId);
    const concurrency = Number(resources.concurrency);
    workerByPool.set(`${poolId}:${workerId}`, { workerId, encryptionPublicKey: String(row.encryptionPublicKey ?? ""), imageDigest: String(row.imageDigest), resources });
    return {
      requestedLabels: [],
      worker: { id: workerId, admissionState: String(row.admissionState), connectionState: String(row.connectionState), configurationState: String(row.configurationState), limits: jsonValue(row.limits) },
      pool: { id: poolId, enabled: Boolean(row.enabled), resources, concurrency, active: Number(row.active ?? 0), labels: stringArray(row.labels), triggerLabel: row.triggerLabel ? String(row.triggerLabel) : null },
    };
  });
  console.log(`Routing candidates=${candidates.length} queued=${queuedRows.length}`);
  for (const candidate of candidates) console.log(`Routing candidate ${candidate.pool.id}: ${reason({ ...candidate, requestedLabels: queuedRows[0] ? stringArray(queuedRows[0].labels) : [] })}`);

  return reconcileQueuedJobs({
    queued: queuedRows.map((row) => {
      const jobId = Number(row.jobId);
      organizationByJob.set(jobId, String(row.organizationId));
      installationByJob.set(jobId, Number(row.installationId));
      dashboardJobByGithubJob.set(jobId, String(row.dashboardJobId));
      return { installationId: Number(row.installationId), repositoryId: String(row.repositoryId), repository: String(row.repository), runId: String(row.runId), jobId, labels: stringArray(row.labels) };
    }),
    candidates,
    reserve: async (input) => {
      const reservation = await reserveRoutingSlot(deps.db, { organizationId: organizationByJob.get(input.githubJobId)!, ...input, ttlMs: LEASE_STARTUP_TTL_MS });
      const jobId = dashboardJobByGithubJob.get(input.githubJobId);
      if (reservation && jobId) dashboardJobByLease.set(reservation.id, jobId);
      return reservation;
    },
    jit: async (input) => {
      const installationId = installationByJob.get(input.githubJobId);
      if (!installationId) throw new Error("github_installation_not_found");
      let client = githubByInstallation.get(installationId);
      if (!client) {
        client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetch });
        githubByInstallation.set(installationId, client);
      }
      return client.generateJitConfig({ owner: input.owner, repo: input.repo, runnerName: input.runnerName, workFolder: "_work", labels: input.labels });
    },
    dispatch: async (reservation, jit) => {
      const target = workerByPool.get(`${reservation.poolId}:${reservation.workerId}`);
      if (!target?.encryptionPublicKey) throw new Error("worker_encryption_key_missing");
      const jobId = dashboardJobByLease.get(reservation.id);
      if (!jobId) throw new Error("dashboard_job_not_found");
      const envelope: LeaseBootstrapEnvelope = { leaseId: reservation.id, jobId, nonce: reservation.nonce, encodedJitConfig: jit.encodedJitConfig, expiresAt: reservation.expiresAt, imageDigest: target.imageDigest, resources: target.resources };
      await dispatchLeaseBootstrap(deps.dispatcher, { ...envelope, workerId: target.workerId, workerEncryptionPublicKey: target.encryptionPublicKey });
      await deps.db`UPDATE runner_leases SET state='dispatched', updated_at=now() WHERE id=${reservation.id} AND state='reserved'`;
    },
    release: async (reservation) => { await deps.db`UPDATE runner_leases SET state='failed', cleanup_state='pending', updated_at=now() WHERE id=${reservation.id} AND state='reserved'`; },
  });
}
