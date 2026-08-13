import type { DatabaseClient } from "@whitesmith/db";
import { GithubJobsClient } from "./github-jobs.ts";
import { applyGithubJobSnapshot, type GithubRunSnapshot } from "./runs.ts";
import { GITHUB_LOG_FORMAT_VERSION, syncCompletedGithubJobLogs } from "./github-job-log-sync.ts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type DiscoveryDeps = { db: DatabaseClient; installationToken: (installationId: number) => Promise<string>; githubFetch?: Fetcher; repositoryConcurrency?: number; repositoryFullName?: string };
export type DiscoveryReport = { repositories: number; discovered: number; updated: number; failed: number };

async function pages<T>(load: (page: number) => Promise<{ totalCount: number; items: T[] }>): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await load(page);
    result.push(...response.items);
    if (result.length >= Math.min(response.totalCount, 1000) || response.items.length === 0) break;
  }
  return result;
}
export async function listCompletedRunsSince(
  load: (page: number) => Promise<{ totalCount: number; runs: GithubRunSnapshot[] }>,
  checkpointRunId: number | null,
): Promise<{ runs: GithubRunSnapshot[]; newestRunId: number | null }> {
  const runs: GithubRunSnapshot[] = [];
  let newestRunId: number | null = null;
  let totalCount = 0;
  for (let page = 1; page <= 10; page += 1) {
    const response = await load(page);
    totalCount = response.totalCount;
    newestRunId ??= response.runs[0]?.id ?? null;
    for (const run of response.runs) {
      if (run.id === checkpointRunId) return { runs, newestRunId };
      runs.push(run);
    }
    if (checkpointRunId === null || runs.length >= Math.min(response.totalCount, 1000) || response.runs.length === 0) break;
  }
  if (checkpointRunId !== null && totalCount > 1000 && runs.length >= 1000) {
    throw new Error("completed_run_checkpoint_unreachable");
  }
  return { runs, newestRunId };
}


async function discoverRepository(deps: DiscoveryDeps, row: Record<string, unknown>): Promise<{ discovered: number; updated: number }> {
  const fullName = String(row.fullName ?? "");
  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo || fullName.split("/").length !== 2) throw new Error("repository_name_invalid");
  const client = new GithubJobsClient({ token: () => deps.installationToken(Number(row.installationId)), fetch: deps.githubFetch });
  const runs = new Map<number, GithubRunSnapshot>();
  for (const status of ["queued", "in_progress"] as const) {
    console.error(`GitHub discovery list ${fullName} ${status}`);
    const active = await pages(async page => { const value = await client.listRuns(owner, repo, status, page); return { totalCount: value.totalCount, items: value.runs }; });
    for (const run of active) runs.set(run.id, run);
  }
  const [checkpoint] = await deps.db`SELECT completed_run_id AS "completedRunId" FROM github_discovery_checkpoints WHERE repository_id=${String(row.repositoryId)}`;
  console.error(`GitHub discovery list ${fullName} completed`);
  const completed = await listCompletedRunsSince(
    page => client.listRuns(owner, repo, "completed", page),
    checkpoint?.completedRunId == null ? null : Number(checkpoint.completedRunId),
  );
  for (const run of completed.runs) runs.set(run.id, run);
  await deps.db`UPDATE dashboard_jobs j SET logs_state='unavailable',logs_synced_at=now(),logs_error='github_logs_expired',logs_version=${GITHUB_LOG_FORMAT_VERSION} FROM dashboard_runs r WHERE j.run_id=r.id AND r.repository_id=${String(row.repositoryId)} AND j.status='completed' AND j.completed_at<now()-interval '90 days' AND j.logs_version<${GITHUB_LOG_FORMAT_VERSION}`;
  const activeLocal = await deps.db`SELECT DISTINCT r.github_run_id AS "runId" FROM dashboard_runs r WHERE r.repository_id=${String(row.repositoryId)} AND r.status<>'completed'`;
  const logBackfill = await deps.db`SELECT DISTINCT r.github_run_id AS "runId" FROM dashboard_runs r JOIN dashboard_jobs j ON j.run_id=r.id WHERE r.repository_id=${String(row.repositoryId)} AND j.status='completed' AND j.completed_at>=now()-interval '90 days' AND (j.logs_state='pending' OR j.logs_version<${GITHUB_LOG_FORMAT_VERSION}) ORDER BY r.github_run_id DESC LIMIT 2`;
  for (const item of [...activeLocal, ...logBackfill]) { const runId = Number(item.runId); if (runId > 0 && !runs.has(runId)) runs.set(runId, await client.getRun(owner, repo, runId)); }
  let discovered = 0, updated = 0;
  for (const run of runs.values()) {
    const jobs = await pages(async page => { const value = await client.listJobs(owner, repo, run.id, page); return { totalCount: value.totalCount, items: value.jobs }; });
    for (const job of jobs) {
      discovered += 1;
      const applied = await applyGithubJobSnapshot({ installationId: Number(row.installationId), repository: { id: Number(row.githubRepositoryId), name: String(row.name), fullName }, run, job });
      if (applied) updated += 1;
      if (applied && job.status === "completed") await syncCompletedGithubJobLogs({ db: deps.db, client, owner, repo, job });
    }
  }
  if (completed.newestRunId !== null) {
    await deps.db`INSERT INTO github_discovery_checkpoints (repository_id,completed_run_id,updated_at) VALUES (${String(row.repositoryId)},${completed.newestRunId},now()) ON CONFLICT (repository_id) DO UPDATE SET completed_run_id=excluded.completed_run_id,updated_at=excluded.updated_at`;
  }
  return { discovered, updated };
}

export async function discoverApprovedRepositoryJobs(deps: DiscoveryDeps): Promise<DiscoveryReport> {
  const rows = deps.repositoryFullName
    ? await deps.db`SELECT repo.id AS "repositoryId",repo.github_repository_id AS "githubRepositoryId",repo.name,repo.full_name AS "fullName",i.github_installation_id AS "installationId" FROM dashboard_repositories repo JOIN dashboard_installations i ON i.id=repo.installation_id AND i.organization_id=repo.organization_id WHERE repo.available=true AND repo.approved=true AND i.state='approved' AND repo.full_name=${deps.repositoryFullName} ORDER BY repo.full_name`
    : await deps.db`SELECT repo.id AS "repositoryId",repo.github_repository_id AS "githubRepositoryId",repo.name,repo.full_name AS "fullName",i.github_installation_id AS "installationId" FROM dashboard_repositories repo JOIN dashboard_installations i ON i.id=repo.installation_id AND i.organization_id=repo.organization_id WHERE repo.available=true AND repo.approved=true AND i.state='approved' ORDER BY repo.full_name`;
  const report: DiscoveryReport = { repositories: rows.length, discovered: 0, updated: 0, failed: 0 };
  const concurrency = Math.max(1, Math.min(4, deps.repositoryConcurrency ?? 4));
  let cursor = 0;
  const worker = async () => { for (;;) { const index = cursor++; if (index >= rows.length) return; try { const value = await discoverRepository(deps, rows[index] as Record<string, unknown>); report.discovered += value.discovered; report.updated += value.updated; } catch (error) { report.failed += 1; console.error(`GitHub job discovery failed for ${String(rows[index].fullName)}: ${error instanceof Error ? error.message : "unknown"}`); } } };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return report;
}
