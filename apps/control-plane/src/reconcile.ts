import { randomUUID } from "node:crypto";
import { parseRunnerLabels, PoolResources, type RunnerJitConfig } from "@mars/contracts";
import { selectProvisionOption, fits, type Candidate } from "./scheduler.ts";
import type { LeaseReservation } from "@mars/db";


export type QueuedRoutingJob = {
  installationId: number;
  repositoryId: string | number;
  repository: string;
  runId: string | number;
  jobId: number;
  labels: string[];
};
export type ReconcileDeps = {
  queued: QueuedRoutingJob[];
  candidates: Array<Candidate & { worker: Candidate["worker"] & { id: string }; pool: Candidate["pool"] & { id: string } }>;
  upsert?: (job: QueuedRoutingJob) => Promise<void>;
  installationBlocked?: (installationId: number) => boolean;
  preflight?: (job: QueuedRoutingJob) => Promise<boolean>;
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

  const processJob = async (queued: QueuedRoutingJob): Promise<void> => {
    if (seen.has(queued.jobId)) { report.skipped += 1; return; }
    seen.add(queued.jobId);
    await deps.upsert?.(queued);
    const requestedLabels = queued.labels.map((label) => label.trim()).filter(Boolean);
    const options = parseRunnerLabels(requestedLabels);
    if (!options) { report.skipped += 1; return; }
    if (deps.installationBlocked?.(queued.installationId)) { report.skipped += 1; return; }
    const candidateOrder = deps.candidates.length > 1
      ? deps.candidates.map((_, index) => deps.candidates[(queued.jobId + index) % deps.candidates.length])
      : deps.candidates;
    const selected = candidateOrder.map((value) => {
      const option = selectProvisionOption(options, value.pool);
      if (!option) return null;
      const capacityKey = `${value.pool.id}:${value.worker.id}`;
      const reserved = reservedByPool.get(capacityKey) ?? 0;
      const candidate = { ...value, requestedLabels, pool: { ...value.pool, active: value.pool.active + reserved } };
      return fits(candidate) ? { candidate: value, option } : null;
    }).find((value): value is { candidate: typeof candidateOrder[number]; option: typeof options[number] } => value !== null);
    if (blockedInstallations.has(queued.installationId)) { report.skipped += 1; return; }
    if (!selected) { report.skipped += 1; return; }
    const candidate = selected.candidate;
    const option = selected.option;
    const [owner, repo] = queued.repository.split("/", 2);
    if (!owner || !repo) { report.failed += 1; return; }
    let reservation: LeaseReservation | undefined;
    let jitFailed = false;
    const capacityKey = `${candidate.pool.id}:${candidate.worker.id}`;
    reservedByPool.set(capacityKey, (reservedByPool.get(capacityKey) ?? 0) + 1);
    try {
      const poolResources = PoolResources.safeParse(candidate.pool.resources);
      if (!poolResources.success) { report.skipped += 1; return; }
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
        await deps.release?.(claimed);
        reservation = undefined;
        return;
      }
      const jit = await deps.jit({ installationId: queued.installationId, owner, repo, runnerName: `mars-${randomUUID()}`, labels: requestedLabels, githubJobId: queued.jobId }).catch((error) => {
        jitFailed = true;
        throw error;
      });
      await deps.dispatch(claimed, jit);
      report.reserved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      if (message === "worker_capacity_exhausted" || message === "pool_capacity_exhausted") {
        report.deferred += 1;
      } else {
        console.error(`Reconcile job ${queued.jobId} failed: ${message}`);
        report.failed += 1;
      }
      if (reservation) {
        if (jitFailed) blockedInstallations.add(queued.installationId);
        await deps.release?.(reservation);
      }
      if (message === "github_rate_limited") blockedInstallations.add(queued.installationId);
    } finally {
      reservedByPool.set(capacityKey, Math.max(0, (reservedByPool.get(capacityKey) ?? 1) - 1));
    }
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
