import { defineQueries, reserveRoutingSlot, schema, type DatabaseClient } from "@mars/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
const queries = defineQueries(db => ({
  livePools: db.select({
    poolId: schema.runnerPools.id, poolName: schema.runnerPools.name, platform: schema.runnerPools.platform, driver: schema.runnerPools.driver, imageDigest: schema.runnerPools.imageDigest,
    enabled: schema.runnerPools.enabled, resources: schema.runnerPools.resources, workerId: schema.workers.id, workerName: schema.workers.name,
    admissionState: schema.workers.admissionState, connectionState: schema.workers.connectionState, configurationState: schema.workers.configurationState,
    configurationRevision: schema.workers.configurationRevision, appliedConfigurationRevision: schema.workers.appliedConfigurationRevision, draining: schema.workers.draining,
    lastHeartbeatAt: schema.workers.lastHeartbeatAt, doctorObservedAt: schema.workers.doctorObservedAt, doctor: schema.workers.doctor,
    active: sql`(select count(*)::int from runner_leases l where l.pool_id=${schema.runnerPools.id} and l.worker_id=${schema.workers.id} and l.state in ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy'))`,
  }).from(schema.runnerPools).leftJoin(schema.workers, and(or(isNull(schema.runnerPools.workerId), eq(schema.runnerPools.workerId, schema.workers.id)), sql`${schema.runnerPools.platform}=any(select jsonb_array_elements_text(case when jsonb_typeof(${schema.workers.guestPlatforms})='array' then ${schema.workers.guestPlatforms} else (${schema.workers.guestPlatforms} #>> '{}')::jsonb end))`, sql`${schema.runnerPools.driver}=${schema.workers.desiredConfiguration}->>'selectedDriver'`))
    .where(sql`${schema.runnerPools.organizationId} is null or ${schema.runnerPools.organizationId} in (select id::uuid from jsonb_array_elements_text(${sql.placeholder("organizationIds")}::jsonb) visible(id))`)
    .orderBy(schema.runnerPools.name, schema.runnerPools.id, schema.workers.name).prepare("job_reconciler_live_pools"),
  queued: db.select({
    jobId: schema.dashboardJobs.githubJobId, runId: schema.dashboardRuns.id, githubRunId: schema.dashboardRuns.githubRunId, runAttempt: schema.dashboardRuns.runAttempt,
    runStatus: schema.dashboardRuns.status, repositoryId: schema.dashboardRuns.repositoryId, organizationId: schema.dashboardRuns.organizationId, installationId: schema.dashboardInstallations.githubInstallationId,
    githubRepositoryId: schema.dashboardRepositories.githubRepositoryId, repository: schema.dashboardRepositories.fullName, jobName: schema.dashboardJobs.name, labels: schema.dashboardJobs.requestedLabels,
    lastFailedWorkerId: sql`case when ${schema.runnerLeases.state}='reaped' and ${schema.runnerLeases.terminalResult}->>'exitCode' is not null and ${schema.runnerLeases.terminalResult}->>'exitCode'<>'0' then ${schema.runnerLeases.workerId} end`,
    leasePreserved: sql`(${schema.runnerLeases.cleanupState}='debug_preserved')`,
  }).from(schema.dashboardJobs).innerJoin(schema.dashboardRuns, eq(schema.dashboardRuns.id, schema.dashboardJobs.runId))
    .innerJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId), eq(schema.dashboardRepositories.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardRepositories.available, true)))
    .innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId), eq(schema.dashboardInstallations.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardInstallations.state, "approved")))
    .leftJoin(schema.runnerLeases, eq(schema.runnerLeases.githubJobId, schema.dashboardJobs.githubJobId))
    .where(and(eq(schema.dashboardJobs.status, "queued"), sql`not exists (select 1 from runner_leases l where l.github_job_id=${schema.dashboardJobs.githubJobId} and (l.state in ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy') or l.cleanup_state in ('pending','failed')))`, or(eq(sql.placeholder("repositoryFullName"), ""), eq(schema.dashboardRepositories.fullName, sql.placeholder("repositoryFullName")))))
    .orderBy(schema.dashboardJobs.queuedAt, schema.dashboardJobs.githubJobId).for("update", { of: schema.dashboardJobs, skipLocked: true }).prepare("job_reconciler_queued"),
  candidateRows: db.select({
    poolId: schema.runnerPools.id, poolName: schema.runnerPools.name, organizationId: schema.runnerPools.organizationId, poolWorkerId: schema.runnerPools.workerId,
    workerId: schema.workers.id, workerName: schema.workers.name, hostPlatform: schema.workers.platform, contractVersion: schema.workers.contractVersion, cpuMode: schema.runnerPools.cpuMode,
    enabled: schema.runnerPools.enabled, platform: schema.runnerPools.platform, driver: schema.runnerPools.driver, imageDigest: schema.runnerPools.imageDigest, resources: schema.runnerPools.resources, labels: schema.runnerPools.labels, triggerLabel: schema.runnerPools.triggerLabel,
    admissionState: schema.workers.admissionState, connectionState: schema.workers.connectionState, configurationState: schema.workers.configurationState, configurationRevision: schema.workers.configurationRevision, appliedConfigurationRevision: schema.workers.appliedConfigurationRevision,
    limits: schema.workers.limits, doctor: schema.workers.doctor, encryptionPublicKey: schema.workers.encryptionPublicKey,
    unreapedLeases: sql`(select count(*)::int from runner_leases l where l.worker_id=${schema.workers.id} and l.state<>'reaped')`,
    modeConflict: sql`exists(select 1 from runner_leases l where l.worker_id=${schema.workers.id} and l.state<>'reaped' and l.cpu_mode<>${schema.runnerPools.cpuMode})`,
    claimedCpuIds: sql`coalesce((select jsonb_agg(cpu.value::int) from runner_leases l cross join lateral jsonb_array_elements_text(coalesce(l.cpu_ids,'[]'::jsonb)) cpu(value) where l.worker_id=${schema.workers.id} and l.state<>'reaped'),'[]'::jsonb)`,
    active: sql`(select count(*)::int from runner_leases l where l.pool_id=${schema.runnerPools.id} and l.worker_id=${schema.workers.id} and l.state in ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy'))`,
  }).from(schema.runnerPools).innerJoin(schema.workers, and(
    or(isNull(schema.runnerPools.workerId), eq(schema.runnerPools.workerId, schema.workers.id)),
    sql`${schema.runnerPools.platform}=any(select jsonb_array_elements_text(case when jsonb_typeof(${schema.workers.guestPlatforms})='array' then ${schema.workers.guestPlatforms} else (${schema.workers.guestPlatforms} #>> '{}')::jsonb end))`,
    sql`${schema.runnerPools.driver}=${schema.workers.desiredConfiguration}->>'selectedDriver'`,
    sql`exists(select 1 from jsonb_array_elements(case when jsonb_typeof(case when jsonb_typeof(${schema.workers.doctor}->'doctor')='object' then ${schema.workers.doctor}->'doctor' else ${schema.workers.doctor} end->'capabilities')='array' then case when jsonb_typeof(${schema.workers.doctor}->'doctor')='object' then ${schema.workers.doctor}->'doctor' else ${schema.workers.doctor} end->'capabilities' else '[]'::jsonb end) capability where capability->>'driver'=${schema.runnerPools.driver} and capability->>'guestPlatform'=${schema.runnerPools.platform} and capability->>'ready'='true')`,
  ))
    .where(and(eq(schema.runnerPools.enabled, true), eq(schema.workers.configurationState, "ready"), eq(schema.workers.configurationRevision, schema.workers.appliedConfigurationRevision), eq(schema.workers.draining, false), sql`${schema.workers.lastHeartbeatAt}>now()-interval '60 seconds'`, sql`${schema.workers.doctorObservedAt}>now()-interval '60 seconds'`)).prepare("job_reconciler_candidates"),
  excludedPools: db.select({ poolId: schema.runnerPools.id, poolName: schema.runnerPools.name, platform: schema.runnerPools.platform, driver: schema.runnerPools.driver, imageDigest: schema.runnerPools.imageDigest, enabled: schema.runnerPools.enabled, labels: schema.runnerPools.labels, triggerLabel: schema.runnerPools.triggerLabel, workerId: schema.workers.id, workerName: schema.workers.name, admissionState: schema.workers.admissionState, connectionState: schema.workers.connectionState, configurationState: schema.workers.configurationState, configurationRevision: schema.workers.configurationRevision, appliedConfigurationRevision: schema.workers.appliedConfigurationRevision, draining: schema.workers.draining, lastHeartbeatAt: schema.workers.lastHeartbeatAt, doctorObservedAt: schema.workers.doctorObservedAt, doctor: schema.workers.doctor })
    .from(schema.runnerPools).leftJoin(schema.workers, and(or(isNull(schema.runnerPools.workerId), eq(schema.runnerPools.workerId, schema.workers.id)), sql`${schema.runnerPools.platform}=any(select jsonb_array_elements_text(case when jsonb_typeof(${schema.workers.guestPlatforms})='array' then ${schema.workers.guestPlatforms} else (${schema.workers.guestPlatforms} #>> '{}')::jsonb end))`, sql`${schema.runnerPools.driver}=${schema.workers.desiredConfiguration}->>'selectedDriver'`))
    .where(sql`${schema.runnerPools.organizationId} is null or ${schema.runnerPools.organizationId}=${sql.placeholder("organizationId")}::uuid`).orderBy(schema.runnerPools.name, schema.runnerPools.id, schema.workers.name).prepare("job_reconciler_excluded_pools"),
  updateLabels: db.update(schema.dashboardJobs).set({ requestedLabels: sql`${sql.placeholder("labels")}::jsonb` }).where(and(eq(schema.dashboardJobs.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobs.githubJobId, sql.placeholder("jobId")), eq(schema.dashboardJobs.runAttempt, sql.placeholder("runAttempt")))).prepare("job_reconciler_labels"),
  recordRunner: db.update(schema.runnerLeases).set({ runnerId: sql`${sql.placeholder("runnerId")}`, runnerName: sql`${sql.placeholder("runnerName")}`, updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.state, "reserved"))).returning({ id: schema.runnerLeases.id }).prepare("job_reconciler_record_runner"),
  jobId: db.select({ id: schema.dashboardJobs.id }).from(schema.dashboardJobs).where(eq(schema.dashboardJobs.githubJobId, sql.placeholder("jobId"))).prepare("job_reconciler_job_id"),
  dispatched: db.update(schema.runnerLeases).set({ state: "dispatched", updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.state, "reserved"))).returning({ id: schema.runnerLeases.id }).prepare("job_reconciler_dispatched"),
  release: db.update(schema.runnerLeases).set({ state: "failed", cleanupState: "pending", updatedAt: sql`now()` }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), inArray(schema.runnerLeases.state, ["reserved", "dispatched"]))).prepare("job_reconciler_release"),
}));
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
  const rows = await queries(db).livePools.execute({ organizationIds: JSON.stringify(organizationIds) });
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
  const queuedRows = await queries(deps.db).queued.execute({ repositoryFullName: deps.repositoryFullName ?? "" });
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
  const candidateRows = await queries(deps.db).candidateRows.execute();
  const excludedPools = new Map<string, Array<DispatchPoolDetail & { labels: string[]; triggerLabel: string | null }>>();
  if (deps.onDecision) {
    for (const organizationId of new Set(queuedRows.map(row => String(row.organizationId)))) {
      const pools = await queries(deps.db).excludedPools.execute({ organizationId });
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
          await queries(deps.db).updateLabels.execute({ labels: JSON.stringify(githubLabels), organizationId: String(row.organizationId), jobId: job.jobId, runAttempt: Number(row.runAttempt) });
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
        const [stored] = await queries(deps.db).recordRunner.execute({ runnerId: jit.runnerId, runnerName: jit.runnerName, leaseId: reservation.id });
        if (!stored) throw new Error("lease_not_reserved");
      }
      const target = workerByPool.get(`${reservation.poolId}:${reservation.workerId}`);
      if (!target?.encryptionPublicKey) throw new Error("worker_encryption_key_missing");
      if (!target.imageDigest) throw new Error("worker_image_missing");
      const [dashboardJob] = await queries(deps.db).jobId.execute({ jobId: reservation.jobId ?? -1 });
      const envelope: LeaseBootstrapEnvelope = { leaseId: reservation.id, jobId: String(dashboardJob?.id ?? reservation.id), nonce: reservation.nonce, guestPlatform: target.guestPlatform as LeaseBootstrapEnvelope["guestPlatform"], contractVersion: deps.contractVersion, encodedJitConfig: jit.encodedJitConfig, expiresAt: reservation.expiresAt, imageDigest: target.imageDigest, resources: reservation.requested, cpuMode: reservation.cpuMode, ...(reservation.cpuIds === null ? {} : { cpuIds: reservation.cpuIds }) };
      const [claimed] = await queries(deps.db).dispatched.execute({ leaseId: reservation.id });
      if (!claimed) throw new Error("lease_not_reserved");
      await dispatchLeaseBootstrap(deps.dispatcher, { ...envelope, driver: target.driver, workerId: target.workerId, workerEncryptionPublicKey: target.encryptionPublicKey });
    },
    release: async (reservation) => { await queries(deps.db).release.execute({ leaseId: reservation.id }); },
  });
  return reconciled;
}
