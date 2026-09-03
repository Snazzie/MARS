import type { DatabaseClient } from "@mars/db";
import { GithubJobsClient } from "./github-jobs.ts";
import { GithubRateLimitError, isGithubRateLimitError } from "./github-rate-limit.ts";
import { applyGithubJobSnapshot, markGithubJobMissing, type GithubJobSnapshot, type GithubRunSnapshot } from "./runs.ts";
import { GITHUB_LOG_FORMAT_VERSION, syncCompletedGithubJobLogs } from "./github-job-log-sync.ts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type DiscoveryDeps = { db: DatabaseClient; installationToken: (installationId: number) => Promise<string>; githubFetchForInstallation: (installationId: number) => Fetcher; repositoryFullName?: string };
export type DiscoveryReport = { repositories: number; discovered: number; updated: number; failed: number };
export async function syncCompletedJobLogsBestEffort(
  jobId: number,
  sync: () => Promise<unknown>,
  onError: (jobId: number, error: string) => void = (id, error) => {
    if (error !== "github_job_logs_not_ready") console.error("GitHub completed job log sync deferred", { jobId: id, error });
  },
): Promise<boolean> {
  try {
    await sync();
    return true;
  } catch (error) {
    onError(jobId, error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function pages<T>(load: (page: number) => Promise<{ totalCount: number; items: T[] }>): Promise<{ items: T[]; complete: boolean }> {
  const result: T[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await load(page);
    result.push(...response.items);
    if (response.items.length === 0) return { items: result, complete: true };
    if (result.length >= response.totalCount) return { items: result, complete: true };
    if (result.length >= 1000) return { items: result, complete: false };
  }
  return { items: result, complete: false };
}
export async function listRunsSinceCompletedCheckpoint(
  load: (page: number) => Promise<{ totalCount: number; runs: GithubRunSnapshot[] }>,
  checkpoint: { runId: number; runAttempt: number } | null,
): Promise<{ runs: GithubRunSnapshot[]; newestCheckpoint: { runId: number; runAttempt: number } | null }> {
  const runs: GithubRunSnapshot[] = [];
  let newestCheckpoint: { runId: number; runAttempt: number } | null = null;
  let consumed = 0;
  for (let page = 1;; page += 1) {
    const response = await load(page);
    consumed += response.runs.length;
    for (const run of response.runs) {
      if (!newestCheckpoint && run.status === "completed") newestCheckpoint = { runId: run.id, runAttempt: run.runAttempt };
      if (checkpoint && run.id === checkpoint.runId && run.runAttempt === checkpoint.runAttempt) return { runs, newestCheckpoint };
      runs.push(run);
    }
    if (checkpoint === null || response.runs.length === 0 || consumed >= response.totalCount) break;
  }
  return { runs, newestCheckpoint };
}

type LocalNonterminalJob = { jobId: number; organizationId?: string; githubRunId: number; runAttempt: number };
const missingGithubError = (error: unknown): boolean => {
  const code = error instanceof Error ? error.message : String(error);
  return code === "github_404" || code === "github_410";
};
const runFallbackForJob = (job: GithubJobSnapshot): GithubRunSnapshot => ({
  id: job.runId,
  runAttempt: job.runAttempt,
  runNumber: job.runId,
  workflowName: "workflow",
  event: "unknown",
  branch: "",
  commitSha: "",
  actorLogin: "github",
  status: job.status,
  conclusion: job.conclusion,
  queuedAt: job.queuedAt,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
});
async function reconcileAbsentJobs(
  deps: DiscoveryDeps,
  client: GithubJobsClient,
  owner: string,
  repo: string,
  row: Record<string, unknown>,
  run: GithubRunSnapshot | null,
  runId: number,
  runAttempt: number,
  returnedIds: Set<number>,
): Promise<{ discovered: number; updated: number }> {
  const localJobs = await deps.db<LocalNonterminalJob[]>`
    SELECT j.github_job_id AS "jobId",r.organization_id AS "organizationId",
      r.github_run_id AS "githubRunId",j.run_attempt AS "runAttempt"
    FROM dashboard_jobs j
    JOIN dashboard_runs r ON r.organization_id=j.organization_id AND r.id=j.run_id
    WHERE r.organization_id=${String(row.organizationId ?? "")}
      AND r.repository_id=${String(row.repositoryId)}
      AND r.github_run_id=${runId}
      AND j.run_attempt=${runAttempt}
      AND j.status <> 'completed'
  `;
  let discovered = 0, updated = 0;
  for (const local of localJobs) {
    if (returnedIds.has(Number(local.jobId))) continue;
    let job: GithubJobSnapshot;
    try {
      job = await client.getJob(owner, repo, Number(local.jobId));
    } catch (error) {
      if (missingGithubError(error)) {
        await markGithubJobMissing(deps.db, {
          organizationId: String(local.organizationId ?? row.organizationId ?? ""),
          githubJobId: Number(local.jobId),
          observedAt: new Date().toISOString(),
        });
        continue;
      }
      throw error;
    }
    if (!run && (job.runId !== runId || job.runAttempt !== runAttempt)) continue;
    discovered += 1;
    const applied = await applyGithubJobSnapshot({
      installationId: Number(row.installationId),
      repository: { id: Number(row.githubRepositoryId), name: String(row.name), fullName: String(row.fullName) },
      run: run ?? runFallbackForJob(job),
      job,
      authoritative: true,
    });
    if (applied) {
      updated += 1;
      if (job.status === "completed") await syncCompletedJobLogsBestEffort(job.id, () => syncCompletedGithubJobLogs({ db: deps.db, client, owner, repo, job }));
    }
  }
  return { discovered, updated };
}


async function discoverRepository(deps: DiscoveryDeps, row: Record<string, unknown>): Promise<{ discovered: number; updated: number }> {
  const fullName = String(row.fullName ?? "");
  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo || fullName.split("/").length !== 2) throw new Error("repository_name_invalid");
  const installationId = Number(row.installationId);
  const client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
  const runs = new Map<string, GithubRunSnapshot>();
  const active = await client.listRuns(owner, repo, undefined, 1);
  for (const run of active.runs) {
    if (run.status === "queued" || run.status === "in_progress") runs.set(`${run.id}:${run.runAttempt}`, run);
  }
  const [checkpoint] = await deps.db`SELECT completed_run_id AS "completedRunId",completed_run_attempt AS "completedRunAttempt" FROM github_discovery_checkpoints WHERE repository_id=${String(row.repositoryId)}`;
  const completed = await listRunsSinceCompletedCheckpoint(
    page => client.listRuns(owner, repo, undefined, page),
    checkpoint?.completedRunId == null || checkpoint?.completedRunAttempt == null ? null : { runId: Number(checkpoint.completedRunId), runAttempt: Number(checkpoint.completedRunAttempt) },
  );
  for (const run of completed.runs) runs.set(`${run.id}:${run.runAttempt}`, run);
  await deps.db`UPDATE dashboard_jobs j SET logs_state='unavailable',logs_synced_at=now(),logs_error='github_logs_expired',logs_version=${GITHUB_LOG_FORMAT_VERSION} FROM dashboard_runs r WHERE j.run_id=r.id AND r.repository_id=${String(row.repositoryId)} AND j.status='completed' AND j.completed_at<now()-interval '90 days' AND j.logs_version<${GITHUB_LOG_FORMAT_VERSION}`;
  const activeLocal = await deps.db`SELECT DISTINCT r.github_run_id AS "runId",r.run_attempt AS "runAttempt" FROM dashboard_runs r WHERE r.repository_id=${String(row.repositoryId)} AND r.status<>'completed'`;
  const logBackfill = await deps.db`SELECT DISTINCT r.github_run_id AS "runId",j.run_attempt AS "runAttempt" FROM dashboard_runs r JOIN dashboard_jobs j ON j.run_id=r.id WHERE r.repository_id=${String(row.repositoryId)} AND j.status='completed' AND j.completed_at>=now()-interval '90 days' AND (j.logs_state='pending' OR j.logs_version<${GITHUB_LOG_FORMAT_VERSION}) ORDER BY r.github_run_id DESC LIMIT 2`;
  let discovered = 0, updated = 0;
  for (const item of [...activeLocal, ...logBackfill]) {
    const runId = Number(item.runId), runAttempt = Number(item.runAttempt);
    if (runId > 0 && runAttempt > 0 && !runs.has(`${runId}:${runAttempt}`)) {
      try {
        const recovered = await client.getRunAttempt(owner, repo, runId, runAttempt);
        runs.set(`${recovered.id}:${recovered.runAttempt}`, recovered);
      } catch (error) {
        if (!missingGithubError(error)) throw error;
        const recoveredJobs = await reconcileAbsentJobs(deps, client, owner, repo, row, null, runId, runAttempt, new Set());
        discovered += recoveredJobs.discovered;
        updated += recoveredJobs.updated;
      }
    }
  }
  for (const run of runs.values()) {
    let listing: { items: GithubJobSnapshot[]; complete: boolean };
    try {
      listing = await pages(async page => {
        const value = await client.listJobs(owner, repo, run.id, run.runAttempt, page);
        return { totalCount: value.totalCount, items: value.jobs };
      });
    } catch (error) {
      if (!missingGithubError(error)) throw error;
      const recoveredJobs = await reconcileAbsentJobs(deps, client, owner, repo, row, run, run.id, run.runAttempt, new Set());
      discovered += recoveredJobs.discovered;
      updated += recoveredJobs.updated;
      continue;
    }
    for (const job of listing.items) {
      discovered += 1;
      const applied = await applyGithubJobSnapshot({ installationId, repository: { id: Number(row.githubRepositoryId), name: String(row.name), fullName }, run, job, authoritative: true });
      if (applied) updated += 1;
      if (applied && job.status === "completed") await syncCompletedJobLogsBestEffort(job.id, () => syncCompletedGithubJobLogs({ db: deps.db, client, owner, repo, job }));
    }
    if (listing.complete) {
      const reconciled = await reconcileAbsentJobs(deps, client, owner, repo, row, run, run.id, run.runAttempt, new Set(listing.items.map(job => job.id)));
      discovered += reconciled.discovered;
      updated += reconciled.updated;
    }
  }
  if (completed.newestCheckpoint !== null) {
    await deps.db`INSERT INTO github_discovery_checkpoints (repository_id,completed_run_id,completed_run_attempt,updated_at) VALUES (${String(row.repositoryId)},${completed.newestCheckpoint.runId},${completed.newestCheckpoint.runAttempt},now()) ON CONFLICT (repository_id) DO UPDATE SET completed_run_id=excluded.completed_run_id,completed_run_attempt=excluded.completed_run_attempt,updated_at=now()`;
  }
  return { discovered, updated };
}
export async function discoverQueuedRepositoryJobs(deps: DiscoveryDeps): Promise<DiscoveryReport> {
  if (!deps.repositoryFullName) return { repositories: 0, discovered: 0, updated: 0, failed: 0 };
  const rows = await deps.db`SELECT repo.id AS "repositoryId",repo.organization_id AS "organizationId",repo.github_repository_id AS "githubRepositoryId",repo.name,repo.full_name AS "fullName",i.github_installation_id AS "installationId" FROM dashboard_repositories repo JOIN dashboard_installations i ON i.id=repo.installation_id AND i.organization_id=repo.organization_id WHERE repo.available=true AND i.state='approved' AND (repo.discovery_retry_at IS NULL OR repo.discovery_retry_at<=now()) AND repo.full_name=${deps.repositoryFullName} ORDER BY repo.full_name`;
  const report: DiscoveryReport = { repositories: rows.length, discovered: 0, updated: 0, failed: 0 };
  for (const row of rows as Record<string, unknown>[]) {
    try {
      const fullName = String(row.fullName ?? "");
      const [owner, repo] = fullName.split("/", 2);
      if (!owner || !repo || fullName.split("/").length !== 2) throw new Error("repository_name_invalid");
      const installationId = Number(row.installationId);
      const client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
      const active = await client.listRuns(owner, repo, undefined, 1);
      const runs = active.runs.filter(run => run.status === "queued" || run.status === "in_progress");
      for (const run of runs) {
        let listing: { items: GithubJobSnapshot[]; complete: boolean };
        try {
          listing = await pages(async page => {
            const value = await client.listJobs(owner, repo, run.id, run.runAttempt, page);
            return { totalCount: value.totalCount, items: value.jobs };
          });
        } catch (error) {
          if (!missingGithubError(error)) throw error;
          const recoveredJobs = await reconcileAbsentJobs(deps, client, owner, repo, row, run, run.id, run.runAttempt, new Set());
          report.discovered += recoveredJobs.discovered;
          report.updated += recoveredJobs.updated;
          continue;
        }
        for (const job of listing.items) {
          report.discovered += 1;
          if (await applyGithubJobSnapshot({ installationId, repository: { id: Number(row.githubRepositoryId), name: String(row.name), fullName }, run, job, authoritative: true })) report.updated += 1;
        }
        if (listing.complete) {
          const reconciled = await reconcileAbsentJobs(deps, client, owner, repo, row, run, run.id, run.runAttempt, new Set(listing.items.map(job => job.id)));
          report.discovered += reconciled.discovered;
          report.updated += reconciled.updated;
        }
      }
    } catch (error) {
      report.failed += 1;
      console.error(`Queued GitHub job discovery failed for ${String(row.fullName)}: ${error instanceof Error ? error.message : "unknown"}`);
      if (isGithubRateLimitError(error)) {
        await deps.db`UPDATE dashboard_repositories SET discovery_error='github_rate_limited',discovery_retry_at=${rateLimitRetryAt(error)} WHERE id=${String(row.repositoryId)}`;
        break;
      }
    }
  }
  return report;
}
function rateLimitRetryAt(error: unknown): string {
  const resetAt = error instanceof GithubRateLimitError
    ? error.resetAt
    : error && typeof error === "object" && typeof (error as { resetAt?: unknown }).resetAt === "number"
      ? (error as { resetAt: number }).resetAt
      : Date.now() + 60_000;
  return new Date(resetAt).toISOString();
}

export async function discoverAvailableRepositoryJobs(deps: DiscoveryDeps): Promise<DiscoveryReport> {
  const rows = deps.repositoryFullName
    ? await deps.db`SELECT repo.id AS "repositoryId",repo.organization_id AS "organizationId",repo.github_repository_id AS "githubRepositoryId",repo.name,repo.full_name AS "fullName",repo.discovery_error AS "discoveryError",repo.discovery_retry_at AS "discoveryRetryAt",i.github_installation_id AS "installationId" FROM dashboard_repositories repo JOIN dashboard_installations i ON i.id=repo.installation_id AND i.organization_id=repo.organization_id WHERE repo.available=true AND i.state='approved' AND (repo.discovery_retry_at IS NULL OR repo.discovery_retry_at<=now()) AND repo.full_name=${deps.repositoryFullName} ORDER BY repo.full_name`
    : await deps.db`SELECT repo.id AS "repositoryId",repo.organization_id AS "organizationId",repo.github_repository_id AS "githubRepositoryId",repo.name,repo.full_name AS "fullName",repo.discovery_error AS "discoveryError",repo.discovery_retry_at AS "discoveryRetryAt",i.github_installation_id AS "installationId" FROM dashboard_repositories repo JOIN dashboard_installations i ON i.id=repo.installation_id AND i.organization_id=repo.organization_id WHERE repo.available=true AND i.state='approved' AND (repo.discovery_retry_at IS NULL OR repo.discovery_retry_at<=now()) ORDER BY repo.full_name`;
  const report: DiscoveryReport = { repositories: rows.length, discovered: 0, updated: 0, failed: 0 };
  const byInstallation = new Map<number, Record<string, unknown>[]>();
  for (const row of rows as Record<string, unknown>[]) {
    const installationId = Number(row.installationId);
    const group = byInstallation.get(installationId);
    if (group) group.push(row);
    else byInstallation.set(installationId, [row]);
  }
  const groups = [...byInstallation.values()];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const group = groups[cursor++];
      if (!group) return;
      for (const row of group) {
        try {
          const value = await discoverRepository(deps, row);
          report.discovered += value.discovered;
          report.updated += value.updated;
          if (row.discoveryError != null || row.discoveryRetryAt != null) {
            await deps.db`UPDATE dashboard_repositories SET discovery_error=NULL,discovery_retry_at=NULL WHERE id=${String(row.repositoryId)} AND (discovery_error IS NOT NULL OR discovery_retry_at IS NOT NULL)`;
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : "unknown";
          report.failed += 1;
          console.error(`GitHub job discovery failed for ${String(row.fullName)}: ${code}`);
          if (isGithubRateLimitError(error)) {
            await deps.db`UPDATE dashboard_repositories SET discovery_error='github_rate_limited',discovery_retry_at=${rateLimitRetryAt(error)} WHERE id=${String(row.repositoryId)}`;
            break;
          }
          if (code === "github_404") {
            await deps.db`UPDATE dashboard_repositories SET available=false WHERE id=${String(row.repositoryId)}`;
            report.failed -= 1;
            continue;
          }
          if (code === "github_403") {
            await deps.db`UPDATE dashboard_repositories SET discovery_error='github_403',discovery_retry_at=now()+interval '24 hours' WHERE id=${String(row.repositoryId)}`;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, worker));
  return report;
}
