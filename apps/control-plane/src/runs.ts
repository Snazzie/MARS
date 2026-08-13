import type { Sql } from "postgres";
import type { RunStage } from "@whitesmith/contracts";

export type StageTimestamps = { startedAt: string; completedAt?: string | null };
export type GithubRunSnapshot = { id:number; runNumber:number; workflowName:string; event:string; branch:string; commitSha:string; actorLogin:string; status:"queued"|"in_progress"|"completed"; conclusion:string|null; queuedAt:string; startedAt:string|null; completedAt:string|null };
export type GithubJobSnapshot = { id:number; runId:number; name:string; status:"queued"|"in_progress"|"completed"; conclusion:string|null; labels:string[]; runnerName:string|null; queuedAt:string; startedAt:string|null; completedAt:string|null };
export type WorkflowJobPayload = { action?: string; installation?: { id?: number }; repository?: { id?: number; name?: string; full_name?: string; private?: boolean }; organization?: { id?: number; login?: string }; sender?: { login?: string }; workflow_job?: { id?: number; run_id?: number; run_number?: number; name?: string; status?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null; created_at?: string; runner_name?: string | null; workflow_name?: string; head_branch?: string; head_sha?: string; labels?: string[]; event?: string } };
let database: Sql<{}> | undefined;
export function configureRunLifecycle(sql: Sql<{}>): void { database = sql; }
function db(): Sql<{}> { if (!database) throw new Error("run lifecycle database is not configured"); return database; }
const normalizeRunStatus = (value: string | undefined): GithubRunSnapshot["status"] => value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued";
const normalizeJobStatus = (value: string | undefined): GithubJobSnapshot["status"] => value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued";
const stageFor = (action: string | undefined, status: string | undefined, conclusion: string | null | undefined): RunStage => {
  if (action === "completed" || status === "completed") return conclusion && conclusion !== "success" ? "failed" : "completed";
  if (action === "in_progress" || status === "in_progress") return "running";
  return "queued";
};
export function stageDurationMs(timestamps: StageTimestamps): number { const end = timestamps.completedAt ? Date.parse(timestamps.completedAt) : Date.now(); return Math.max(0, end - Date.parse(timestamps.startedAt)); }
export async function recordRunStage(runId: string, stage: RunStage, timestamps: StageTimestamps): Promise<void> {
  const sql = db();
  await sql`INSERT INTO dashboard_run_stages (organization_id, run_id, stage, started_at, completed_at) SELECT organization_id, id, ${stage}, ${timestamps.startedAt}, ${timestamps.completedAt ?? null} FROM dashboard_runs WHERE id=${runId} ON CONFLICT (organization_id, run_id, stage) DO UPDATE SET started_at=LEAST(dashboard_run_stages.started_at, EXCLUDED.started_at), completed_at=COALESCE(dashboard_run_stages.completed_at, EXCLUDED.completed_at)`;
}
export async function applyGithubJobSnapshot(input: { installationId:number; repository:{id:number;name:string;fullName:string}; run:GithubRunSnapshot; job:GithubJobSnapshot }): Promise<boolean> {
  const sql = db();
  const labels = [...new Set(input.job.labels.map(x => x.trim().toLowerCase()).filter(Boolean))];
  const runStatus = input.run.status, jobStatus = input.job.status, stage = runStatus === "completed" || jobStatus === "completed" ? (input.job.conclusion === "success" ? "completed" : "failed") : jobStatus === "in_progress" ? "running" : "queued";
  const result = await sql.begin(async tx => {
    const [installation] = await tx`SELECT id,organization_id FROM dashboard_installations WHERE github_installation_id=${input.installationId} AND state='approved' FOR UPDATE`;
    if (!installation) return [];
    const [repository] = await tx`SELECT id FROM dashboard_repositories WHERE organization_id=${installation.organization_id} AND installation_id=${installation.id} AND github_repository_id=${input.repository.id} AND available=true AND approved=true`;
    if (!repository) return [];
    const [run] = await tx`INSERT INTO dashboard_runs (organization_id,repository_id,github_run_id,run_number,workflow_name,event,branch,commit_sha,actor_login,status,conclusion,queued_at,started_at,completed_at) VALUES (${installation.organization_id},${repository.id},${input.run.id},${input.run.runNumber},${input.run.workflowName},${input.run.event},${input.run.branch},${input.run.commitSha},${input.run.actorLogin},${runStatus},${input.run.conclusion},${input.run.queuedAt},${input.run.startedAt},${input.run.completedAt}) ON CONFLICT (organization_id,github_run_id) DO UPDATE SET status=CASE WHEN dashboard_runs.status='completed' THEN dashboard_runs.status WHEN EXCLUDED.status='completed' OR (dashboard_runs.status='queued' AND EXCLUDED.status='in_progress') THEN EXCLUDED.status ELSE dashboard_runs.status END, conclusion=CASE WHEN dashboard_runs.status='completed' THEN dashboard_runs.conclusion WHEN EXCLUDED.status='completed' THEN EXCLUDED.conclusion ELSE dashboard_runs.conclusion END, queued_at=LEAST(dashboard_runs.queued_at,EXCLUDED.queued_at), started_at=COALESCE(dashboard_runs.started_at,EXCLUDED.started_at), completed_at=COALESCE(dashboard_runs.completed_at,EXCLUDED.completed_at) RETURNING id`;
    if (!run) return [];
    const [job] = await tx`INSERT INTO dashboard_jobs (organization_id,run_id,github_job_id,name,status,conclusion,stage,runner_name,requested,requested_labels,queued_at,started_at,completed_at) VALUES (${installation.organization_id},${run.id},${input.job.id},${input.job.name},${jobStatus},${input.job.conclusion},${stage},${input.job.runnerName},'{"vcpu":1,"memoryBytes":1,"storageBytes":1,"concurrency":1}'::jsonb,${JSON.stringify(labels)},${input.job.queuedAt},${input.job.startedAt},${input.job.completedAt}) ON CONFLICT (organization_id,github_job_id) DO UPDATE SET status=CASE WHEN dashboard_jobs.status='completed' THEN dashboard_jobs.status WHEN EXCLUDED.status='completed' OR (dashboard_jobs.status='queued' AND EXCLUDED.status='in_progress') THEN EXCLUDED.status ELSE dashboard_jobs.status END, conclusion=CASE WHEN dashboard_jobs.status='completed' THEN dashboard_jobs.conclusion WHEN EXCLUDED.status='completed' THEN EXCLUDED.conclusion ELSE dashboard_jobs.conclusion END, stage=CASE WHEN dashboard_jobs.status='completed' THEN dashboard_jobs.stage ELSE EXCLUDED.stage END, runner_name=COALESCE(EXCLUDED.runner_name,dashboard_jobs.runner_name), requested_labels=EXCLUDED.requested_labels, queued_at=LEAST(dashboard_jobs.queued_at,EXCLUDED.queued_at), started_at=COALESCE(dashboard_jobs.started_at,EXCLUDED.started_at), completed_at=COALESCE(dashboard_jobs.completed_at,EXCLUDED.completed_at) RETURNING id`;
    return job ? [job] : [];
  });
  return result.length > 0;
}
export async function applyWorkflowJobWebhook(payload: WorkflowJobPayload): Promise<boolean> {
  const repo = payload.repository, job = payload.workflow_job, installationId = payload.installation?.id;
  if (!repo?.id || !job?.id || !job.run_id || !installationId) return false;
  const status = normalizeJobStatus(payload.action === "completed" ? "completed" : job.status);
  const run: GithubRunSnapshot = { id: job.run_id, runNumber: job.run_number ?? job.run_id, workflowName: job.workflow_name ?? "workflow", event: job.event ?? payload.action ?? "workflow_job", branch: job.head_branch ?? "", commitSha: job.head_sha ?? "", actorLogin: payload.sender?.login ?? "github", status: normalizeRunStatus(payload.action === "completed" ? "completed" : job.status), conclusion: job.conclusion ?? null, queuedAt: job.created_at ?? job.started_at ?? new Date().toISOString(), startedAt: status === "queued" ? null : job.started_at ?? null, completedAt: status === "completed" ? job.completed_at ?? new Date().toISOString() : null };
  return applyGithubJobSnapshot({ installationId, repository: { id: repo.id, name: repo.name ?? repo.full_name?.split("/").at(-1) ?? "repo", fullName: repo.full_name ?? "" }, run, job: { id: job.id, runId: job.run_id, name: job.name ?? "job", status, conclusion: job.conclusion ?? null, labels: job.labels ?? [], runnerName: job.runner_name ?? null, queuedAt: run.queuedAt, startedAt: run.startedAt, completedAt: run.completedAt } });
}
