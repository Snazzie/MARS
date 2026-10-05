import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import { parseJobRunnerLabels } from "@mars/contracts";
import { GithubJobsClient } from "./github-jobs.ts";

const queries = defineQueries(db => ({
  candidates: db.select({
    id: schema.dashboardRuns.id,
    organizationId: schema.dashboardRuns.organizationId,
    githubRunId: schema.dashboardRuns.githubRunId,
    runAttempt: schema.dashboardRuns.runAttempt,
    githubJobId: schema.dashboardJobs.githubJobId,
    requestedLabels: schema.dashboardJobs.requestedLabels,
    fullName: schema.dashboardRepositories.fullName,
    installationId: schema.dashboardInstallations.githubInstallationId,
  }).from(schema.dashboardRuns)
    .innerJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId), eq(schema.dashboardRepositories.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardRepositories.available, true)))
    .innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId), eq(schema.dashboardInstallations.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardInstallations.state, "approved")))
    .innerJoin(schema.dashboardJobs, and(eq(schema.dashboardJobs.runId, schema.dashboardRuns.id), eq(schema.dashboardJobs.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardJobs.runAttempt, schema.dashboardRuns.runAttempt)))
    .where(and(eq(schema.dashboardRuns.status, "completed"), gt(schema.dashboardRuns.completedAt, schema.dashboardRuns.retryEligibleSince), sql`${schema.dashboardRuns.retryRequestedAttempt} IS DISTINCT FROM ${schema.dashboardRuns.runAttempt}`, eq(schema.dashboardJobs.status, "completed"), inArray(schema.dashboardJobs.conclusion, ["failure", "timed_out"])))
    .orderBy(asc(schema.dashboardRuns.id), asc(schema.dashboardJobs.githubJobId)).prepare("github_job_retry_candidates"),
  claim: db.update(schema.dashboardRuns).set({ retryRequestedAttempt: sql`${schema.dashboardRuns.runAttempt}` })
    .where(and(eq(schema.dashboardRuns.id, sql.placeholder("id")), eq(schema.dashboardRuns.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardRuns.runAttempt, sql.placeholder("runAttempt")), eq(schema.dashboardRuns.status, "completed"), gt(schema.dashboardRuns.completedAt, schema.dashboardRuns.retryEligibleSince), sql`${schema.dashboardRuns.retryRequestedAttempt} IS DISTINCT FROM ${schema.dashboardRuns.runAttempt}`))
    .returning({ id: schema.dashboardRuns.id }).prepare("github_job_retry_claim"),
}));

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
  const prepared = queries(deps.db);
  const rows = await prepared.candidates.execute() as Candidate[];
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
      const claimed = await prepared.claim.execute({ id: row.id, organizationId: row.organizationId, runAttempt: row.runAttempt });
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
