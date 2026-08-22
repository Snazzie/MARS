import type { DatabaseClient } from "@whitesmith/db";
import { jsonParameter } from "@whitesmith/db";
import { applyGithubJobSnapshot, type GithubJobSnapshot } from "./runs.ts";
import { GithubJobsClient } from "./github-jobs.ts";
import { isGithubRateLimitError } from "./github-rate-limit.ts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type StaleLeaseRow = {
  leaseId: string;
  organizationId: string;
  workerId: string;
  nonce: string;
  leaseState: string;
  githubJobId: number | string;
  githubRunId: number | string;
  githubRepositoryId: number | string;
  repositoryName: string;
  repositoryFullName: string;
  installationId: number | string;
  jobStatus: string;
  jobConclusion: string | null;
};

export type StaleLeaseReconciliationReport = {
  inspected: number;
  completed: number;
  released: number;
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
async function markTerminalLease(deps: StaleLeaseReconciliationDeps, row: StaleLeaseRow, conclusion: string | null): Promise<void> {
  const state = terminalLeaseState({ conclusion });
  await deps.db`UPDATE runner_leases SET state=${state}, terminal_result=${jsonParameter(deps.db, { reason: "github_reconciled", conclusion })}::jsonb, cleanup_state='pending', updated_at=now() WHERE id=${row.leaseId} AND nonce=${row.nonce} AND state NOT IN ('completed','failed','reaped')`;
}
export async function reconcileWorkerInventory(db: DatabaseClient, workerId: string, activeLeaseIds: readonly string[]): Promise<number> {
  const ids = [...new Set(activeLeaseIds)];
  const rows = ids.length === 0
    ? await db<Array<{ id: string }>>`
        UPDATE runner_leases
        SET state='failed', terminal_result=${jsonParameter(db, { reason: "worker_inventory_missing" })}::jsonb, cleanup_state='pending', updated_at=now()
        WHERE worker_id=${workerId}
          AND state IN ('dispatched','sandbox_ready','online','busy')
        RETURNING id
      `
    : await db<Array<{ id: string }>>`
        UPDATE runner_leases
        SET state='failed', terminal_result=${jsonParameter(db, { reason: "worker_inventory_missing" })}::jsonb, cleanup_state='pending', updated_at=now()
        WHERE worker_id=${workerId}
          AND state IN ('dispatched','sandbox_ready','online','busy')
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS active(id)
            WHERE active.id::uuid = runner_leases.id
          )
        RETURNING id
      `;
  return rows.length;
}
export async function reconcileExpiredLeasesWithGithub(deps: StaleLeaseReconciliationDeps): Promise<StaleLeaseReconciliationReport> {
  const rows = await deps.db<StaleLeaseRow[]>`
    SELECT l.id AS "leaseId", l.organization_id AS "organizationId", l.worker_id AS "workerId", l.nonce, l.state AS "leaseState",
      l.github_job_id AS "githubJobId", r.github_run_id AS "githubRunId", j.status AS "jobStatus", j.conclusion AS "jobConclusion",
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
  const report: StaleLeaseReconciliationReport = { inspected: rows.length, completed: 0, released: 0, stillActive: 0, skipped: 0 };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.leaseState === "reserved" || row.leaseState === "requested") {
      await deps.db`UPDATE runner_leases SET state='failed', terminal_result=${jsonParameter(deps.db, { reason: "startup_timeout" })}::jsonb, cleanup_state='pending', updated_at=now() WHERE id=${row.leaseId} AND nonce=${row.nonce} AND state IN ('reserved','requested')`;
      report.released += 1;
      continue;
    }
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
      const job = await client.getJob(repository.owner, repository.repo, githubJobId);
      const run = await client.getRunAttempt(repository.owner, repository.repo, job.runId, job.runAttempt);
      if (job.status !== "completed") {
        report.stillActive += 1;
        continue;
      }
      const applied = await applyGithubJobSnapshot({
        installationId,
        repository: { id: Number(row.githubRepositoryId), name: String(row.repositoryName), fullName: String(row.repositoryFullName) },
        run,
        job,
        authoritative: true,
      });
      if (!applied) {
        report.skipped += 1;
        continue;
      }
      await markTerminalLease(deps, row, job.conclusion);
      report.completed += 1;
    } catch (error) {
      if (isGithubRateLimitError(error)) {
        report.skipped += rows.length - index;
        break;
      }
      report.skipped += 1;
      console.error("GitHub stale lease reconciliation failed", { leaseId: row.leaseId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
