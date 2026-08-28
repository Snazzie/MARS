import type { DatabaseClient } from "@mars/db";
import { reserveRoutingSlot } from "@mars/db";
import { PoolResources as PoolResourcesSchema, RuntimeDriverName, type PoolResources as PoolResourcesValue, type RuntimeDriverName as RuntimeDriverNameValue, type RunnerJitConfig, type LeaseBootstrapEnvelope } from "@mars/contracts";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";
import { GithubJobsClient } from "./github-jobs.ts";
import { dispatchLeaseBootstrap } from "./lease-dispatch.ts";
import { reconcileQueuedJobs, type ReconcileReport } from "./reconcile.ts";
import { reason, type Candidate } from "./scheduler.ts";
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const LEASE_STARTUP_TTL_MS = 10 * 60_000;
type Dispatch = Pick<WorkerCommandDispatcher, "dispatch">;

export interface JobReconciliationDeps {
  db: DatabaseClient;
  installationToken: (installationId: number) => Promise<string>;
  dispatcher: Dispatch;
  githubFetchForInstallation: (installationId: number) => Fetcher;
  workerConnected?: (workerId: string) => boolean;
  installationBlocked?: (installationId: number) => boolean;
  repositoryFullName?: string;
}
function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function stringArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function nullableString(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function isDispatchableRunStatus(status: string): boolean {
  return status === "queued" || status === "in_progress";
}


export function candidateWorkerFromRow(row: Record<string, unknown>): Candidate["worker"] & { id: string } {
  const rawDoctor = jsonValue(row.doctor ?? row.worker_doctor);
  const doctor = rawDoctor && typeof rawDoctor === "object" && "doctor" in rawDoctor
    ? (rawDoctor as { doctor?: unknown }).doctor
    : rawDoctor;
  const doctorRecord = doctor && typeof doctor === "object" ? doctor as Record<string, unknown> : {};
  const driver = String(row.driver ?? "");
  const poolDigest = String(row.imageDigest ?? row.image_digest ?? "");
  const linuxEvidenceReady = driver !== "linux-libvirt-vm" || (
    doctorRecord.runtimeReady === true &&
    doctorRecord.libvirtReady === true &&
    doctorRecord.networkReady === true &&
    doctorRecord.cloneStorageReady === true &&
    doctorRecord.imageSignatures === true &&
    doctorRecord.realVmSmoke === true &&
    doctorRecord.artifactDigest === poolDigest &&
    doctorRecord.smokeArtifactDigest === poolDigest
  );
  return {
    id: String(row.workerId ?? row.worker_id ?? ""),
    admissionState: String(row.admissionState ?? row.worker_admission_state),
    connectionState: String(row.connectionState ?? row.worker_connection_state),
    configurationState: String(row.configurationState ?? row.worker_configuration_state),
    configurationRevision: nullableString(row.configurationRevision ?? row.worker_configuration_revision),
    appliedConfigurationRevision: nullableString(row.appliedConfigurationRevision ?? row.worker_applied_configuration_revision),
    runtimeReady: doctorRecord.runtimeReady === true,
    linuxEvidenceReady,
    limits: jsonValue(row.limits ?? row.worker_limits),
  };
}

export async function runQueuedJobReconciliation(deps: JobReconciliationDeps): Promise<ReconcileReport> {
  const queuedRows = await deps.db`
    SELECT j.github_job_id AS "jobId", r.id AS "runId", r.repository_id AS "repositoryId",
      r.organization_id AS "organizationId", i.github_installation_id AS "installationId",
      repo.full_name AS repository, j.requested_labels AS labels
    FROM dashboard_jobs j
    JOIN dashboard_runs r ON r.id=j.run_id
    JOIN dashboard_repositories repo ON repo.id=r.repository_id
      AND repo.organization_id=r.organization_id AND repo.available=true
    JOIN dashboard_installations i ON i.id=repo.installation_id
      AND i.organization_id=r.organization_id AND i.state='approved'
    WHERE j.status='queued' AND r.status IN ('queued','in_progress')
      AND NOT EXISTS (
        SELECT 1 FROM runner_leases l
        WHERE l.github_job_id=j.github_job_id
          AND l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')
      )
      AND (${deps.repositoryFullName ?? ""}='' OR repo.full_name=${deps.repositoryFullName ?? ""})
    ORDER BY j.queued_at ASC, j.github_job_id ASC
    FOR UPDATE OF j SKIP LOCKED`;
  if (!queuedRows.length) return { reserved: 0, skipped: 0, failed: 0 };

  const candidateRows = await deps.db`
    SELECT p.id AS "poolId", p.organization_id AS "organizationId", p.worker_id AS "poolWorkerId",
      w.id AS "workerId", p.enabled, p.platform, p.driver, p.image_digest AS "imageDigest", p.resources, p.labels, p.trigger_label AS "triggerLabel",
      w.admission_state AS "admissionState", w.connection_state AS "connectionState", w.configuration_state AS "configurationState",
      w.configuration_revision AS "configurationRevision", w.applied_configuration_revision AS "appliedConfigurationRevision",
      w.limits, w.doctor, w.encryption_public_key AS "encryptionPublicKey",
      (SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.worker_id=w.id
        AND l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')) AS active
    FROM runner_pools p
    JOIN workers w ON (p.worker_id IS NULL OR p.worker_id=w.id) AND p.platform = ANY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(w.guest_platforms)='array' THEN w.guest_platforms ELSE (w.guest_platforms #>> '{}')::jsonb END))
    WHERE p.enabled=true AND w.draining=false`;

  const organizationByJob = new Map<number, string>();
  const githubByInstallation = new Map<number, GithubJobsClient>();
  const workerByPool = new Map<string, { workerId: string; encryptionPublicKey: string; imageDigest: string; guestPlatform: string; driver: RuntimeDriverNameValue; resources: PoolResourcesValue }>();
  const sqlCandidates = candidateRows.map((row) => {
    const resources = PoolResourcesSchema.parse(jsonValue(row.resources));
    const poolId = String(row.poolId);
    const workerId = String(row.workerId);
    const concurrency = Number(resources.concurrency);
    workerByPool.set(`${poolId}:${workerId}`, { workerId, encryptionPublicKey: String(row.encryptionPublicKey ?? ""), imageDigest: String(row.imageDigest), guestPlatform: String(row.platform), driver: RuntimeDriverName.parse(String(row.driver)), resources });
    return {
      requestedLabels: [],
      worker: candidateWorkerFromRow(row),
      pool: { id: poolId, enabled: Boolean(row.enabled), platform: String(row.platform), driver: String(row.driver), resources, concurrency, active: Number(row.active ?? 0), labels: stringArray(row.labels), triggerLabel: row.triggerLabel ? String(row.triggerLabel) : null },
    };
  });
  const connectedCandidates = sqlCandidates.filter((candidate) => !deps.workerConnected || deps.workerConnected(candidate.worker.id)).map((candidate) => ({ ...candidate, worker: { ...candidate.worker, connectionState: "online" } }));
  const candidates = connectedCandidates;
  const reasons = new Map<string, number>();
  const schedulerAdmissible = new Set<string>();
  for (const candidate of sqlCandidates) {
    const connected = !deps.workerConnected || deps.workerConnected(candidate.worker.id);
    for (const queued of queuedRows) {
      const requestedLabels = stringArray(queued.labels);
      const routingReason = connected ? reason({ ...candidate, requestedLabels }) : "worker_offline";
      reasons.set(routingReason, (reasons.get(routingReason) ?? 0) + 1);
      if (routingReason === "admissible") schedulerAdmissible.add(`${candidate.pool.id}:${candidate.worker.id}`);
    }
  }
  console.log(`Routing summary ${JSON.stringify({ queued: queuedRows.length, sqlEligible: sqlCandidates.length, connected: connectedCandidates.length, schedulerAdmissible: schedulerAdmissible.size, reasons: Object.fromEntries(reasons) })}`);

  return reconcileQueuedJobs({
    queued: queuedRows.map((row) => {
      const jobId = Number(row.jobId);
      organizationByJob.set(jobId, String(row.organizationId));
      return { installationId: Number(row.installationId), repositoryId: String(row.repositoryId), repository: String(row.repository), runId: String(row.runId), jobId, labels: stringArray(row.labels) };
    }),
    candidates,
    installationBlocked: deps.installationBlocked,
    reserve: (input) => reserveRoutingSlot(deps.db, { organizationId: organizationByJob.get(input.githubJobId)!, ...input, ttlMs: LEASE_STARTUP_TTL_MS }),
    jit: async (input) => {
      const installationId = input.installationId;
      let client = githubByInstallation.get(installationId);
      if (!client) {
        client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
        githubByInstallation.set(installationId, client);
      }
      return client.generateJitConfig({ owner: input.owner, repo: input.repo, runnerName: input.runnerName, workFolder: "_work", labels: input.labels });
    },
    dispatch: async (reservation, jit) => {
      const target = workerByPool.get(`${reservation.poolId}:${reservation.workerId}`);
      if (!target?.encryptionPublicKey) throw new Error("worker_encryption_key_missing");
      const [dashboardJob] = await deps.db`SELECT id FROM dashboard_jobs WHERE github_job_id=${reservation.jobId ?? -1}`;
      const envelope: LeaseBootstrapEnvelope = { leaseId: reservation.id, jobId: String(dashboardJob?.id ?? reservation.id), nonce: reservation.nonce, guestPlatform: target.guestPlatform as LeaseBootstrapEnvelope["guestPlatform"], encodedJitConfig: jit.encodedJitConfig, expiresAt: reservation.expiresAt, imageDigest: target.imageDigest, resources: reservation.requested };
      await dispatchLeaseBootstrap(deps.dispatcher, { ...envelope, driver: target.driver, workerId: target.workerId, workerEncryptionPublicKey: target.encryptionPublicKey });
      await deps.db`UPDATE runner_leases SET state='dispatched', updated_at=now() WHERE id=${reservation.id} AND state='reserved'`;
    },
    release: async (reservation) => { await deps.db`UPDATE runner_leases SET state='failed', cleanup_state='pending', updated_at=now() WHERE id=${reservation.id} AND state='reserved'`; },
  });
}
