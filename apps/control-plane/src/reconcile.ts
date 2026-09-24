import { randomUUID } from "node:crypto";
import { parseRunnerLabels, PoolResources, type RunnerJitConfig } from "@mars/contracts";
import { selectProvisionOption, fits, type Candidate } from "./scheduler.ts";
import type { LeaseReservation } from "@mars/db";


export type QueuedRoutingJob = {
  organizationId?: string;
  installationId: number;
  repositoryId: string | number;
  repository: string;
  runId: string | number;
  jobId: number;
  labels: string[];
};

const MAX_RUNNER_NAME_LENGTH = 128;
function resolvedRunnerName(workerName: string, workerId: string, platform: string, uniqueId = randomUUID()): string {
  const resolvedPlatform = platform.trim().toLowerCase();
  const suffix = `-${resolvedPlatform}-${uniqueId}`;
  const base = workerName.trim() || workerId;
  return `${base.slice(0, Math.max(1, MAX_RUNNER_NAME_LENGTH - suffix.length))}${suffix}`;
}
export type ReconcileDeps = {
  queued: QueuedRoutingJob[];
  candidates: Array<Candidate & { worker: Candidate["worker"] & { id: string; name?: string }; pool: Candidate["pool"] & { id: string } }>;
  upsert?: (job: QueuedRoutingJob) => Promise<void>;
  installationBlocked?: (installationId: number) => boolean;
  workerConnected?: (workerId: string) => boolean;
  preflight?: (job: QueuedRoutingJob) => Promise<boolean>;
  onDecision?: (job: QueuedRoutingJob, code: string) => void;
  unmatchedReason?: (job: QueuedRoutingJob) => string;
  reserve: (input: { workerId: string; poolId: string; githubJobId: number; routingKey: string; requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number } }) => Promise<LeaseReservation>;
  jit: (input: { installationId: number; owner: string; repo: string; runnerName: string; labels: string[]; githubJobId: number }) => Promise<RunnerJitConfig>;
  dispatch: (reservation: LeaseReservation, jit: RunnerJitConfig) => Promise<void>;
  release?: (reservation: LeaseReservation) => Promise<void>;
  maxConcurrent?: number;
};
export type ReconcileReport = { reserved: number; deferred: number; skipped: number; failed: number };

export async function reconcileQueuedJobs(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { reserved: 0, deferred: 0, skipped: 0, failed: 0 };
  const seen = new Set<number>();
  const reservedByPool = new Map<string, number>();
  const blockedInstallations = new Set<number>();
  const maxConcurrent = Math.max(1, Math.floor(deps.maxConcurrent ?? Math.max(1, ...deps.candidates.map(({ pool }) => {
    const resources = PoolResources.safeParse(pool.resources);
    return resources.success ? resources.data.concurrency : 1;
  }))));
  let nextJob = 0;

  const decide = (job: QueuedRoutingJob, code: string) => deps.onDecision?.(job, code);
  const processJob = async (queued: QueuedRoutingJob): Promise<void> => {
    if (seen.has(queued.jobId)) { report.skipped += 1; decide(queued, "duplicate_job"); return; }
    seen.add(queued.jobId);
    await deps.upsert?.(queued);
    const requestedLabels = queued.labels.map((label) => label.trim()).filter(Boolean);
    const options = parseRunnerLabels(requestedLabels);
    if (!options) { report.skipped += 1; decide(queued, "invalid_provision_labels"); return; }
    if (deps.installationBlocked?.(queued.installationId)) { report.skipped += 1; decide(queued, "installation_cooldown"); return; }
    const candidateOrder = deps.candidates.length > 1
      ? deps.candidates.map((_, index) => deps.candidates[(queued.jobId + index) % deps.candidates.length])
      : deps.candidates;
    const compatible = candidateOrder.flatMap((value) => {
      if (deps.workerConnected && !deps.workerConnected(value.worker.id)) return [];
      const option = selectProvisionOption(options, value.pool);
      if (!option) return [];
      const capacityKey = `${value.pool.id}:${value.worker.id}`;
      const reserved = reservedByPool.get(capacityKey) ?? 0;
      const candidate = { ...value, requestedLabels, pool: { ...value.pool, active: value.pool.active + reserved } };
      return fits(candidate) ? [{ candidate: value, option }] : [];
    });
    if (blockedInstallations.has(queued.installationId)) { report.skipped += 1; decide(queued, "installation_cooldown"); return; }
    if (compatible.length === 0) { report.skipped += 1; decide(queued, deps.unmatchedReason?.(queued) ?? "no_eligible_worker_pool"); return; }
    const [owner, repo] = queued.repository.split("/", 2);
    if (!owner || !repo) { report.failed += 1; decide(queued, "invalid_repository"); return; }
    let capacityRejected = false;
    for (const selected of compatible) {
      const candidate = selected.candidate;
      const option = selected.option;
      const capacityKey = `${candidate.pool.id}:${candidate.worker.id}`;
      reservedByPool.set(capacityKey, (reservedByPool.get(capacityKey) ?? 0) + 1);
      let reservation: LeaseReservation | undefined;
      let jitFailed = false;
      try {
        const poolResources = PoolResources.safeParse(candidate.pool.resources);
        if (!poolResources.success) { report.skipped += 1; decide(queued, "resource_ceiling"); return; }
        const requested = { ...poolResources.data, vcpu: option.vcpu, memoryBytes: option.memoryBytes };
        const claimed = await deps.reserve({
          workerId: candidate.worker.id,
          poolId: candidate.pool.id,
          githubJobId: queued.jobId,
          requested,
          routingKey: `${queued.repository}:${queued.jobId}:${[...new Set(requestedLabels.map((label) => label.toLowerCase()))].sort().join(",")}`,
        });
        reservation = claimed;
        if (deps.preflight && !(await deps.preflight(queued))) {
          report.skipped += 1;
          decide(queued, "github_job_changed");
          await deps.release?.(claimed);
          return;
        }
        const runnerLabels = candidate.pool.platform === "linux-arm64" ? [...requestedLabels, "ubuntu"] : requestedLabels;
        const jit = await deps.jit({ installationId: queued.installationId, owner, repo, runnerName: resolvedRunnerName(candidate.worker.name ?? "", candidate.worker.id, candidate.pool.platform), labels: runnerLabels, githubJobId: queued.jobId }).catch((error) => {
          jitFailed = true;
          throw error;
        });
        await deps.dispatch(claimed, jit);
        report.reserved += 1;
        decide(queued, "dispatched");
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        if (message === "worker_capacity_exhausted" || message === "pool_capacity_exhausted") {
          capacityRejected = true;
        } else {
          console.error(`Reconcile job ${queued.jobId} failed: ${message}`);
          decide(queued, message === "github_rate_limited" ? "github_rate_limited" : jitFailed ? "jit_failed" : "dispatch_failed");
          report.failed += 1;
          if (reservation) {
            if (jitFailed) blockedInstallations.add(queued.installationId);
            await deps.release?.(reservation);
          }
          if (message === "github_rate_limited") blockedInstallations.add(queued.installationId);
          return;
        }
        if (reservation) {
          await deps.release?.(reservation);
          decide(queued, "capacity_exhausted");
          return;
        }
      } finally {
        reservedByPool.set(capacityKey, Math.max(0, (reservedByPool.get(capacityKey) ?? 1) - 1));
      }
    }
    if (capacityRejected) report.deferred += 1;
    if (capacityRejected) decide(queued, "capacity_exhausted");
  };

  const worker = async (): Promise<void> => {
    while (nextJob < deps.queued.length) {
      const queued = deps.queued[nextJob++];
      await processJob(queued);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, deps.queued.length) }, () => worker()));
  return report;
}
