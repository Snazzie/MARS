import { randomUUID } from "node:crypto";
import type { RunnerJitConfig } from "@whitesmith/contracts";
import { parseProvisionLabels, resolveProvisionResources, fits, type Candidate } from "./scheduler.ts";
import type { LeaseReservation } from "@whitesmith/db";


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
  reserve: (input: { workerId: string; poolId: string; githubJobId: number; routingKey: string; requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number } }) => Promise<LeaseReservation>;
  jit: (input: { installationId: number; owner: string; repo: string; runnerName: string; labels: string[]; githubJobId: number }) => Promise<RunnerJitConfig>;
  dispatch: (reservation: LeaseReservation, jit: RunnerJitConfig) => Promise<void>;
  release?: (reservation: LeaseReservation) => Promise<void>;
};
export type ReconcileReport = { reserved: number; skipped: number; failed: number };

export async function reconcileQueuedJobs(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { reserved: 0, skipped: 0, failed: 0 };
  const seen = new Set<number>();
  const reservedByPool = new Map<string, number>();
  const blockedInstallations = new Set<number>();
  for (const queued of deps.queued) {
    if (seen.has(queued.jobId)) { report.skipped += 1; continue; }
    seen.add(queued.jobId);
    await deps.upsert?.(queued);
    const requestedLabels = queued.labels.map((label) => label.trim()).filter(Boolean);
    const provision = parseProvisionLabels(requestedLabels);
    if (!provision) { report.skipped += 1; continue; }
    if (deps.installationBlocked?.(queued.installationId)) { report.skipped += 1; continue; }
    const candidateOrder = deps.candidates.length > 1
      ? deps.candidates.map((_, index) => deps.candidates[(queued.jobId + index) % deps.candidates.length])
      : deps.candidates;
    const candidate = candidateOrder.find((value) => {
      const capacityKey = `${value.pool.id}:${value.worker.id}`;
      const reserved = reservedByPool.get(capacityKey) ?? 0;
      return reserved + value.pool.active < value.pool.concurrency && fits({ ...value, requestedLabels });
    });
    if (blockedInstallations.has(queued.installationId)) { report.skipped += 1; continue; }
    if (!candidate) { console.log(`No routing candidate for job ${queued.jobId}: ${requestedLabels.join(",")}`); report.skipped += 1; continue; }
    const [owner, repo] = queued.repository.split("/", 2);
    if (!owner || !repo) { report.failed += 1; continue; }
    let jitFailed = false;
    let reservation: LeaseReservation | undefined;
    try {
      const resources = resolveProvisionResources(candidate.pool.resources, provision);
      if (!resources) { report.skipped += 1; continue; }
      const claimed = await deps.reserve({
        workerId: candidate.worker.id,
        poolId: candidate.pool.id,
        githubJobId: queued.jobId,
        requested: resources,
        routingKey: `${queued.repository}:${queued.jobId}:${requestedLabels.map((label) => label.toLowerCase()).sort().join(",")}`,
      });
      const capacityKey = `${candidate.pool.id}:${candidate.worker.id}`;
      reservedByPool.set(capacityKey, (reservedByPool.get(capacityKey) ?? 0) + 1);
      reservation = claimed;
      let jit: RunnerJitConfig;
      try {
        jit = await deps.jit({ installationId: queued.installationId, owner, repo, runnerName: `whitesmith-${randomUUID()}`, labels: requestedLabels, githubJobId: queued.jobId });
      } catch (error) {
        jitFailed = true;
        throw error;
      }
      await deps.dispatch(claimed, jit);
      report.reserved += 1;
    } catch (error) {
      console.error(`Reconcile job ${queued.jobId} failed: ${error instanceof Error ? error.message : "unknown"}`);
      report.failed += 1;
      if (reservation) {
        const capacityKey = `${candidate.pool.id}:${candidate.worker.id}`;
        if (jitFailed) blockedInstallations.add(queued.installationId);
        reservedByPool.set(capacityKey, Math.max(0, (reservedByPool.get(capacityKey) ?? 1) - 1));
        await deps.release?.(reservation);
      }
    }
  }
  return report;
}
