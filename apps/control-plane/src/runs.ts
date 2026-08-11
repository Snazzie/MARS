import type { Sql } from "postgres";
import type { RunStage } from "@whitesmith/contracts";

export type StageTimestamps = { startedAt: string; completedAt?: string | null };
export type WorkflowJobPayload = {
  action?: string;
  installation?: { id?: number };
  repository?: { id?: number; name?: string; full_name?: string; private?: boolean };
  organization?: { id?: number; login?: string };
  sender?: { login?: string };
  workflow_job?: { id?: number; run_id?: number; run_number?: number; name?: string; status?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null; workflow_name?: string; head_branch?: string; head_sha?: string; labels?: string[] };
};

let database: Sql<{}> | undefined;
export function configureRunLifecycle(sql: Sql<{}>): void { database = sql; }
function db(): Sql<{}> { if (!database) throw new Error("run lifecycle database is not configured"); return database; }

const stageFor = (action: string | undefined, status: string | undefined, conclusion: string | null | undefined): RunStage => {
  if (action === "completed" || status === "completed") return conclusion && conclusion !== "success" ? "failed" : "completed";
  if (action === "in_progress" || status === "in_progress") return "running";
  return "queued";
};
export function stageDurationMs(timestamps: StageTimestamps): number {
  const end = timestamps.completedAt ? Date.parse(timestamps.completedAt) : Date.now();
  return Math.max(0, end - Date.parse(timestamps.startedAt));
}

export async function recordRunStage(runId: string, stage: RunStage, timestamps: StageTimestamps): Promise<void> {
  const sql = db();
  await sql`INSERT INTO dashboard_run_stages (organization_id, run_id, stage, started_at, completed_at)
    SELECT organization_id, id, ${stage}, ${timestamps.startedAt}, ${timestamps.completedAt ?? null}
    FROM dashboard_runs WHERE id=${runId}
    ON CONFLICT (organization_id, run_id, stage) DO UPDATE SET
      started_at=LEAST(dashboard_run_stages.started_at, EXCLUDED.started_at),
      completed_at=COALESCE(dashboard_run_stages.completed_at, EXCLUDED.completed_at)`;
}

export async function applyWorkflowJobWebhook(payload: WorkflowJobPayload): Promise<boolean> {
  const sql = db();
  const installationId = payload.installation?.id;
  const repoId = payload.repository?.id;
  const workflowJobId = payload.workflow_job?.id;
  const workflowRunId = payload.workflow_job?.run_id;
  const repo = payload.repository;
  const job = payload.workflow_job;
  if (!installationId || !repoId || !workflowJobId || !workflowRunId || !repo || !job) return false;
  const action = stageFor(payload.action, job.status, job.conclusion);
  const occurred = job.completed_at ?? job.started_at ?? new Date().toISOString();
  const queuedAt = job.started_at ?? occurred;
  const [run] = await sql.begin(async tx => {
    const [installation] = await tx`SELECT id, organization_id FROM dashboard_installations WHERE github_installation_id=${installationId} AND approved=true FOR UPDATE`;
    if (!installation) return [];
    const [repository] = await tx`INSERT INTO dashboard_repositories (organization_id, installation_id, github_repository_id, name, full_name, is_private)
      VALUES (${installation.organization_id},${installation.id},${repoId},${repo.name ?? repo.full_name?.split("/").at(-1) ?? String(repoId)},${repo.full_name ?? String(repoId)},${repo.private ?? false})
      ON CONFLICT (organization_id, github_repository_id) DO UPDATE SET name=EXCLUDED.name, full_name=EXCLUDED.full_name, is_private=EXCLUDED.is_private RETURNING id`;
    const [runRow] = await tx`INSERT INTO dashboard_runs (organization_id, repository_id, github_run_id, run_number, workflow_name, event, branch, commit_sha, actor_login, status, conclusion, queued_at, started_at, completed_at)
      VALUES (${installation.organization_id},${repository.id},${workflowRunId},${job.run_number ?? workflowRunId},${job.workflow_name ?? "workflow"},${payload.action ?? "workflow_job"},${job.head_branch ?? ""},${job.head_sha ?? "0000000"},${payload.sender?.login ?? "github"},${job.status === "completed" ? "completed" : job.status === "in_progress" ? "in_progress" : "queued"},${job.conclusion ?? null},${queuedAt},${job.started_at ?? null},${job.completed_at ?? null})
      ON CONFLICT (organization_id, github_run_id) DO UPDATE SET
        status=CASE WHEN dashboard_runs.status='completed' THEN dashboard_runs.status WHEN EXCLUDED.status='completed' OR (dashboard_runs.status='queued' AND EXCLUDED.status='in_progress') THEN EXCLUDED.status ELSE dashboard_runs.status END,
        conclusion=CASE WHEN dashboard_runs.status='completed' THEN dashboard_runs.conclusion WHEN EXCLUDED.status='completed' THEN EXCLUDED.conclusion ELSE dashboard_runs.conclusion END,
        started_at=COALESCE(dashboard_runs.started_at, EXCLUDED.started_at), completed_at=COALESCE(dashboard_runs.completed_at, EXCLUDED.completed_at)
      RETURNING id, status, conclusion`;
    const [jobRow] = await tx`INSERT INTO dashboard_jobs (organization_id, run_id, github_job_id, name, status, conclusion, stage, runner_name, requested)
      VALUES (${installation.organization_id},${runRow.id},${workflowJobId},${job.name ?? "job"},${job.status === "completed" ? "completed" : job.status === "in_progress" ? "in_progress" : "queued"},${job.conclusion ?? null},${action},NULL,'{"vcpu":1,"memoryBytes":1,"storageBytes":1,"concurrency":1}')
      ON CONFLICT (organization_id, github_job_id) DO UPDATE SET status=EXCLUDED.status, conclusion=CASE WHEN dashboard_jobs.status='completed' THEN dashboard_jobs.conclusion ELSE EXCLUDED.conclusion END, stage=EXCLUDED.stage RETURNING id`;
    await tx`INSERT INTO dashboard_run_stages (organization_id,run_id,stage,started_at,completed_at) VALUES (${installation.organization_id},${runRow.id},${action},${occurred},${job.completed_at ?? null}) ON CONFLICT (organization_id,run_id,stage) DO UPDATE SET completed_at=COALESCE(dashboard_run_stages.completed_at,EXCLUDED.completed_at)`;
    return [{ ...runRow, jobId: jobRow.id }];
  });
  return Boolean(run);
}
