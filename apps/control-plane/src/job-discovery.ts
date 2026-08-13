import type { DatabaseClient } from "@whitesmith/db";
import { GithubJobsClient } from "./github-jobs.ts";
import { applyGithubJobSnapshot, type GithubRunSnapshot } from "./runs.ts";

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
  const local = await deps.db`SELECT DISTINCT r.github_run_id AS "runId" FROM dashboard_runs r JOIN dashboard_repositories repo ON repo.id=r.repository_id WHERE repo.id=${String(row.repositoryId)} AND r.status <> 'completed'`;
  for (const item of local) { const runId = Number(item.runId); if (runId > 0 && !runs.has(runId)) runs.set(runId, await client.getRun(owner, repo, runId)); }
  let discovered = 0, updated = 0;
  for (const run of runs.values()) {
    const jobs = await pages(async page => { const value = await client.listJobs(owner, repo, run.id, page); return { totalCount: value.totalCount, items: value.jobs }; });
    for (const job of jobs) { discovered += 1; if (await applyGithubJobSnapshot({ installationId: Number(row.installationId), repository: { id: Number(row.githubRepositoryId), name: String(row.name), fullName }, run, job })) updated += 1; }
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
