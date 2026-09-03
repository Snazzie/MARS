import type { Sql } from "@mars/db";
import type { RunStage } from "@mars/contracts";
import { jsonParameter } from "@mars/db";

export type StageTimestamps = { startedAt: string; completedAt?: string | null };
export type GithubStepSnapshot = { id: string | null; number: number; name: string; status: "queued"|"in_progress"|"completed"; conclusion: string|null; queuedAt: string; startedAt: string|null; completedAt: string|null; durationMs: number };
export type GithubRunSnapshot = { id:number; runAttempt:number; runNumber:number; workflowName:string; event:string; branch:string; commitSha:string; actorLogin:string; status:"queued"|"in_progress"|"completed"; conclusion:string|null; queuedAt:string; startedAt:string|null; completedAt:string|null };
export type GithubJobSnapshot = { id:number; runId:number; runAttempt:number; name:string; status:"queued"|"in_progress"|"completed"; conclusion:string|null; labels:string[]; runnerName:string|null; queuedAt:string; startedAt:string|null; completedAt:string|null; steps: GithubStepSnapshot[] };
export type WorkflowJobPayload = { action?: string; installation?: { id?: number }; repository?: { id?: number; name?: string; full_name?: string; private?: boolean }; organization?: { id?: number; login?: string }; sender?: { login?: string }; workflow_job?: { id?: number; run_id?: number; run_attempt?: number; run_number?: number; name?: string; status?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null; created_at?: string; runner_name?: string | null; workflow_name?: string; head_branch?: string; head_sha?: string; labels?: string[]; event?: string; steps?: Array<Record<string, unknown>> } };
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
export async function markGithubJobMissing(sql: Sql<{}>, input: { organizationId: string; githubJobId: number; observedAt: string }): Promise<boolean> {
  return sql.begin(async tx => {
    const [job] = await tx`
      UPDATE dashboard_jobs
      SET status='completed',stage='failed',conclusion=${"cancelled"},completed_at=${input.observedAt}
      WHERE organization_id=${input.organizationId} AND github_job_id=${input.githubJobId} AND status <> 'completed'
      RETURNING id,run_id
    `;
    if (!job) return false;
    await tx`
      SELECT id FROM dashboard_runs
      WHERE organization_id=${input.organizationId} AND id=${job.run_id}
      FOR UPDATE
    `;
    await tx`
      UPDATE dashboard_runs
      SET status='completed',conclusion=${"cancelled"},completed_at=${input.observedAt}
      WHERE organization_id=${input.organizationId} AND id=${job.run_id}
        AND NOT EXISTS (
          SELECT 1 FROM dashboard_jobs
          WHERE organization_id=${input.organizationId} AND run_id=${job.run_id} AND status <> 'completed'
        )
    `;
    return true;
  });
}
export async function applyGithubJobSnapshot(input: { installationId:number; repository:{id:number;name:string;fullName:string}; run:GithubRunSnapshot; job:GithubJobSnapshot; authoritative?: boolean }): Promise<boolean> {
  if (input.run.id !== input.job.runId || input.run.runAttempt !== input.job.runAttempt) throw new Error("github_payload_invalid");
  const sql = db();
  const labels = [...new Set(input.job.labels.map(x => x.trim().toLowerCase()).filter(Boolean))];
  const runStatus = input.run.status, jobStatus = input.job.status, stage = runStatus === "completed" || jobStatus === "completed" ? (input.job.conclusion === "success" ? "completed" : "failed") : jobStatus === "in_progress" ? "running" : "queued";
  const authoritative = input.authoritative === true;
  const result = await sql.begin(async tx => {
    const [installation] = await tx`SELECT id,organization_id FROM dashboard_installations WHERE github_installation_id=${input.installationId} AND state='approved' FOR UPDATE`;
    if (!installation) return [];
    const [repository] = await tx`SELECT id FROM dashboard_repositories WHERE organization_id=${installation.organization_id} AND installation_id=${installation.id} AND github_repository_id=${input.repository.id} AND available=true`;
    if (!repository) return [];
    if (authoritative && runStatus !== "completed") {
      if (runStatus === "queued") {
        await tx`UPDATE dashboard_runs SET status='queued',conclusion=NULL,queued_at=${input.run.queuedAt},started_at=NULL,completed_at=NULL WHERE organization_id=${installation.organization_id} AND github_run_id=${input.run.id} AND run_attempt=${input.run.runAttempt} AND status='completed' AND ${runStatus}='queued'`;
      } else {
        await tx`UPDATE dashboard_runs SET status=${runStatus},conclusion=${input.run.conclusion},queued_at=${input.run.queuedAt},started_at=${input.run.startedAt},completed_at=${input.run.completedAt} WHERE organization_id=${installation.organization_id} AND github_run_id=${input.run.id} AND run_attempt=${input.run.runAttempt} AND status='completed'`;
      }
      if (jobStatus === "queued") {
        await tx`UPDATE dashboard_jobs SET status='queued',conclusion=NULL,stage='queued',queued_at=${input.job.queuedAt},started_at=NULL,completed_at=NULL WHERE organization_id=${installation.organization_id} AND github_job_id=${input.job.id} AND run_attempt=${input.job.runAttempt} AND status='completed' AND ${jobStatus}='queued'`;
      } else {
        await tx`UPDATE dashboard_jobs SET status=${jobStatus},conclusion=${input.job.conclusion},stage=${stage},queued_at=${input.job.queuedAt},started_at=${input.job.startedAt},completed_at=${input.job.completedAt} WHERE organization_id=${installation.organization_id} AND github_job_id=${input.job.id} AND run_attempt=${input.job.runAttempt} AND status='completed'`;
      }
    }
    const [run] = await tx`INSERT INTO dashboard_runs (organization_id,repository_id,github_run_id,run_attempt,run_number,workflow_name,event,branch,commit_sha,actor_login,status,conclusion,queued_at,started_at,completed_at) VALUES (${installation.organization_id},${repository.id},${input.run.id},${input.run.runAttempt},${input.run.runNumber},${input.run.workflowName},${input.run.event},${input.run.branch},${input.run.commitSha},${input.run.actorLogin},${runStatus},${input.run.conclusion},${input.run.queuedAt},${input.run.startedAt},${input.run.completedAt}) ON CONFLICT (organization_id,github_run_id) DO UPDATE SET run_attempt=CASE WHEN EXCLUDED.run_attempt>dashboard_runs.run_attempt THEN EXCLUDED.run_attempt ELSE dashboard_runs.run_attempt END,status=CASE WHEN EXCLUDED.run_attempt>dashboard_runs.run_attempt OR (EXCLUDED.run_attempt=dashboard_runs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.status WHEN dashboard_runs.status='completed' THEN dashboard_runs.status WHEN EXCLUDED.run_attempt=dashboard_runs.run_attempt AND (EXCLUDED.status='completed' OR (dashboard_runs.status='queued' AND EXCLUDED.status='in_progress')) THEN EXCLUDED.status ELSE dashboard_runs.status END,conclusion=CASE WHEN EXCLUDED.run_attempt>dashboard_runs.run_attempt OR (EXCLUDED.run_attempt=dashboard_runs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.conclusion WHEN EXCLUDED.run_attempt=dashboard_runs.run_attempt THEN COALESCE(dashboard_runs.conclusion,EXCLUDED.conclusion) ELSE dashboard_runs.conclusion END,queued_at=CASE WHEN EXCLUDED.run_attempt>dashboard_runs.run_attempt OR (EXCLUDED.run_attempt=dashboard_runs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.queued_at WHEN EXCLUDED.run_attempt=dashboard_runs.run_attempt THEN LEAST(dashboard_runs.queued_at,EXCLUDED.queued_at) ELSE dashboard_runs.queued_at END,started_at=CASE WHEN EXCLUDED.run_attempt>dashboard_runs.run_attempt OR (EXCLUDED.run_attempt=dashboard_runs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.started_at WHEN EXCLUDED.run_attempt=dashboard_runs.run_attempt THEN COALESCE(LEAST(dashboard_runs.started_at,EXCLUDED.started_at),dashboard_runs.started_at,EXCLUDED.started_at) ELSE dashboard_runs.started_at END,completed_at=CASE WHEN EXCLUDED.run_attempt>dashboard_runs.run_attempt OR (EXCLUDED.run_attempt=dashboard_runs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.completed_at WHEN EXCLUDED.run_attempt=dashboard_runs.run_attempt THEN COALESCE(GREATEST(dashboard_runs.completed_at,EXCLUDED.completed_at),dashboard_runs.completed_at,EXCLUDED.completed_at) ELSE dashboard_runs.completed_at END RETURNING id`;
    if (runStatus === "completed") await tx`UPDATE dashboard_jobs SET status='completed',conclusion=COALESCE(conclusion,${input.run.conclusion}),completed_at=COALESCE(completed_at,${input.run.completedAt ?? new Date().toISOString()}) WHERE organization_id=${installation.organization_id} AND run_id=${run.id} AND run_attempt=${input.run.runAttempt} AND status <> 'completed'`;
    const [job] = await tx`INSERT INTO dashboard_jobs (organization_id,run_id,run_attempt,github_job_id,name,status,conclusion,stage,runner_name,requested,requested_labels,queued_at,started_at,completed_at) VALUES (${installation.organization_id},${run.id},${input.job.runAttempt},${input.job.id},${input.job.name},${jobStatus},${input.job.conclusion},${stage},${input.job.runnerName},'{"vcpu":1,"memoryBytes":1,"storageBytes":1,"concurrency":1}'::jsonb,${jsonParameter(tx, labels)}::jsonb,${input.job.queuedAt},${input.job.startedAt},${input.job.completedAt}) ON CONFLICT (organization_id,github_job_id) DO UPDATE SET run_attempt=CASE WHEN EXCLUDED.run_attempt>dashboard_jobs.run_attempt THEN EXCLUDED.run_attempt ELSE dashboard_jobs.run_attempt END,status=CASE WHEN EXCLUDED.run_attempt>dashboard_jobs.run_attempt OR (EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.status WHEN dashboard_jobs.status='completed' THEN dashboard_jobs.status WHEN EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND (EXCLUDED.status='completed' OR (dashboard_jobs.status='queued' AND EXCLUDED.status='in_progress')) THEN EXCLUDED.status ELSE dashboard_jobs.status END,conclusion=CASE WHEN EXCLUDED.run_attempt>dashboard_jobs.run_attempt OR (EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.conclusion WHEN EXCLUDED.run_attempt=dashboard_jobs.run_attempt THEN COALESCE(dashboard_jobs.conclusion,EXCLUDED.conclusion) ELSE dashboard_jobs.conclusion END,stage=CASE WHEN EXCLUDED.run_attempt>dashboard_jobs.run_attempt OR (EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.stage ELSE dashboard_jobs.stage END,runner_name=CASE WHEN EXCLUDED.run_attempt>=dashboard_jobs.run_attempt THEN COALESCE(EXCLUDED.runner_name,dashboard_jobs.runner_name) ELSE dashboard_jobs.runner_name END,queued_at=CASE WHEN EXCLUDED.run_attempt>dashboard_jobs.run_attempt OR (EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.queued_at WHEN EXCLUDED.run_attempt=dashboard_jobs.run_attempt THEN LEAST(dashboard_jobs.queued_at,EXCLUDED.queued_at) ELSE dashboard_jobs.queued_at END,started_at=CASE WHEN EXCLUDED.run_attempt>dashboard_jobs.run_attempt OR (EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.started_at WHEN EXCLUDED.run_attempt=dashboard_jobs.run_attempt THEN COALESCE(LEAST(dashboard_jobs.started_at,EXCLUDED.started_at),dashboard_jobs.started_at,EXCLUDED.started_at) ELSE dashboard_jobs.started_at END,completed_at=CASE WHEN EXCLUDED.run_attempt>dashboard_jobs.run_attempt OR (EXCLUDED.run_attempt=dashboard_jobs.run_attempt AND ${authoritative} AND EXCLUDED.status<>'completed') THEN EXCLUDED.completed_at WHEN EXCLUDED.run_attempt=dashboard_jobs.run_attempt THEN COALESCE(dashboard_jobs.completed_at,EXCLUDED.completed_at) ELSE dashboard_jobs.completed_at END RETURNING id`;
    if (!job) return [];
    for (const step of input.job.steps) {
      const stepId = step.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(step.id) ? step.id : crypto.randomUUID();
      await tx`INSERT INTO dashboard_job_steps (organization_id,run_id,job_id,id,name,number,status,conclusion,queued_at,started_at,completed_at,duration_ms) VALUES (${installation.organization_id},${run.id},${job.id},${stepId},${step.name},${step.number},${step.status},${step.conclusion},${step.queuedAt},${step.startedAt},${step.completedAt},${step.durationMs}) ON CONFLICT (organization_id,run_id,job_id,number) DO UPDATE SET id=CASE WHEN dashboard_job_steps.id !~ '-' THEN EXCLUDED.id ELSE dashboard_job_steps.id END,name=EXCLUDED.name,status=CASE WHEN dashboard_job_steps.status='completed' THEN dashboard_job_steps.status WHEN EXCLUDED.status='completed' OR (dashboard_job_steps.status='queued' AND EXCLUDED.status='in_progress') THEN EXCLUDED.status ELSE dashboard_job_steps.status END,conclusion=COALESCE(dashboard_job_steps.conclusion,EXCLUDED.conclusion),queued_at=LEAST(dashboard_job_steps.queued_at,EXCLUDED.queued_at),started_at=COALESCE(LEAST(dashboard_job_steps.started_at,EXCLUDED.started_at),dashboard_job_steps.started_at,EXCLUDED.started_at),completed_at=COALESCE(dashboard_job_steps.completed_at,EXCLUDED.completed_at),duration_ms=GREATEST(dashboard_job_steps.duration_ms,EXCLUDED.duration_ms)`;
    }
    return [job];
  });
  return result.length > 0;
}
export async function applyWorkflowJobWebhook(payload: WorkflowJobPayload): Promise<boolean> {
  const repo = payload.repository, job = payload.workflow_job, installationId = payload.installation?.id;
  if (!repo?.id || !job?.id || !job.run_id || !installationId) return false;
  if (typeof job.run_attempt !== "number" || !Number.isSafeInteger(job.run_attempt) || job.run_attempt <= 0) throw new Error("github_payload_invalid");
  const status = normalizeJobStatus(payload.action === "completed" ? "completed" : job.status);
  const runStatus = status === "queued" ? "queued" : "in_progress";
  const queuedAt = job.created_at ?? job.started_at ?? new Date().toISOString();
  const run: GithubRunSnapshot = {
    id: job.run_id,
    runAttempt: job.run_attempt,
    runNumber: job.run_number ?? job.run_id,
    workflowName: job.workflow_name ?? "workflow",
    event: job.event ?? payload.action ?? "workflow_job",
    branch: job.head_branch ?? "",
    commitSha: job.head_sha ?? "",
    actorLogin: payload.sender?.login ?? "github",
    status: runStatus,
    conclusion: null,
    queuedAt,
    startedAt: runStatus === "queued" ? null : job.started_at ?? null,
    completedAt: null,
  };
  if (job.steps !== undefined && !Array.isArray(job.steps)) throw new Error("github_payload_invalid");
  if (job.steps !== undefined && job.steps.some(step => !step || typeof step !== "object")) throw new Error("github_payload_invalid");
  const steps: GithubStepSnapshot[] = (job.steps ?? []).map(step => {
    if (typeof step.number !== "number" || !Number.isSafeInteger(step.number) || step.number <= 0) throw new Error("github_payload_invalid");
    const number = step.number;
    const raw = step.status;
    const normalized = raw === "queued" || raw === "requested" || raw === "waiting" || raw === "pending" ? "queued" : raw === "in_progress" ? "in_progress" : raw === "completed" ? "completed" : null;
    if (!normalized) throw new Error("github_payload_invalid");
    const startedAt = normalized === "queued" ? null : typeof step.started_at === "string" ? step.started_at : null;
    const completedAt = normalized === "completed" ? typeof step.completed_at === "string" ? step.completed_at : null : null;
    const startMs = startedAt ? Date.parse(startedAt) : NaN, endMs = completedAt ? Date.parse(completedAt) : NaN;
    return { id: step.id === undefined || step.id === null ? null : String(step.id), number, name: typeof step.name === "string" ? step.name : `step-${number}`, status: normalized, conclusion: typeof step.conclusion === "string" ? step.conclusion : null, queuedAt: typeof step.created_at === "string" ? step.created_at : queuedAt, startedAt, completedAt, durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0 };
  });
  return applyGithubJobSnapshot({
    installationId,
    repository: { id: repo.id, name: repo.name ?? repo.full_name?.split("/").at(-1) ?? "repo", fullName: repo.full_name ?? "" },
    run,
    job: { id: job.id, runId: job.run_id, runAttempt: job.run_attempt, name: job.name ?? "job", status, conclusion: job.conclusion ?? null, labels: job.labels ?? [], runnerName: job.runner_name ?? null, queuedAt, startedAt: status === "queued" ? null : job.started_at ?? null, completedAt: status === "completed" ? job.completed_at ?? null : null, steps },
  });
}
