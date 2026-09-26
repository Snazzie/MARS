import type { DatabaseClient } from "@mars/db";
import { GithubJobsClient } from "./github-jobs.ts";

type Registration = { leaseId: string; runnerId: number; installationId: number; repository: string };
type Repository = { repository: string; installationId: number; queued: number };
const GENERATED_RUNNER = /^(.+)-(windows-x64|windows-arm64|macos-arm64|linux-x64|linux-arm64)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let legacyCursor = 0;

export async function cleanGithubRunners(input: {
  db: DatabaseClient;
  installationToken: (installationId: number) => Promise<string>;
  githubFetchForInstallation: (installationId: number) => (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  installationBlocked?: (installationId: number) => boolean;
  batchSize?: number;
}): Promise<{ deleted: number; failed: number }> {
  const limit = Math.min(20, Math.max(1, input.batchSize ?? 20));
  const result = { deleted: 0, failed: 0 };
  const clients = new Map<number, GithubJobsClient>();
  const client = (installationId: number) => {
    let value = clients.get(installationId);
    if (!value) {
      value = new GithubJobsClient({ token: () => input.installationToken(installationId), fetch: input.githubFetchForInstallation(installationId) });
      clients.set(installationId, value);
    }
    return value;
  };
  const tracked = await input.db<Registration[]>`SELECT l.id AS "leaseId", l.runner_id AS "runnerId", i.github_installation_id AS "installationId", r.full_name AS repository
    FROM runner_leases l JOIN dashboard_jobs j ON j.github_job_id=l.github_job_id AND j.organization_id=l.organization_id
    JOIN dashboard_runs run ON run.id=j.run_id JOIN dashboard_repositories r ON r.id=run.repository_id
    JOIN dashboard_installations i ON i.id=r.installation_id
    WHERE l.runner_id IS NOT NULL AND l.state='reaped' AND l.cleanup_state='completed'
    LIMIT ${limit}`;
  for (const row of tracked) {
    const [owner, repo] = row.repository.split("/", 2);
    if (input.installationBlocked?.(Number(row.installationId))) continue;
    if (!owner || !repo) continue;
    try {
      await client(Number(row.installationId)).deleteRunner(owner, repo, Number(row.runnerId));
    } catch (error) {
      if (!(error instanceof Error && error.message === "github_404")) {
        result.failed++;
        console.error("GitHub runner cleanup failed", { leaseId: row.leaseId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    await input.db`UPDATE runner_leases SET runner_id=NULL, updated_at=now() WHERE id=${row.leaseId} AND runner_id=${row.runnerId} AND state='reaped'`;
    result.deleted++;
  }
  if (result.failed || result.deleted >= limit) return result;

  // Legacy registrations predate persisted runner IDs. Only reclaim offline runners
  // matching our naming format and a known worker, when no lease for the repo is live.
  const repositories = await input.db<Repository[]>`SELECT r.full_name AS repository, i.github_installation_id AS "installationId",
      (SELECT count(*)::int FROM dashboard_jobs j JOIN dashboard_runs run ON run.id=j.run_id WHERE run.repository_id=r.id AND j.status='queued') AS queued
    FROM dashboard_repositories r JOIN dashboard_installations i ON i.id=r.installation_id
    WHERE i.state='approved' AND r.available=true ORDER BY queued DESC, repository`;
  const workers = await input.db<Array<{ name: string; id: string }>>`SELECT name, id FROM workers`;
  const names = new Set(workers.flatMap(worker => [worker.name, worker.id]));
  const preferred = repositories.findIndex(repo => Number(repo.queued) > 0 && !input.installationBlocked?.(Number(repo.installationId)));
  const start = preferred >= 0 ? preferred : legacyCursor % Math.max(1, repositories.length);
  for (let offset = 0; offset < repositories.length; offset++) {
    const index = (start + offset) % repositories.length;
    const repository = repositories[index]!;
    if (input.installationBlocked?.(Number(repository.installationId))) continue;
    const [owner, repo] = repository.repository.split("/", 2);
    if (!owner || !repo) continue;
    const active = await input.db<Array<{ id: string }>>`SELECT l.id FROM runner_leases l
      JOIN dashboard_jobs j ON j.github_job_id=l.github_job_id AND j.organization_id=l.organization_id
      JOIN dashboard_runs run ON run.id=j.run_id JOIN dashboard_repositories r ON r.id=run.repository_id
      WHERE r.full_name=${repository.repository} AND l.state NOT IN ('reaped','completed','failed') LIMIT 1`;
    if (active.length) continue;
    try {
      legacyCursor = index + 1;
      const github = client(Number(repository.installationId));
      const { runners } = await github.listRunners(owner, repo, 1);
      for (const runner of runners) {
        if (result.deleted >= limit) break;
        const match = GENERATED_RUNNER.exec(runner.name);
        if (!match || !names.has(match[1]!) || runner.status !== "offline" || runner.busy || !runner.labels.some(label => label.toLowerCase().startsWith("mars-"))) continue;
        // Persisted registrations are handled above only after their lease is reaped.
        const owned = await input.db<Array<{ id: string }>>`SELECT id FROM runner_leases WHERE runner_id=${runner.id} LIMIT 1`;
        if (owned.length) continue;
        try {
          await github.deleteRunner(owner, repo, runner.id);
          result.deleted++;
        } catch (error) {
          if (error instanceof Error && error.message === "github_404") continue;
          throw error;
        }
      }
      break;
    } catch (error) {
      result.failed++;
      console.error("Legacy GitHub runner cleanup failed", { repository: repository.repository, error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return result;
}
