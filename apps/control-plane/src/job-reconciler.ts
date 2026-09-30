import type { DatabaseClient } from "@mars/db";
import { jsonParameter, reserveRoutingSlot } from "@mars/db";
import { PoolResources as PoolResourcesSchema, RuntimeDriverName, parseJobRunnerLabels, type PoolResources as PoolResourcesValue, type RuntimeDriverName as RuntimeDriverNameValue, type RunnerJitConfig, type LeaseBootstrapEnvelope } from "@mars/contracts";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";
import { GithubJobsClient } from "./github-jobs.ts";
import { dispatchLeaseBootstrap } from "./lease-dispatch.ts";
import { isGithubRateLimitError } from "./github-rate-limit.ts";
import { reconcileQueuedJobs, type ReconcileReport } from "./reconcile.ts";
import { reason, selectProvisionOption, type Candidate } from "./scheduler.ts";
import type { DispatchPoolDetail } from "./dispatch-health.ts";
import { applyGithubJobSnapshot, markGithubJobMissing, type GithubJobSnapshot } from "./runs.ts";
import { storedWorkerDoctor, workerPoolEvidence } from "./worker-evidence.ts";
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const LEASE_STARTUP_TTL_MS = 10 * 60_000;
type Dispatch = { dispatch(input: { workerId: string; leaseId: string; type: string; payload: Record<string, unknown> }): Promise<unknown> };

export interface JobReconciliationDeps {
  db: DatabaseClient;
  installationToken: (installationId: number) => Promise<string>;
  dispatcher: Dispatch;
  githubFetchForInstallation: (installationId: number) => Fetcher;
  contractVersion: string;
  workerConnected?: (workerId: string) => boolean;
  installationBlocked?: (installationId: number) => boolean;
  onDecision?: (decision: { organizationId: string; jobId: number; code: string; labels?: string[]; repository?: string; githubRunId?: string; jobName?: string }) => void;
  onQueueSize?: (queued: number) => void;
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
export function candidateWorkerFromRow(row: Record<string, unknown>): Candidate["worker"] & { id: string; name?: string } {
  const doctorRecord = storedWorkerDoctor(jsonValue(row.doctor ?? row.worker_doctor));
  const driver = String(row.driver ?? "");
  const evidence = workerPoolEvidence(doctorRecord, driver, String(row.platform ?? ""));
  return {
    id: String(row.workerId ?? row.worker_id ?? ""),
    name: String(row.workerName ?? row.worker_name ?? ""),
    admissionState: String(row.admissionState ?? row.worker_admission_state),
    connectionState: String(row.connectionState ?? row.worker_connection_state),
    configurationState: String(row.configurationState ?? row.worker_configuration_state),
    configurationRevision: nullableString(row.configurationRevision ?? row.worker_configuration_revision),
    appliedConfigurationRevision: nullableString(row.appliedConfigurationRevision ?? row.worker_applied_configuration_revision),
    runtimeReady: evidence.ready,
    acceptingLeases: doctorRecord.acceptingLeases !== false,
    hostPlatform: String(row.hostPlatform ?? ""),
    contractVersion: nullableString(row.contractVersion),
    availableCpuIds: Array.isArray(doctorRecord.availableCpuIds) ? doctorRecord.availableCpuIds : undefined,
    claimedCpuIds: Array.isArray(jsonValue(row.claimedCpuIds)) ? jsonValue(row.claimedCpuIds) as number[] : [],
    unreapedLeases: Number(row.unreapedLeases ?? 0),
    modeConflict: row.modeConflict === true,
    limits: jsonValue(row.limits ?? row.worker_limits),
  };
}

export function excludedPoolReason(row: Record<string, unknown>, now = Date.now()): string {
  if (row.enabled === false) return "pool_disabled";
  if (!row.workerId) return "no_configured_worker_for_pool";
  if (row.admissionState !== "adopted") return "worker_not_adopted";
  if (row.draining === true) return "worker_draining";
  if (row.configurationState !== "ready" || row.configurationRevision !== row.appliedConfigurationRevision) return "worker_config_applying";
  if (row.connectionState !== "online" || !row.lastHeartbeatAt || now - new Date(String(row.lastHeartbeatAt)).getTime() >= 60_000) return "worker_offline";
  if (!row.doctorObservedAt || now - new Date(String(row.doctorObservedAt)).getTime() >= 60_000) return "worker_doctor_stale";
  const doctor = storedWorkerDoctor(jsonValue(row.doctor));
  const evidence = workerPoolEvidence(doctor, String(row.driver), String(row.platform));
  if (!evidence.ready) return "worker_runtime_not_ready";
  if (doctor.acceptingLeases === false) return "worker_pickup_paused";
  return "admissible";
}

export async function getLiveDispatchPools(db: DatabaseClient, organizationIds: readonly string[], workerConnected?: (workerId: string) => boolean): Promise<DispatchPoolDetail[]> {
  const rows = await db`
    SELECT p.id AS "poolId", p.name AS "poolName", p.platform, p.driver, p.image_digest AS "imageDigest",
      p.enabled, p.resources, w.id AS "workerId", w.name AS "workerName",
      w.admission_state AS "admissionState", w.connection_state AS "connectionState",
      w.configuration_state AS "configurationState", w.configuration_revision AS "configurationRevision",
      w.applied_configuration_revision AS "appliedConfigurationRevision", w.draining,
      w.last_heartbeat_at AS "lastHeartbeatAt", w.doctor_observed_at AS "doctorObservedAt", w.doctor,
      (SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.worker_id=w.id
        AND l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')) AS active
    FROM runner_pools p
    LEFT JOIN workers w ON (p.worker_id IS NULL OR p.worker_id=w.id)
      AND p.platform = ANY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(w.guest_platforms)='array' THEN w.guest_platforms ELSE (w.guest_platforms #>> '{}')::jsonb END))
      AND p.driver=w.desired_configuration->>'selectedDriver'
    WHERE p.organization_id IS NULL OR p.organization_id IN (SELECT id::uuid FROM jsonb_array_elements_text(${JSON.stringify(organizationIds)}::jsonb) AS visible(id))
    ORDER BY p.name,p.id,w.name`;
  const now = Date.now();
  return rows.map(row => {
    const workerId = row.workerId ? String(row.workerId) : null;
    let reason = excludedPoolReason(row, now);
    if (reason === "admissible" && workerId && workerConnected && !workerConnected(workerId)) reason = "worker_offline";
    const resources = PoolResourcesSchema.safeParse(jsonValue(row.resources));
    if (reason === "admissible" && (!resources.success || Number(row.active) >= resources.data.concurrency)) reason = "pool_concurrency";
    return {
      poolId: String(row.poolId), poolName: String(row.poolName), platform: String(row.platform),
      ...(workerId ? { workerId, workerName: String(row.workerName ?? "") } : {}), reason,
    };
  });
}

export async function runQueuedJobReconciliation(deps: JobReconciliationDeps): Promise<ReconcileReport> {
  const queuedRows = await deps.db`
    SELECT j.github_job_id AS "jobId", r.id AS "runId", r.github_run_id AS "githubRunId", r.run_attempt AS "runAttempt",
      r.status AS "runStatus", r.repository_id AS "repositoryId", r.organization_id AS "organizationId", i.github_installation_id AS "installationId",
      repo.github_repository_id AS "githubRepositoryId", repo.full_name AS repository, j.name AS "jobName", j.requested_labels AS labels,
      CASE WHEN prior.state='reaped' AND prior.terminal_result->>'exitCode' IS NOT NULL
        AND prior.terminal_result->>'exitCode' <> '0' THEN prior.worker_id END AS "lastFailedWorkerId",
      (prior.cleanup_state='debug_preserved') AS "leasePreserved"
    FROM dashboard_jobs j
    JOIN dashboard_runs r ON r.id=j.run_id
    JOIN dashboard_repositories repo ON repo.id=r.repository_id
      AND repo.organization_id=r.organization_id AND repo.available=true
    JOIN dashboard_installations i ON i.id=repo.installation_id
      AND i.organization_id=r.organization_id AND i.state='approved'
    LEFT JOIN runner_leases prior ON prior.github_job_id=j.github_job_id
    WHERE j.status='queued'
      AND NOT EXISTS (
        SELECT 1 FROM runner_leases l
        WHERE l.github_job_id=j.github_job_id
          AND (l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')
            OR l.cleanup_state IN ('pending','failed'))
      )
      AND (${deps.repositoryFullName ?? ""}='' OR repo.full_name=${deps.repositoryFullName ?? ""})
    ORDER BY j.queued_at ASC, j.github_job_id ASC
    FOR UPDATE OF j SKIP LOCKED`;
  deps.onQueueSize?.(queuedRows.length);
  if (!queuedRows.length) return { reserved: 0, deferred: 0, skipped: 0, failed: 0 };

  const queuedByJob = new Map<number, typeof queuedRows[number]>();
  for (const row of queuedRows) queuedByJob.set(Number(row.jobId), row);
  const githubByInstallation = new Map<number, GithubJobsClient>();
  const clientForInstallation = (installationId: number): GithubJobsClient => {
    let client = githubByInstallation.get(installationId);
    if (!client) {
      client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
      githubByInstallation.set(installationId, client);
    }
    return client;
  };
  const blockedInstallations = new Set<number>();
  const candidateRows = await deps.db`
    SELECT p.id AS "poolId", p.name AS "poolName", p.organization_id AS "organizationId", p.worker_id AS "poolWorkerId",
      w.id AS "workerId", w.name AS "workerName", w.platform AS "hostPlatform", w.contract_version AS "contractVersion", p.cpu_mode AS "cpuMode", p.enabled, p.platform, p.driver, p.image_digest AS "imageDigest", p.resources, p.labels, p.trigger_label AS "triggerLabel",
      w.admission_state AS "admissionState", w.connection_state AS "connectionState", w.configuration_state AS "configurationState",
      w.configuration_revision AS "configurationRevision", w.applied_configuration_revision AS "appliedConfigurationRevision",
      w.limits, w.doctor, w.encryption_public_key AS "encryptionPublicKey",
      (SELECT count(*)::int FROM runner_leases l WHERE l.worker_id=w.id AND l.state <> 'reaped') AS "unreapedLeases",
      EXISTS (SELECT 1 FROM runner_leases l WHERE l.worker_id=w.id AND l.state <> 'reaped' AND l.cpu_mode <> p.cpu_mode) AS "modeConflict",
      COALESCE((SELECT jsonb_agg(cpu.value::int) FROM runner_leases l CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(l.cpu_ids,'[]'::jsonb)) AS cpu(value) WHERE l.worker_id=w.id AND l.state <> 'reaped'), '[]'::jsonb) AS "claimedCpuIds",
      (SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.worker_id=w.id
        AND l.state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')) AS active
    FROM runner_pools p
    JOIN workers w ON (p.worker_id IS NULL OR p.worker_id=w.id) AND p.platform = ANY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(w.guest_platforms)='array' THEN w.guest_platforms ELSE (w.guest_platforms #>> '{}')::jsonb END))
      AND p.driver = w.desired_configuration->>'selectedDriver'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(CASE WHEN jsonb_typeof(w.doctor->'doctor')='object' THEN w.doctor->'doctor' ELSE w.doctor END->'capabilities')='array' THEN CASE WHEN jsonb_typeof(w.doctor->'doctor')='object' THEN w.doctor->'doctor' ELSE w.doctor END->'capabilities' ELSE '[]'::jsonb END) capability WHERE capability->>'driver'=p.driver AND capability->>'guestPlatform'=p.platform AND capability->>'ready'='true')
    WHERE p.enabled=true AND w.configuration_state='ready' AND w.configuration_revision=w.applied_configuration_revision AND w.draining=false
      AND w.last_heartbeat_at > now()-interval '60 seconds'
      AND w.doctor_observed_at > now()-interval '60 seconds'`;
  const excludedPools = new Map<string, Array<DispatchPoolDetail & { labels: string[]; triggerLabel: string | null }>>();
  if (deps.onDecision) {
    for (const organizationId of new Set(queuedRows.map(row => String(row.organizationId)))) {
      const pools = await deps.db`
        SELECT p.id AS "poolId", p.name AS "poolName", p.platform, p.driver, p.image_digest AS "imageDigest", p.enabled, p.labels, p.trigger_label AS "triggerLabel",
          w.id AS "workerId", w.name AS "workerName", w.admission_state AS "admissionState",
          w.connection_state AS "connectionState", w.configuration_state AS "configurationState",
          w.configuration_revision AS "configurationRevision", w.applied_configuration_revision AS "appliedConfigurationRevision",
          w.draining, w.last_heartbeat_at AS "lastHeartbeatAt", w.doctor_observed_at AS "doctorObservedAt", w.doctor
        FROM runner_pools p
        LEFT JOIN workers w ON (p.worker_id IS NULL OR p.worker_id=w.id)
          AND p.platform = ANY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(w.guest_platforms)='array' THEN w.guest_platforms ELSE (w.guest_platforms #>> '{}')::jsonb END))
          AND p.driver = w.desired_configuration->>'selectedDriver'
        WHERE p.organization_id IS NULL OR p.organization_id=${organizationId}::uuid
        ORDER BY p.name, p.id, w.name`;
      excludedPools.set(organizationId, pools
        .filter(pool => !candidateRows.some(row => String(row.poolId) === String(pool.poolId) && String(row.workerId) === String(pool.workerId)))
        .map(pool => ({
          poolId: String(pool.poolId), poolName: String(pool.poolName), platform: String(pool.platform),
          ...(pool.workerId ? { workerId: String(pool.workerId), workerName: String(pool.workerName ?? "") } : {}),
          reason: excludedPoolReason(pool),
          labels: stringArray(pool.labels), triggerLabel: pool.triggerLabel ? String(pool.triggerLabel) : null,
        })));
    }
  }

  const workerByPool = new Map<string, { workerId: string; encryptionPublicKey: string; imageDigest: string | null; guestPlatform: string; driver: RuntimeDriverNameValue; resources: PoolResourcesValue }>();
  const sqlCandidates = candidateRows.map((row) => {
    const resources = PoolResourcesSchema.parse(jsonValue(row.resources));
    const poolId = String(row.poolId);
    const workerId = String(row.workerId);
    const concurrency = Number(resources.concurrency);
    const evidence = workerPoolEvidence(row.doctor, String(row.driver), String(row.platform));
    workerByPool.set(`${poolId}:${workerId}`, { workerId, encryptionPublicKey: String(row.encryptionPublicKey ?? ""), imageDigest: evidence.imageDigest, guestPlatform: String(row.platform), driver: RuntimeDriverName.parse(String(row.driver)), resources });
    return {
      organizationId: row.organizationId == null ? null : String(row.organizationId),
      poolName: String(row.poolName ?? ""),
      requestedLabels: [],
      worker: candidateWorkerFromRow(row),
      pool: { id: poolId, enabled: Boolean(row.enabled), platform: String(row.platform), driver: String(row.driver), resources, cpuMode: row.cpuMode === "exclusive" ? "exclusive" as const : "shared" as const, concurrency, active: Number(row.active ?? 0), labels: stringArray(row.labels), triggerLabel: row.triggerLabel ? String(row.triggerLabel) : null },
    };
  });
  const candidates = sqlCandidates
    .filter((candidate) => !deps.workerConnected || deps.workerConnected(candidate.worker.id))
    .map((candidate) => ({ ...candidate, worker: { ...candidate.worker, connectionState: "online" } }));

  const poolDetails = (job: { organizationId?: string; labels: string[] }): DispatchPoolDetail[] => [
    ...sqlCandidates
      .filter(candidate => candidate.organizationId === null || candidate.organizationId === job.organizationId)
      .map(candidate => ({
        poolId: candidate.pool.id, poolName: candidate.poolName, platform: candidate.pool.platform,
        workerId: candidate.worker.id, workerName: candidate.worker.name,
        reason: reason({
          ...candidate, requestedLabels: job.labels,
          worker: { ...candidate.worker, connectionState: deps.workerConnected && !deps.workerConnected(candidate.worker.id) ? "offline" : candidate.worker.connectionState },
        }),
      })),
    ...(excludedPools.get(job.organizationId ?? "") ?? []).map(({ labels: _labels, triggerLabel: _triggerLabel, ...pool }) => pool),
  ];
  const normalizedLabels = (labels: readonly string[]) => [...new Set(labels.map((label) => label.trim().toLowerCase()).filter(Boolean))].sort();
  const reconciled = await reconcileQueuedJobs({
    queued: queuedRows.map((row) => ({
      organizationId: String(row.organizationId),
      installationId: Number(row.installationId),
      repositoryId: String(row.repositoryId),
      repository: String(row.repository),
      runId: String(row.runId),
      jobId: Number(row.jobId),
      labels: stringArray(row.labels),
      leasePreserved: row.leasePreserved === true,
      lastFailedWorkerId: row.lastFailedWorkerId ? String(row.lastFailedWorkerId) : undefined,
    })),
    candidates,
    onDecision: (job, code) => {
      const row = queuedByJob.get(job.jobId);
      deps.onDecision?.({ organizationId: job.organizationId ?? "", jobId: job.jobId, code, ...(code !== "dispatched" ? { labels: job.labels, pools: poolDetails(job), ...(row?.githubRunId && row?.jobName ? { repository: job.repository, githubRunId: String(row.githubRunId), jobName: String(row.jobName) } : {}) } : {}) });
    },
    unmatchedReason: (job) => {
      if (sqlCandidates.length === 0) return "no_eligible_worker_pool";
      const reasons = sqlCandidates.map(candidate => reason({
        ...candidate,
        requestedLabels: job.labels,
        worker: { ...candidate.worker, connectionState: deps.workerConnected && !deps.workerConnected(candidate.worker.id) ? "offline" : candidate.worker.connectionState },
      }));
      const options = parseJobRunnerLabels(job.labels)?.options;
      if (options && (excludedPools.get(job.organizationId ?? "") ?? []).some(pool => selectProvisionOption(options, pool))) return "no_eligible_worker_pool";
      return reasons.find(code => code !== "no_matching_labels" && code !== "admissible") ?? (reasons.includes("admissible") ? "pool_concurrency" : "no_matching_labels");
    },
    workerConnected: deps.workerConnected,
    installationBlocked: (installationId) => blockedInstallations.has(installationId) || Boolean(deps.installationBlocked?.(installationId)),
    preflight: async (job) => {
      const row = queuedByJob.get(job.jobId);
      if (!row) throw new Error("queued_job_missing");
      const [owner, repo] = String(row.repository).split("/", 2);
      if (!owner || !repo) throw new Error("github_repository_invalid");
      const installationId = Number(row.installationId);
      const client = clientForInstallation(installationId);
      let githubJob: GithubJobSnapshot;
      try {
        githubJob = await client.getJob(owner, repo, job.jobId);
      } catch (error) {
        if (isGithubRateLimitError(error)) {
          blockedInstallations.add(installationId);
          throw error;
        }
        const message = error instanceof Error ? error.message : "unknown";
        if (message === "github_404" || message === "github_410") {
          await markGithubJobMissing(deps.db, { organizationId: String(row.organizationId), githubJobId: job.jobId, observedAt: new Date().toISOString() });
          return false;
        }
        throw error;
      }
      if (githubJob.id !== job.jobId || githubJob.runId !== Number(row.githubRunId) || githubJob.runAttempt !== Number(row.runAttempt)) throw new Error("github_payload_invalid");
      if (row.runStatus === "completed" && githubJob.status === "queued") {
        const run = await client.getRunAttempt(owner, repo, githubJob.runId, githubJob.runAttempt);
        await applyGithubJobSnapshot({
          installationId,
          repository: { id: Number(row.githubRepositoryId), name: repo, fullName: String(row.repository) },
          run,
          job: githubJob,
          authoritative: true,
        });
        if (run.status === "completed") return false;
      }
      if (githubJob.status === "queued") {
        const githubLabels = normalizedLabels(githubJob.labels);
        const requestedLabels = normalizedLabels(stringArray(row.labels));
        if (githubLabels.length !== requestedLabels.length || githubLabels.some((label, index) => label !== requestedLabels[index])) {
          await deps.db`UPDATE dashboard_jobs SET requested_labels=${jsonParameter(deps.db, githubLabels)}::jsonb WHERE organization_id=${String(row.organizationId)} AND github_job_id=${job.jobId} AND run_attempt=${Number(row.runAttempt)}`;
          return false;
        }
        return true;
      }
      try {
        const run = await client.getRunAttempt(owner, repo, githubJob.runId, githubJob.runAttempt);
        await applyGithubJobSnapshot({
          installationId,
          repository: { id: Number(row.githubRepositoryId), name: repo, fullName: String(row.repository) },
          run,
          job: githubJob,
          authoritative: true,
        });
      } catch (error) {
        if (isGithubRateLimitError(error)) blockedInstallations.add(installationId);
        throw error;
      }
      return false;
    },
    reserve: (input) => reserveRoutingSlot(deps.db, { organizationId: String(queuedByJob.get(input.githubJobId)?.organizationId ?? ""), ...input, ttlMs: LEASE_STARTUP_TTL_MS }),
    jit: async (input) => {
      const client = clientForInstallation(input.installationId);
      return client.generateJitConfig({ owner: input.owner, repo: input.repo, runnerName: input.runnerName, workFolder: "_work", labels: input.labels });
    },
    dispatch: async (reservation, jit) => {
      if (jit.runnerId !== undefined) {
        const [stored] = await deps.db`UPDATE runner_leases SET runner_id=${jit.runnerId}, runner_name=${jit.runnerName}, updated_at=now() WHERE id=${reservation.id} AND state='reserved' RETURNING id`;
        if (!stored) throw new Error("lease_not_reserved");
      }
      const target = workerByPool.get(`${reservation.poolId}:${reservation.workerId}`);
      if (!target?.encryptionPublicKey) throw new Error("worker_encryption_key_missing");
      if (!target.imageDigest) throw new Error("worker_image_missing");
      const [dashboardJob] = await deps.db`SELECT id FROM dashboard_jobs WHERE github_job_id=${reservation.jobId ?? -1}`;
      const envelope: LeaseBootstrapEnvelope = { leaseId: reservation.id, jobId: String(dashboardJob?.id ?? reservation.id), nonce: reservation.nonce, guestPlatform: target.guestPlatform as LeaseBootstrapEnvelope["guestPlatform"], contractVersion: deps.contractVersion, encodedJitConfig: jit.encodedJitConfig, expiresAt: reservation.expiresAt, imageDigest: target.imageDigest, resources: reservation.requested, cpuMode: reservation.cpuMode, ...(reservation.cpuIds === null ? {} : { cpuIds: reservation.cpuIds }) };
      const [claimed] = await deps.db`UPDATE runner_leases SET state='dispatched', updated_at=now() WHERE id=${reservation.id} AND state='reserved' RETURNING id`;
      if (!claimed) throw new Error("lease_not_reserved");
      await dispatchLeaseBootstrap(deps.dispatcher, { ...envelope, driver: target.driver, workerId: target.workerId, workerEncryptionPublicKey: target.encryptionPublicKey });
    },
    release: async (reservation) => { await deps.db`UPDATE runner_leases SET state='failed', cleanup_state='pending', updated_at=now() WHERE id=${reservation.id} AND state IN ('reserved','dispatched')`; },
  });
  return reconciled;
}
