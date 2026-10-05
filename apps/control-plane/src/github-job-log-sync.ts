import { and, eq, lt, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import type { GithubJobsClient } from "./github-jobs.ts";
import { attributeGithubJobLog } from "./github-job-logs.ts";
import type { GithubJobSnapshot } from "./runs.ts";
const LOG_CHUNK_BYTES = 64 * 1024;
export const GITHUB_LOG_FORMAT_VERSION = 1;
const permanentLogErrors = new Set(["github_404", "github_410", "github_job_log_too_large"]);
const queries = defineQueries(db => ({
  candidate: db.select({ id: schema.dashboardJobs.id, logsState: schema.dashboardJobs.logsState, logsVersion: schema.dashboardJobs.logsVersion })
    .from(schema.dashboardJobs).where(and(eq(schema.dashboardJobs.githubJobId, sql.placeholder("jobId")), eq(schema.dashboardJobs.status, "completed")))
    .limit(1).prepare("github_job_logs_candidate"),
  unavailable: db.update(schema.dashboardJobs).set({ logsState: "unavailable", logsSyncedAt: sql`now()`, logsError: sql`${sql.placeholder("code")}`, logsVersion: GITHUB_LOG_FORMAT_VERSION })
    .where(and(eq(schema.dashboardJobs.githubJobId, sql.placeholder("jobId")), lt(schema.dashboardJobs.logsVersion, GITHUB_LOG_FORMAT_VERSION)))
    .prepare("github_job_logs_unavailable"),
  locked: db.select({ id: schema.dashboardJobs.id, organizationId: schema.dashboardJobs.organizationId, runId: schema.dashboardJobs.runId, logsState: schema.dashboardJobs.logsState, logsVersion: schema.dashboardJobs.logsVersion })
    .from(schema.dashboardJobs).where(and(eq(schema.dashboardJobs.githubJobId, sql.placeholder("jobId")), eq(schema.dashboardJobs.status, "completed")))
    .for("update").limit(1).prepare("github_job_logs_locked"),
  steps: db.select({ id: schema.dashboardJobSteps.id, number: schema.dashboardJobSteps.number }).from(schema.dashboardJobSteps)
    .where(and(eq(schema.dashboardJobSteps.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardJobSteps.runId, sql.placeholder("runId")), eq(schema.dashboardJobSteps.jobId, sql.placeholder("jobId"))))
    .prepare("github_job_logs_steps"),
  deleteSteps: db.delete(schema.dashboardStepLogChunks).where(and(eq(schema.dashboardStepLogChunks.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardStepLogChunks.runId, sql.placeholder("runId")), eq(schema.dashboardStepLogChunks.jobId, sql.placeholder("jobId")))).prepare("github_job_logs_delete_steps"),
  deleteJobs: db.delete(schema.dashboardLogChunks).where(and(eq(schema.dashboardLogChunks.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardLogChunks.runId, sql.placeholder("runId")), eq(schema.dashboardLogChunks.jobId, sql.placeholder("jobId")))).prepare("github_job_logs_delete_job"),
  insertStep: db.insert(schema.dashboardStepLogChunks).values({
    organizationId: sql.placeholder("organizationId"), runId: sql.placeholder("runId"), jobId: sql.placeholder("jobId"),
    stepId: sql.placeholder("stepId"), sequence: sql.placeholder("sequence"), content: sql.placeholder("content"), occurredAt: sql.placeholder("occurredAt"),
  }).prepare("github_job_logs_insert_step"),
  insertJob: db.insert(schema.dashboardLogChunks).values({
    organizationId: sql.placeholder("organizationId"), runId: sql.placeholder("runId"), jobId: sql.placeholder("jobId"),
    sequence: sql.placeholder("sequence"), content: sql.placeholder("content"), occurredAt: sql.placeholder("occurredAt"),
  }).prepare("github_job_logs_insert_job"),
  markIngested: db.update(schema.dashboardJobs).set({ logsState: "ingested", logsSyncedAt: sql`now()`, logsError: null, logsVersion: GITHUB_LOG_FORMAT_VERSION })
    .where(eq(schema.dashboardJobs.id, sql.placeholder("id"))).prepare("github_job_logs_mark_ingested"),
}));


export function chunkLogText(text: string, maxBytes = LOG_CHUNK_BYTES): string[] {
  if (!text) return [];
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error("log_chunk_size_invalid");
  const bytes = Buffer.from(text, "utf8");
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + maxBytes, bytes.length);
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    if (end === start) end = Math.min(start + maxBytes, bytes.length);
    chunks.push(bytes.toString("utf8", start, end));
    start = end;
  }
  return chunks;
}

export async function syncCompletedGithubJobLogs(input: {
  db: DatabaseClient;
  client: Pick<GithubJobsClient, "getJobLogs">;
  owner: string;
  repo: string;
  job: GithubJobSnapshot;
  now?: () => number;
}): Promise<boolean> {
  if (input.job.status !== "completed") return false;
  const [candidate] = await queries(input.db).candidate.execute({ jobId: input.job.id });
  if (!candidate || (candidate.logsState !== "pending" && Number(candidate.logsVersion) >= GITHUB_LOG_FORMAT_VERSION)) return false;

  let text: string;
  try {
    text = await input.client.getJobLogs(input.owner, input.repo, input.job.id);
  } catch (error) {
    const code = error instanceof Error ? error.message : "github_job_log_failed";
    if (code === "github_404") {
      const completedAt = input.job.completedAt ? Date.parse(input.job.completedAt) : NaN;
      if (!Number.isFinite(completedAt) || (input.now?.() ?? Date.now()) - completedAt < 5 * 60_000) {
        throw new Error("github_job_logs_not_ready", { cause: error });
      }
    }
    if (!permanentLogErrors.has(code)) throw error;
    await queries(input.db).unavailable.execute({ code, jobId: input.job.id });
    return false;
  }

  const attributed = attributeGithubJobLog(text, input.job.steps);
  return input.db.transaction(async tx => {
    const statements = queries(tx as unknown as DatabaseClient);
    const [stored] = await statements.locked.execute({ jobId: input.job.id });
    if (!stored || (stored.logsState !== "pending" && Number(stored.logsVersion) >= GITHUB_LOG_FORMAT_VERSION)) return false;
    const stepRows = await statements.steps.execute({ organizationId: stored.organizationId, runId: stored.runId, jobId: stored.id });
    const stepIds = new Map(stepRows.map(row => [Number(row.number), String(row.id)]));
    let unattributed = attributed.unattributed;

    await statements.deleteSteps.execute({ organizationId: stored.organizationId, runId: stored.runId, jobId: stored.id });
    await statements.deleteJobs.execute({ organizationId: stored.organizationId, runId: stored.runId, jobId: stored.id });
    for (const [stepNumber, stepText] of attributed.steps) {
      const stepId = stepIds.get(stepNumber);
      if (!stepId) {
        unattributed += stepText;
        continue;
      }
      const step = input.job.steps.find(item => item.number === stepNumber);
      const chunks = chunkLogText(stepText);
      for (let sequence = 0; sequence < chunks.length; sequence += 1) {
        await statements.insertStep.execute({ organizationId: stored.organizationId, runId: stored.runId, jobId: stored.id, stepId, sequence, content: chunks[sequence]!, occurredAt: step?.startedAt ?? input.job.startedAt ?? input.job.queuedAt });
      }
    }
    const jobChunks = chunkLogText(unattributed);
    for (let sequence = 0; sequence < jobChunks.length; sequence += 1) {
      await statements.insertJob.execute({ organizationId: stored.organizationId, runId: stored.runId, jobId: stored.id, sequence, content: jobChunks[sequence]!, occurredAt: input.job.startedAt ?? input.job.queuedAt });
    }
    await statements.markIngested.execute({ id: stored.id });
    return true;
  });
}
