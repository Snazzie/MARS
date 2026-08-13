import type { DatabaseClient } from "@whitesmith/db";
import type { GithubJobsClient } from "./github-jobs.ts";
import { attributeGithubJobLog } from "./github-job-logs.ts";
import type { GithubJobSnapshot } from "./runs.ts";

const LOG_CHUNK_BYTES = 64 * 1024;
export const GITHUB_LOG_FORMAT_VERSION = 1;
const permanentLogErrors = new Set(["github_404", "github_410", "github_job_log_too_large"]);

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
  const [candidate] = await input.db`SELECT id,logs_state AS "logsState",logs_version AS "logsVersion" FROM dashboard_jobs WHERE github_job_id=${input.job.id} AND status='completed'`;
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
    await input.db`UPDATE dashboard_jobs SET logs_state='unavailable',logs_synced_at=now(),logs_error=${code},logs_version=${GITHUB_LOG_FORMAT_VERSION} WHERE github_job_id=${input.job.id} AND logs_version<${GITHUB_LOG_FORMAT_VERSION}`;
    return false;
  }

  const attributed = attributeGithubJobLog(text, input.job.steps);
  return input.db.begin(async tx => {
    const [stored] = await tx`SELECT id,organization_id AS "organizationId",run_id AS "runId",logs_state AS "logsState",logs_version AS "logsVersion" FROM dashboard_jobs WHERE github_job_id=${input.job.id} AND status='completed' FOR UPDATE`;
    if (!stored || (stored.logsState !== "pending" && Number(stored.logsVersion) >= GITHUB_LOG_FORMAT_VERSION)) return false;
    const stepRows = await tx`SELECT id,number FROM dashboard_job_steps WHERE organization_id=${stored.organizationId} AND run_id=${stored.runId} AND job_id=${stored.id}`;
    const stepIds = new Map(stepRows.map(row => [Number(row.number), String(row.id)]));
    let unattributed = attributed.unattributed;

    await tx`DELETE FROM dashboard_step_log_chunks WHERE organization_id=${stored.organizationId} AND run_id=${stored.runId} AND job_id=${stored.id}`;
    await tx`DELETE FROM dashboard_log_chunks WHERE organization_id=${stored.organizationId} AND run_id=${stored.runId} AND job_id=${stored.id}`;
    for (const [stepNumber, stepText] of attributed.steps) {
      const stepId = stepIds.get(stepNumber);
      if (!stepId) {
        unattributed += stepText;
        continue;
      }
      const step = input.job.steps.find(item => item.number === stepNumber);
      const chunks = chunkLogText(stepText);
      for (let sequence = 0; sequence < chunks.length; sequence += 1) {
        await tx`INSERT INTO dashboard_step_log_chunks (organization_id,run_id,job_id,step_id,sequence,content,occurred_at) VALUES (${stored.organizationId},${stored.runId},${stored.id},${stepId},${sequence},${chunks[sequence]},${step?.startedAt ?? input.job.startedAt ?? input.job.queuedAt})`;
      }
    }
    const jobChunks = chunkLogText(unattributed);
    for (let sequence = 0; sequence < jobChunks.length; sequence += 1) {
      await tx`INSERT INTO dashboard_log_chunks (organization_id,run_id,job_id,sequence,content,occurred_at) VALUES (${stored.organizationId},${stored.runId},${stored.id},${sequence},${jobChunks[sequence]},${input.job.startedAt ?? input.job.queuedAt})`;
    }
    await tx`UPDATE dashboard_jobs SET logs_state='ingested',logs_synced_at=now(),logs_error=NULL,logs_version=${GITHUB_LOG_FORMAT_VERSION} WHERE id=${stored.id}`;
    return true;
  });
}
