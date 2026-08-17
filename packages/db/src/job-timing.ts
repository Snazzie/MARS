import type { JobTimingSnapshot } from "@whitesmith/contracts";
import type { Sql } from "postgres";

export type JobTimingSnapshotInput = Omit<JobTimingSnapshot, "createdAt"> & { createdAt?: string };
export type JobTimingDb = Sql<{}>;

export async function recordJobTimingSnapshot(db: JobTimingDb, input: JobTimingSnapshotInput): Promise<boolean> {
  const [row] = await db<{ jobId: string }[]>`
    INSERT INTO dashboard_job_timing_snapshots (
      organization_id, job_id, run_id, repository_id, github_job_id,
      repository_name, workflow_name, job_name, platform, driver, runtime_boundary,
      pool_id, artifact_digest, outcome, completed_at, queued_at, started_at,
      queue_duration_ms, startup_duration_ms, execution_duration_ms, cleanup_duration_ms, total_duration_ms,
      requested_vcpu, requested_memory_bytes, requested_storage_bytes, requested_concurrency,
      observed_vcpu, observed_memory_bytes, observed_storage_bytes, effective_concurrency, created_at
    ) VALUES (
      ${input.organizationId}, ${input.jobId}, ${input.runId}, ${input.repositoryId}, ${input.githubJobId},
      ${input.repositoryName}, ${input.workflowName}, ${input.jobName}, ${input.platform}, ${input.driver}, ${input.runtimeBoundary},
      ${input.poolId}, ${input.artifactDigest}, ${input.outcome}, ${input.completedAt}, ${input.queuedAt}, ${input.startedAt},
      ${input.queueDurationMs}, ${input.startupDurationMs}, ${input.executionDurationMs}, ${input.cleanupDurationMs}, ${input.totalDurationMs},
      ${input.requestedVcpu}, ${input.requestedMemoryBytes}, ${input.requestedStorageBytes}, ${input.requestedConcurrency},
      ${input.observedVcpu}, ${input.observedMemoryBytes}, ${input.observedStorageBytes}, ${input.effectiveConcurrency}, ${input.createdAt ?? new Date().toISOString()}
    )
    ON CONFLICT (organization_id, job_id) DO NOTHING
    RETURNING job_id AS "jobId"
  `;
  return Boolean(row);
}
