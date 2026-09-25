import { parseJobRunnerLabels } from "@mars/contracts";
import type { DatabaseClient } from "@mars/db";
import { GithubJobsClient } from "./github-jobs.ts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RetryDeps = {
  db: DatabaseClient;
  installationToken: (installationId: number) => Promise<string>;
  githubFetchForInstallation: (installationId: number) => Fetcher;
  installationBlocked?: (installationId: number) => boolean;
};
type Candidate = {
  id: string;
  organizationId: string;
  githubRunId: number;
  runAttempt: number;
  githubJobId: number;
  requestedLabels: unknown;
  fullName: string;
  installationId: number;
};

const retryDirective = (labels: readonly string[]): string | undefined => labels.map(label => label.trim().toLowerCase()).find(label => /^mars-retry-/.test(label));

/** Claim before POST: GitHub has no idempotency key for job reruns. */
export async function retryFailedGithubJobs(deps: RetryDeps): Promise<{ requested: number; skipped: number; failed: number }> {
  const rows = await deps.db`
    SELECT r.id, r.organization_id AS "organizationId", r.github_run_id AS "githubRunId",
      r.run_attempt AS "runAttempt", j.github_job_id AS "githubJobId",
      j.requested_labels AS "requestedLabels", repo.full_name AS "fullName",
      i.github_installation_id AS "installationId"
    FROM dashboard_runs r
    JOIN dashboard_repositories repo ON repo.id=r.repository_id AND repo.organization_id=r.organization_id AND repo.available=true
    JOIN dashboard_installations i ON i.id=repo.installation_id AND i.organization_id=r.organization_id AND i.state='approved'
    JOIN dashboard_jobs j ON j.run_id=r.id AND j.organization_id=r.organization_id AND j.run_attempt=r.run_attempt
    WHERE r.status='completed' AND r.completed_at > r.retry_eligible_since
      AND r.retry_requested_attempt IS DISTINCT FROM r.run_attempt
      AND j.status='completed' AND j.conclusion IN ('failure', 'timed_out')
    ORDER BY r.id, j.github_job_id
  ` as Candidate[];
  const report = { requested: 0, skipped: 0, failed: 0 };
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    if (!Array.isArray(row.requestedLabels) || !row.requestedLabels.every((label: unknown) => typeof label === "string")) continue;
    const labels = row.requestedLabels as string[];
    const parsed = parseJobRunnerLabels(labels);
    if (parsed?.maxRetries === null || !parsed || row.runAttempt > parsed.maxRetries) continue;
    seen.add(row.id);
    const [owner, repo] = row.fullName.split("/", 2);
    if (!owner || !repo || deps.installationBlocked?.(Number(row.installationId))) { report.skipped++; continue; }
    try {
      const client = new GithubJobsClient({ token: () => deps.installationToken(Number(row.installationId)), fetch: deps.githubFetchForInstallation(Number(row.installationId)) });
      const run = await client.getRun(owner, repo, Number(row.githubRunId));
      const job = await client.getJob(owner, repo, Number(row.githubJobId));
      const latest = parseJobRunnerLabels(job.labels);
      if (run.id !== Number(row.githubRunId) || run.runAttempt !== row.runAttempt || run.status !== "completed"
        || job.id !== Number(row.githubJobId) || job.runId !== run.id || job.runAttempt !== row.runAttempt
        || job.status !== "completed" || (job.conclusion !== "failure" && job.conclusion !== "timed_out")
        || latest?.maxRetries !== parsed.maxRetries || retryDirective(job.labels) !== retryDirective(labels)
        || deps.installationBlocked?.(Number(row.installationId))) { report.skipped++; continue; }
      const claimed = await deps.db`
        UPDATE dashboard_runs SET retry_requested_attempt=run_attempt
        WHERE id=${row.id} AND organization_id=${row.organizationId} AND run_attempt=${row.runAttempt}
          AND status='completed' AND completed_at > retry_eligible_since
          AND retry_requested_attempt IS DISTINCT FROM run_attempt
        RETURNING id
      `;
      if (!claimed.length) { report.skipped++; continue; }
      await client.rerunJob(owner, repo, Number(row.githubJobId));
      report.requested++;
    } catch (error) {
      report.failed++;
      console.error("GitHub job rerun failed; claim retained if acquired", { runId: row.githubRunId, jobId: row.githubJobId, attempt: row.runAttempt, error });
    }
  }
  return report;
}
