import { and, eq, lt, ne, notExists, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import type { RunStage } from "@mars/contracts";
export type StageTimestamps = { startedAt: string; completedAt?: string | null };
export type GithubStepSnapshot = { id: string | null; number: number; name: string; status: "queued"|"in_progress"|"completed"; conclusion: string|null; queuedAt: string; startedAt: string|null; completedAt: string|null; durationMs: number };
export type GithubRunSnapshot = { id:number; runAttempt:number; runNumber:number; workflowName:string; workflowPath?:string|null; event:string; branch:string; commitSha:string; actorLogin:string; status:"queued"|"in_progress"|"completed"; conclusion:string|null; queuedAt:string; startedAt:string|null; completedAt:string|null };
export type GithubJobSnapshot = { id:number; runId:number; runAttempt:number; name:string; status:"queued"|"in_progress"|"completed"; conclusion:string|null; labels:string[]; runnerName:string|null; queuedAt:string; startedAt:string|null; completedAt:string|null; steps: GithubStepSnapshot[] };
export type WorkflowJobPayload = { action?: string; installation?: { id?: number }; repository?: { id?: number; name?: string; full_name?: string; private?: boolean }; organization?: { id?: number; login?: string }; sender?: { login?: string }; workflow_job?: { id?: number; run_id?: number; run_attempt?: number; run_number?: number; name?: string; status?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null; created_at?: string; runner_name?: string | null; workflow_name?: string; head_branch?: string; head_sha?: string; labels?: string[]; event?: string; steps?: Array<Record<string, unknown>> } };
import { enqueuePipelineFailureAnalysis } from "./pipeline-failure-analysis.ts";
let database: DatabaseClient | undefined;
export function configureRunLifecycle(sql: DatabaseClient): void { database = sql; }
function db(): DatabaseClient { if (!database) throw new Error("run lifecycle database is not configured"); return database; }
const queries = defineQueries(db => {
  const replacedRun = sql`(excluded.run_attempt > ${schema.dashboardRuns.runAttempt} OR (excluded.run_attempt = ${schema.dashboardRuns.runAttempt} AND ${sql.placeholder("authoritative")} AND excluded.status <> 'completed'))`;
  const replacedJob = sql`(excluded.run_attempt > ${schema.dashboardJobs.runAttempt} OR (excluded.run_attempt = ${schema.dashboardJobs.runAttempt} AND ${sql.placeholder("authoritative")} AND excluded.status <> 'completed'))`;
  return {
    recordStage: db.insert(schema.dashboardRunStages).select(db.select({
      organizationId: schema.dashboardRuns.organizationId,
      runId: schema.dashboardRuns.id,
      stage: sql<string>`${sql.placeholder("stage")}::text`.as("stage"),
      startedAt: sql<string>`${sql.placeholder("startedAt")}::timestamptz`.as("started_at"),
      completedAt: sql<string | null>`${sql.placeholder("completedAt")}::timestamptz`.as("completed_at"),
    }).from(schema.dashboardRuns).where(eq(schema.dashboardRuns.id, sql.placeholder("runId"))))
      .onConflictDoUpdate({ target: [schema.dashboardRunStages.organizationId, schema.dashboardRunStages.runId, schema.dashboardRunStages.stage], set: {
        startedAt: sql`LEAST(${schema.dashboardRunStages.startedAt}, excluded.started_at)`,
        completedAt: sql`COALESCE(${schema.dashboardRunStages.completedAt}, excluded.completed_at)`,
      } }).prepare("run_lifecycle_record_stage"),
    markMissing: db.update(schema.dashboardJobs).set({ status: "completed", stage: "failed", conclusion: "cancelled", completedAt: sql`${sql.placeholder("observedAt")}` })
      .where(and(eq(schema.dashboardJobs.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobs.githubJobId, sql.placeholder("githubJobId")), ne(schema.dashboardJobs.status, "completed")))
      .returning({ id: schema.dashboardJobs.id }).prepare("run_lifecycle_mark_job_missing"),
    installation: db.select({ id: schema.dashboardInstallations.id, organizationId: schema.dashboardInstallations.organizationId }).from(schema.dashboardInstallations)
      .where(and(eq(schema.dashboardInstallations.githubInstallationId, sql.placeholder("installationId")), eq(schema.dashboardInstallations.state, "approved"))).for("update").prepare("run_lifecycle_installation"),
    repository: db.select({ id: schema.dashboardRepositories.id }).from(schema.dashboardRepositories)
      .where(and(eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRepositories.installationId, sql.placeholder("installationId")), eq(schema.dashboardRepositories.githubRepositoryId, sql.placeholder("repositoryId")), eq(schema.dashboardRepositories.available, true)))
      .prepare("run_lifecycle_repository"),
    reviveRun: db.update(schema.dashboardRuns).set({
      status: sql`CASE WHEN ${schema.dashboardRuns.startedAt} IS NULL THEN 'queued' ELSE 'in_progress' END`,
      conclusion: null, completedAt: null,
    }).where(and(eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRuns.githubRunId, sql.placeholder("githubRunId")), eq(schema.dashboardRuns.runAttempt, sql.placeholder("runAttempt")), eq(schema.dashboardRuns.status, "completed"), notExists(db.select({ id: schema.dashboardJobs.id }).from(schema.dashboardJobs).where(and(eq(schema.dashboardJobs.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobs.githubJobId, sql.placeholder("githubJobId")), eq(schema.dashboardJobs.runAttempt, sql.placeholder("jobAttempt")))))))
      .prepare("run_lifecycle_revive_run"),
    invalidateOldGraphs: db.update(schema.dashboardRuns).set({ actionGraphResolvedAt: null }).where(and(eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRuns.githubRunId, sql.placeholder("githubRunId")), lt(schema.dashboardRuns.runAttempt, sql.placeholder("runAttempt")))).prepare("run_lifecycle_invalidate_graph"),
    resetQueuedRun: db.update(schema.dashboardRuns).set({ status: "queued", conclusion: null, queuedAt: sql`${sql.placeholder("queuedAt")}`, startedAt: null, completedAt: null }).where(and(eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRuns.githubRunId, sql.placeholder("githubRunId")), eq(schema.dashboardRuns.runAttempt, sql.placeholder("runAttempt")), eq(schema.dashboardRuns.status, "completed"))).prepare("run_lifecycle_reset_queued_run"),
    resetActiveRun: db.update(schema.dashboardRuns).set({ status: sql`${sql.placeholder("status")}`, conclusion: sql`${sql.placeholder("conclusion")}`, queuedAt: sql`${sql.placeholder("queuedAt")}`, startedAt: sql`${sql.placeholder("startedAt")}`, completedAt: sql`${sql.placeholder("completedAt")}` }).where(and(eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRuns.githubRunId, sql.placeholder("githubRunId")), eq(schema.dashboardRuns.runAttempt, sql.placeholder("runAttempt")), eq(schema.dashboardRuns.status, "completed"))).prepare("run_lifecycle_reset_active_run"),
    resetQueuedJob: db.update(schema.dashboardJobs).set({ status: "queued", conclusion: null, stage: "queued", queuedAt: sql`${sql.placeholder("queuedAt")}`, startedAt: null, completedAt: null }).where(and(eq(schema.dashboardJobs.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobs.githubJobId, sql.placeholder("githubJobId")), eq(schema.dashboardJobs.runAttempt, sql.placeholder("runAttempt")), eq(schema.dashboardJobs.status, "completed"))).prepare("run_lifecycle_reset_queued_job"),
    resetActiveJob: db.update(schema.dashboardJobs).set({ status: sql`${sql.placeholder("status")}`, conclusion: sql`${sql.placeholder("conclusion")}`, stage: sql`${sql.placeholder("stage")}`, queuedAt: sql`${sql.placeholder("queuedAt")}`, startedAt: sql`${sql.placeholder("startedAt")}`, completedAt: sql`${sql.placeholder("completedAt")}` }).where(and(eq(schema.dashboardJobs.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobs.githubJobId, sql.placeholder("githubJobId")), eq(schema.dashboardJobs.runAttempt, sql.placeholder("runAttempt")), eq(schema.dashboardJobs.status, "completed"))).prepare("run_lifecycle_reset_active_job"),
    upsertRun: db.insert(schema.dashboardRuns).values({
      organizationId: sql.placeholder("organizationId"), repositoryId: sql.placeholder("repositoryId"), githubRunId: sql.placeholder("githubRunId"), runAttempt: sql.placeholder("runAttempt"), runNumber: sql.placeholder("runNumber"),
      workflowName: sql.placeholder("workflowName"), event: sql.placeholder("event"), branch: sql.placeholder("branch"), commitSha: sql.placeholder("commitSha"), actorLogin: sql.placeholder("actorLogin"),
      status: sql.placeholder("status"), conclusion: sql.placeholder("conclusion"), queuedAt: sql.placeholder("queuedAt"), startedAt: sql.placeholder("startedAt"), completedAt: sql.placeholder("completedAt"),
    }).onConflictDoUpdate({ target: [schema.dashboardRuns.organizationId, schema.dashboardRuns.githubRunId], set: {
      runAttempt: sql`CASE WHEN excluded.run_attempt > ${schema.dashboardRuns.runAttempt} THEN excluded.run_attempt ELSE ${schema.dashboardRuns.runAttempt} END`,
      status: sql`CASE WHEN ${replacedRun} THEN excluded.status WHEN ${schema.dashboardRuns.status}='completed' THEN ${schema.dashboardRuns.status} WHEN excluded.run_attempt=${schema.dashboardRuns.runAttempt} AND (excluded.status='completed' OR (${schema.dashboardRuns.status}='queued' AND excluded.status='in_progress')) THEN excluded.status ELSE ${schema.dashboardRuns.status} END`,
      conclusion: sql`CASE WHEN ${replacedRun} THEN excluded.conclusion WHEN excluded.run_attempt=${schema.dashboardRuns.runAttempt} THEN COALESCE(${schema.dashboardRuns.conclusion},excluded.conclusion) ELSE ${schema.dashboardRuns.conclusion} END`,
      queuedAt: sql`CASE WHEN ${replacedRun} THEN excluded.queued_at WHEN excluded.run_attempt=${schema.dashboardRuns.runAttempt} THEN LEAST(${schema.dashboardRuns.queuedAt},excluded.queued_at) ELSE ${schema.dashboardRuns.queuedAt} END`,
      startedAt: sql`CASE WHEN ${replacedRun} THEN excluded.started_at WHEN excluded.run_attempt=${schema.dashboardRuns.runAttempt} THEN COALESCE(LEAST(${schema.dashboardRuns.startedAt},excluded.started_at),${schema.dashboardRuns.startedAt},excluded.started_at) ELSE ${schema.dashboardRuns.startedAt} END`,
      completedAt: sql`CASE WHEN ${replacedRun} THEN excluded.completed_at WHEN excluded.run_attempt=${schema.dashboardRuns.runAttempt} THEN COALESCE(GREATEST(${schema.dashboardRuns.completedAt},excluded.completed_at),${schema.dashboardRuns.completedAt},excluded.completed_at) ELSE ${schema.dashboardRuns.completedAt} END`,
    } }).returning({ id: schema.dashboardRuns.id }).prepare("run_lifecycle_upsert_run"),
    completeRunJobs: db.update(schema.dashboardJobs).set({ status: "completed", conclusion: sql`COALESCE(${schema.dashboardJobs.conclusion},${sql.placeholder("conclusion")})`, completedAt: sql`COALESCE(${schema.dashboardJobs.completedAt},${sql.placeholder("completedAt")})` })
      .where(and(eq(schema.dashboardJobs.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobs.runId, sql.placeholder("runId")), eq(schema.dashboardJobs.runAttempt, sql.placeholder("runAttempt")), ne(schema.dashboardJobs.status, "completed"))).prepare("run_lifecycle_complete_jobs"),
    upsertJob: db.insert(schema.dashboardJobs).values({
      organizationId: sql.placeholder("organizationId"), runId: sql.placeholder("runId"), runAttempt: sql.placeholder("runAttempt"), githubJobId: sql.placeholder("githubJobId"),
      name: sql.placeholder("name"), status: sql.placeholder("status"), conclusion: sql.placeholder("conclusion"), stage: sql.placeholder("stage"), runnerName: sql.placeholder("runnerName"),
      requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, requestedLabels: sql.placeholder("labels"),
      queuedAt: sql.placeholder("queuedAt"), startedAt: sql.placeholder("startedAt"), completedAt: sql.placeholder("completedAt"),
    }).onConflictDoUpdate({ target: [schema.dashboardJobs.organizationId, schema.dashboardJobs.githubJobId], set: {
      runAttempt: sql`CASE WHEN excluded.run_attempt > ${schema.dashboardJobs.runAttempt} THEN excluded.run_attempt ELSE ${schema.dashboardJobs.runAttempt} END`,
      status: sql`CASE WHEN ${replacedJob} THEN excluded.status WHEN ${schema.dashboardJobs.status}='completed' THEN ${schema.dashboardJobs.status} WHEN excluded.run_attempt=${schema.dashboardJobs.runAttempt} AND (excluded.status='completed' OR (${schema.dashboardJobs.status}='queued' AND excluded.status='in_progress')) THEN excluded.status ELSE ${schema.dashboardJobs.status} END`,
      conclusion: sql`CASE WHEN ${replacedJob} THEN excluded.conclusion WHEN excluded.run_attempt=${schema.dashboardJobs.runAttempt} THEN COALESCE(${schema.dashboardJobs.conclusion},excluded.conclusion) ELSE ${schema.dashboardJobs.conclusion} END`,
      stage: sql`CASE WHEN ${replacedJob} THEN excluded.stage WHEN excluded.run_attempt=${schema.dashboardJobs.runAttempt} AND excluded.status='completed' THEN CASE WHEN COALESCE(${schema.dashboardJobs.conclusion},excluded.conclusion)='success' THEN 'completed' ELSE 'failed' END WHEN excluded.run_attempt=${schema.dashboardJobs.runAttempt} AND ${schema.dashboardJobs.status}='queued' AND excluded.status='in_progress' THEN excluded.stage ELSE ${schema.dashboardJobs.stage} END`,
      runnerName: sql`CASE WHEN excluded.run_attempt >= ${schema.dashboardJobs.runAttempt} THEN COALESCE(excluded.runner_name,${schema.dashboardJobs.runnerName}) ELSE ${schema.dashboardJobs.runnerName} END`,
      queuedAt: sql`CASE WHEN ${replacedJob} THEN excluded.queued_at WHEN excluded.run_attempt=${schema.dashboardJobs.runAttempt} THEN LEAST(${schema.dashboardJobs.queuedAt},excluded.queued_at) ELSE ${schema.dashboardJobs.queuedAt} END`,
      startedAt: sql`CASE WHEN ${replacedJob} THEN excluded.started_at WHEN excluded.run_attempt=${schema.dashboardJobs.runAttempt} THEN COALESCE(LEAST(${schema.dashboardJobs.startedAt},excluded.started_at),${schema.dashboardJobs.startedAt},excluded.started_at) ELSE ${schema.dashboardJobs.startedAt} END`,
      completedAt: sql`CASE WHEN ${replacedJob} THEN excluded.completed_at WHEN excluded.run_attempt=${schema.dashboardJobs.runAttempt} THEN COALESCE(${schema.dashboardJobs.completedAt},excluded.completed_at) ELSE ${schema.dashboardJobs.completedAt} END`,
    } }).returning({ id: schema.dashboardJobs.id }).prepare("run_lifecycle_upsert_job"),
    upsertStep: db.insert(schema.dashboardJobSteps).values({
      organizationId: sql.placeholder("organizationId"), runId: sql.placeholder("runId"), jobId: sql.placeholder("jobId"), id: sql.placeholder("id"), name: sql.placeholder("name"),
      number: sql.placeholder("number"), status: sql.placeholder("status"), conclusion: sql.placeholder("conclusion"), queuedAt: sql.placeholder("queuedAt"),
      startedAt: sql.placeholder("startedAt"), completedAt: sql.placeholder("completedAt"), durationMs: sql.placeholder("durationMs"),
    }).onConflictDoUpdate({ target: [schema.dashboardJobSteps.organizationId, schema.dashboardJobSteps.runId, schema.dashboardJobSteps.jobId, schema.dashboardJobSteps.number], set: {
      id: sql`CASE WHEN ${schema.dashboardJobSteps.id} !~ '-' THEN excluded.id ELSE ${schema.dashboardJobSteps.id} END`,
      name: sql`excluded.name`,
      status: sql`CASE WHEN ${schema.dashboardJobSteps.status}='completed' THEN ${schema.dashboardJobSteps.status} WHEN excluded.status='completed' OR (${schema.dashboardJobSteps.status}='queued' AND excluded.status='in_progress') THEN excluded.status ELSE ${schema.dashboardJobSteps.status} END`,
      conclusion: sql`COALESCE(${schema.dashboardJobSteps.conclusion},excluded.conclusion)`,
      queuedAt: sql`LEAST(${schema.dashboardJobSteps.queuedAt},excluded.queued_at)`,
      startedAt: sql`COALESCE(LEAST(${schema.dashboardJobSteps.startedAt},excluded.started_at),${schema.dashboardJobSteps.startedAt},excluded.started_at)`,
      completedAt: sql`COALESCE(${schema.dashboardJobSteps.completedAt},excluded.completed_at)`,
      durationMs: sql`GREATEST(${schema.dashboardJobSteps.durationMs},excluded.duration_ms)`,
    } }).prepare("run_lifecycle_upsert_step"),
  };
});
const normalizeRunStatus = (value: string | undefined): GithubRunSnapshot["status"] => value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued";
const normalizeJobStatus = (value: string | undefined): GithubJobSnapshot["status"] => value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued";
const stageFor = (action: string | undefined, status: string | undefined, conclusion: string | null | undefined): RunStage => {
  if (action === "completed" || status === "completed") return conclusion && conclusion !== "success" ? "failed" : "completed";
  if (action === "in_progress" || status === "in_progress") return "running";
  return "queued";
};
export function stageDurationMs(timestamps: StageTimestamps): number { const end = timestamps.completedAt ? Date.parse(timestamps.completedAt) : Date.now(); return Math.max(0, end - Date.parse(timestamps.startedAt)); }
export async function recordRunStage(runId: string, stage: RunStage, timestamps: StageTimestamps): Promise<void> {
  const prepared = queries(db());
  await prepared.recordStage.execute({ runId, stage, startedAt: timestamps.startedAt, completedAt: timestamps.completedAt ?? null });
}
export async function markGithubJobMissing(sql: DatabaseClient, input: { organizationId: string; githubJobId: number; observedAt: string }): Promise<boolean> {
  const rows = await queries(sql).markMissing.execute(input);
  return rows.length > 0;
}
export async function applyGithubJobSnapshot(input: { installationId:number; repository:{id:number;name:string;fullName:string}; run:GithubRunSnapshot; job:GithubJobSnapshot; authoritative?: boolean }): Promise<boolean> {
  if (input.run.id !== input.job.runId || input.run.runAttempt !== input.job.runAttempt) throw new Error("github_payload_invalid");
  const sql = db();
  const labels = [...new Set(input.job.labels.map(x => x.trim().toLowerCase()).filter(Boolean))];
  const runStatus = input.run.status, jobStatus = input.job.status, stage = runStatus === "completed" || jobStatus === "completed" ? (input.job.conclusion === "success" ? "completed" : "failed") : jobStatus === "in_progress" ? "running" : "queued";
  const authoritative = input.authoritative === true;
  const result = await sql.transaction(async tx => {
    const prepared = queries(tx as unknown as DatabaseClient);
    const [installation] = await prepared.installation.execute({ installationId: input.installationId });
    if (!installation) {
      if (jobStatus === "queued") console.warn("Queued GitHub job not ingested", { installationId: input.installationId, repository: input.repository.fullName, runId: input.run.id, jobId: input.job.id, reason: "installation_not_approved" });
      return false;
    }
    const [repository] = await prepared.repository.execute({ organizationId: installation.organizationId, installationId: installation.id, repositoryId: input.repository.id });
    if (!repository) {
      if (jobStatus === "queued") console.warn("Queued GitHub job not ingested", { installationId: input.installationId, repository: input.repository.fullName, runId: input.run.id, jobId: input.job.id, reason: "repository_unavailable" });
      return false;
    }
    if (!authoritative && runStatus !== "completed" && jobStatus === "queued") {
      await prepared.reviveRun.execute({ organizationId: installation.organizationId, githubRunId: input.run.id, runAttempt: input.run.runAttempt, githubJobId: input.job.id, jobAttempt: input.job.runAttempt });
    }
    await prepared.invalidateOldGraphs.execute({ organizationId: installation.organizationId, githubRunId: input.run.id, runAttempt: input.run.runAttempt });
    if (authoritative && runStatus !== "completed") {
      if (runStatus === "queued") {
        await prepared.resetQueuedRun.execute({ organizationId: installation.organizationId, githubRunId: input.run.id, runAttempt: input.run.runAttempt, queuedAt: input.run.queuedAt });
      } else {
        await prepared.resetActiveRun.execute({ organizationId: installation.organizationId, githubRunId: input.run.id, runAttempt: input.run.runAttempt, status: runStatus, conclusion: input.run.conclusion, queuedAt: input.run.queuedAt, startedAt: input.run.startedAt, completedAt: input.run.completedAt });
      }
      if (jobStatus === "queued") {
        await prepared.resetQueuedJob.execute({ organizationId: installation.organizationId, githubJobId: input.job.id, runAttempt: input.job.runAttempt, queuedAt: input.job.queuedAt });
      } else {
        await prepared.resetActiveJob.execute({ organizationId: installation.organizationId, githubJobId: input.job.id, runAttempt: input.job.runAttempt, status: jobStatus, conclusion: input.job.conclusion, stage, queuedAt: input.job.queuedAt, startedAt: input.job.startedAt, completedAt: input.job.completedAt });
      }
    }
    const [run] = await prepared.upsertRun.execute({
      organizationId: installation.organizationId, repositoryId: repository.id, githubRunId: input.run.id, runAttempt: input.run.runAttempt, runNumber: input.run.runNumber,
      workflowName: input.run.workflowName, event: input.run.event, branch: input.run.branch, commitSha: input.run.commitSha, actorLogin: input.run.actorLogin,
      status: runStatus, conclusion: input.run.conclusion, queuedAt: input.run.queuedAt, startedAt: input.run.startedAt, completedAt: input.run.completedAt,
      authoritative,
    });
    if (runStatus === "completed") {
      await prepared.completeRunJobs.execute({ organizationId: installation.organizationId, runId: run!.id, runAttempt: input.run.runAttempt, conclusion: input.run.conclusion, completedAt: input.run.completedAt ?? new Date().toISOString() });
    }
    const [job] = await prepared.upsertJob.execute({
      organizationId: installation.organizationId, runId: run!.id, runAttempt: input.job.runAttempt, githubJobId: input.job.id, name: input.job.name, status: jobStatus,
      conclusion: input.job.conclusion, stage, runnerName: input.job.runnerName, labels, queuedAt: input.job.queuedAt, startedAt: input.job.startedAt, completedAt: input.job.completedAt,
      authoritative,
    });
    if (!job) return false;
    for (const step of input.job.steps) {
      const stepId = step.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(step.id) ? step.id : crypto.randomUUID();
      await prepared.upsertStep.execute({
        organizationId: installation.organizationId, runId: run!.id, jobId: job.id, id: stepId, name: step.name, number: step.number, status: step.status,
        conclusion: step.conclusion, queuedAt: step.queuedAt, startedAt: step.startedAt, completedAt: step.completedAt, durationMs: step.durationMs,
      });
    }
    await enqueuePipelineFailureAnalysis({ db: tx as unknown as DatabaseClient, organizationId: String(installation.organizationId), repositoryId: String(repository.id), run: input.run, jobs: [input.job], completeSnapshot: false });
    return true;
  });
  return result;
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
