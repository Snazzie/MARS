import type { DatabaseClient } from "@whitesmith/db";
import { jsonParameter } from "@whitesmith/db";
import { applyGithubJobSnapshot, type GithubJobSnapshot } from "./runs.ts";
import { GithubJobsClient } from "./github-jobs.ts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type StaleLeaseRow = {
  leaseId: string;
  organizationId: string;
  workerId: string;
  nonce: string;
  githubJobId: number | string;
  githubRunId: number | string;
  githubRepositoryId: number | string;
  repositoryName: string;
  repositoryFullName: string;
  installationId: number | string;
};

export type StaleLeaseReconciliationReport = {
  inspected: number;
  completed: number;
  stillActive: number;
  skipped: number;
};

export type StaleLeaseReconciliationDeps = {
  db: DatabaseClient;
  installationToken: (installationId: number) => Promise<string>;
  githubFetchForInstallation: (installationId: number) => Fetcher;
};
function splitRepository(fullName: string): { owner: string; repo: string } | null {
  const [owner, repo, ...extra] = fullName.split("/");
  return owner && repo && extra.length === 0 ? { owner, repo } : null;
}

export function terminalLeaseState(job: Pick<GithubJobSnapshot, "conclusion">): "completed" | "failed" {
  return job.conclusion === "success" ? "completed" : "failed";
}
export async function reconcileExpiredLeasesWithGithub(deps: StaleLeaseReconciliationDeps): Promise<StaleLeaseReconciliationReport> {
  const rows = await deps.db<StaleLeaseRow[]>`
    SELECT l.id AS "leaseId", l.organization_id AS "organizationId", l.worker_id AS "workerId", l.nonce,
      l.github_job_id AS "githubJobId", r.github_run_id AS "githubRunId",
      repo.github_repository_id AS "githubRepositoryId", repo.name AS "repositoryName",
      repo.full_name AS "repositoryFullName", i.github_installation_id AS "installationId"
    FROM runner_leases l
    JOIN dashboard_jobs j ON j.organization_id=l.organization_id AND j.github_job_id=l.github_job_id
    JOIN dashboard_runs r ON r.organization_id=j.organization_id AND r.id=j.run_id
    JOIN dashboard_repositories repo ON repo.organization_id=r.organization_id AND repo.id=r.repository_id
    JOIN dashboard_installations i ON i.organization_id=repo.organization_id AND i.id=repo.installation_id
    WHERE l.expires_at < now()
      AND l.state NOT IN ('completed','failed','reaped')
      AND l.github_job_id IS NOT NULL
    ORDER BY l.expires_at
    LIMIT 100
  `;
  const report: StaleLeaseReconciliationReport = { inspected: rows.length, completed: 0, stillActive: 0, skipped: 0 };
  for (const row of rows) {
    const repository = splitRepository(String(row.repositoryFullName));
    const installationId = Number(row.installationId);
    const githubJobId = Number(row.githubJobId);
    const githubRunId = Number(row.githubRunId);
    if (!repository || !Number.isSafeInteger(installationId) || !Number.isSafeInteger(githubJobId) || !Number.isSafeInteger(githubRunId)) {
      report.skipped += 1;
      continue;
    }
    try {
      const client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
      const [run, job] = await Promise.all([client.getRun(repository.owner, repository.repo, githubRunId), client.getJob(repository.owner, repository.repo, githubJobId)]);
      if (job.status !== "completed") {
        report.stillActive += 1;
        continue;
      }
      const applied = await applyGithubJobSnapshot({
        installationId,
        repository: { id: Number(row.githubRepositoryId), name: String(row.repositoryName), fullName: String(row.repositoryFullName) },
        run,
        job,
      });
      if (!applied) {
        report.skipped += 1;
        continue;
      }
      const state = terminalLeaseState(job);
      await deps.db`UPDATE runner_leases SET state=${state}, terminal_result=${jsonParameter(deps.db, { reason: "github_reconciled", conclusion: job.conclusion })}::jsonb, cleanup_state='pending', updated_at=now() WHERE id=${row.leaseId} AND nonce=${row.nonce} AND state NOT IN ('completed','failed','reaped')`;
      report.completed += 1;
    } catch (error) {
      report.skipped += 1;
      console.error("GitHub stale lease reconciliation failed", { leaseId: row.leaseId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
