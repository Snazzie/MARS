import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import { and, asc, desc, eq, gt, gte, isNull, isNotNull, lte, lt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import YAML from "yaml";
import { GithubJobsClient } from "./github-jobs.ts";
import { GithubRateLimitError, isGithubRateLimitError } from "./github-rate-limit.ts";
import { applyGithubJobSnapshot, markGithubJobMissing, type GithubJobSnapshot, type GithubRunSnapshot } from "./runs.ts";
import { GITHUB_LOG_FORMAT_VERSION, syncCompletedGithubJobLogs } from "./github-job-log-sync.ts";

const queries = defineQueries(db => {
  const r = schema.dashboardRuns, j = schema.dashboardJobs, repo = schema.dashboardRepositories;
  const i = schema.dashboardInstallations, checkpoint = schema.githubDiscoveryCheckpoints;
  const p = sql.placeholder;
  const source = alias(j, "source"), target = alias(j, "target");
  const repositoryId = eq(r.repositoryId, p("repositoryId"));
  const runIdentity = and(eq(r.organizationId, p("organizationId")), eq(r.id, p("runId")), eq(r.runAttempt, p("runAttempt")));
  return {
    graphRun: db.select({ id: r.id, actionGraphResolvedAt: r.actionGraphResolvedAt }).from(r)
      .where(and(eq(r.organizationId, p("organizationId")), repositoryId, eq(r.githubRunId, p("githubRunId")), eq(r.runAttempt, p("runAttempt")))).prepare("discovery_graph_run"),
    lockGraphRun: db.select({ id: r.id }).from(r).where(and(runIdentity, isNull(r.actionGraphResolvedAt))).for("update").prepare("discovery_graph_lock"),
    deleteEdges: db.delete(schema.dashboardActionEdges).where(and(eq(schema.dashboardActionEdges.organizationId, p("organizationId")), eq(schema.dashboardActionEdges.runId, p("runId")))).prepare("discovery_delete_edges"),
    insertEdge: db.insert(schema.dashboardActionEdges).select(db.select({
      organizationId: sql<string>`${p("organizationId")}::uuid`.as("organization_id"), runId: sql<string>`${p("runId")}::uuid`.as("run_id"),
      fromJobId: source.id, toJobId: target.id,
    }).from(source).crossJoin(target).where(and(
      eq(source.organizationId, p("organizationId")), eq(source.runId, p("runId")), eq(source.runAttempt, p("runAttempt")), eq(source.githubJobId, p("from")),
      eq(target.organizationId, p("organizationId")), eq(target.runId, p("runId")), eq(target.runAttempt, p("runAttempt")), eq(target.githubJobId, p("to")),
    ))).onConflictDoNothing().prepare("discovery_insert_edge"),
    resolveGraph: db.update(r).set({ actionGraphResolvedAt: sql`now()` }).where(runIdentity).prepare("discovery_resolve_graph"),
    localJobs: db.select({ jobId: j.githubJobId, organizationId: r.organizationId, githubRunId: r.githubRunId, runAttempt: j.runAttempt }).from(j)
      .innerJoin(r, and(eq(r.organizationId, j.organizationId), eq(r.id, j.runId)))
      .where(and(eq(r.organizationId, p("organizationId")), repositoryId, eq(r.githubRunId, p("githubRunId")), eq(j.runAttempt, p("runAttempt")), ne(j.status, "completed"))).prepare("discovery_local_jobs"),
    checkpoint: db.select({ completedRunId: checkpoint.completedRunId, completedRunAttempt: checkpoint.completedRunAttempt }).from(checkpoint)
      .where(eq(checkpoint.repositoryId, p("repositoryId"))).prepare("discovery_checkpoint"),
    expireLogs: db.update(j).set({ logsState: "unavailable", logsSyncedAt: sql`now()`, logsError: "github_logs_expired", logsVersion: sql`${p("logsVersion")}` }).from(r)
      .where(and(eq(j.runId, r.id), repositoryId, eq(j.status, "completed"), lt(j.completedAt, sql`now()-interval '90 days'`), lt(j.logsVersion, p("logsVersion")))).prepare("discovery_expire_logs"),
    activeRuns: db.selectDistinct({ runId: r.githubRunId, runAttempt: r.runAttempt }).from(r).where(and(repositoryId, ne(r.status, "completed"))).prepare("discovery_active_runs"),
    logBackfill: db.selectDistinct({ runId: r.githubRunId, runAttempt: j.runAttempt }).from(r).innerJoin(j, eq(j.runId, r.id))
      .where(and(repositoryId, eq(j.status, "completed"), gte(j.completedAt, sql`now()-interval '90 days'`), or(eq(j.logsState, "pending"), lt(j.logsVersion, p("logsVersion")))))
      .orderBy(desc(r.githubRunId)).limit(2).prepare("discovery_log_backfill"),
    resolveTrivialGraphs: db.update(r).set({ actionGraphResolvedAt: sql`now()` }).where(and(repositoryId, isNull(r.actionGraphResolvedAt),
      sql`(${db.select({ count: sql<number>`count(*)` }).from(j).where(and(eq(j.organizationId, r.organizationId), eq(j.runId, r.id), eq(j.runAttempt, r.runAttempt)))}) <= 1`,
    )).prepare("discovery_resolve_trivial_graphs"),
    graphBackfill: db.select({ runId: r.githubRunId, runAttempt: r.runAttempt }).from(r).where(and(repositoryId, isNull(r.actionGraphResolvedAt))).orderBy(desc(r.queuedAt)).limit(2).prepare("discovery_graph_backfill"),
    saveCheckpoint: db.insert(checkpoint).values({ repositoryId: p("repositoryId"), completedRunId: p("runId"), completedRunAttempt: p("runAttempt"), updatedAt: sql`now()` })
      .onConflictDoUpdate({ target: checkpoint.repositoryId, set: { completedRunId: sql`excluded.completed_run_id`, completedRunAttempt: sql`excluded.completed_run_attempt`, updatedAt: sql`now()` } }).prepare("discovery_save_checkpoint"),
    repositories: db.select({
      repositoryId: repo.id, organizationId: repo.organizationId, githubRepositoryId: repo.githubRepositoryId, name: repo.name,
      fullName: repo.fullName, discoveryError: repo.discoveryError, discoveryRetryAt: repo.discoveryRetryAt, installationId: i.githubInstallationId,
    }).from(repo).innerJoin(i, and(eq(i.id, repo.installationId), eq(i.organizationId, repo.organizationId)))
      .where(and(eq(repo.available, true), eq(i.state, "approved"), or(isNull(repo.discoveryRetryAt), lte(repo.discoveryRetryAt, sql`now()`)),
        sql`(${p("fullName")}::text IS NULL OR ${repo.fullName}=${p("fullName")}::text)`))
      .orderBy(asc(repo.fullName)).prepare("discovery_repositories"),
    rateLimited: db.update(repo).set({ discoveryError: "github_rate_limited", discoveryRetryAt: sql`${p("retryAt")}::timestamptz` }).where(eq(repo.id, p("repositoryId"))).prepare("discovery_rate_limited"),
    clearError: db.update(repo).set({ discoveryError: null, discoveryRetryAt: null }).where(and(eq(repo.id, p("repositoryId")), or(isNotNull(repo.discoveryError), isNotNull(repo.discoveryRetryAt)))).prepare("discovery_clear_error"),
    unavailable: db.update(repo).set({ available: false }).where(eq(repo.id, p("repositoryId"))).prepare("discovery_unavailable"),
    forbidden: db.update(repo).set({ discoveryError: "github_403", discoveryRetryAt: sql`now()+interval '24 hours'` }).where(eq(repo.id, p("repositoryId"))).prepare("discovery_forbidden"),
  };
});

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type DiscoveryDeps = {
  db: DatabaseClient;
  installationToken: (installationId: number) => Promise<string>;
  githubFetchForInstallation: (installationId: number) => Fetcher;
  repositoryFullName?: string;
  installationBlocked?: (installationId: number) => boolean;
};
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

type WorkflowDependencyEdge = { from: number; to: number };

function jobNameAliases(jobId: string, value: Record<string, unknown>): string[] {
  const aliases = [jobId];
  if (typeof value.name === "string") {
    const staticPrefix = value.name.split("${{", 1)[0]?.trim();
    if (staticPrefix) aliases.push(staticPrefix);
  }
  return aliases;
}

function matchesWorkflowJob(name: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => name === alias || name.startsWith(`${alias} `));
}

export function workflowDependencyEdges(content: string, jobs: readonly Pick<GithubJobSnapshot, "id" | "name">[]): WorkflowDependencyEdge[] {
  const parsed: unknown = YAML.parse(content);
  if (!parsed || typeof parsed !== "object") return [];
  const definitions = (parsed as Record<string, unknown>).jobs;
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) return [];
  const workflowJobs = definitions as Record<string, unknown>;
  const actualByWorkflowJob = new Map<string, number[]>();
  for (const [jobId, raw] of Object.entries(workflowJobs)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const aliases = jobNameAliases(jobId, raw as Record<string, unknown>);
    actualByWorkflowJob.set(jobId, jobs.filter((job) => matchesWorkflowJob(job.name, aliases)).map((job) => job.id));
  }
  const edges = new Map<string, WorkflowDependencyEdge>();
  for (const [jobId, raw] of Object.entries(workflowJobs)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const needsValue = (raw as Record<string, unknown>).needs;
    const needs = typeof needsValue === "string" ? [needsValue] : Array.isArray(needsValue) ? needsValue.filter((value): value is string => typeof value === "string") : [];
    for (const dependency of needs) {
      for (const from of actualByWorkflowJob.get(dependency) ?? []) {
        for (const to of actualByWorkflowJob.get(jobId) ?? []) {
          if (from !== to) edges.set(`${from}:${to}`, { from, to });
        }
      }
    }
  }
  return [...edges.values()];
}

async function syncRunActionGraph(
  deps: DiscoveryDeps,
  client: GithubJobsClient,
  owner: string,
  repo: string,
  row: Record<string, unknown>,
  run: GithubRunSnapshot,
  jobs: readonly GithubJobSnapshot[],
): Promise<void> {
  const organizationId = String(row.organizationId ?? "");
  const [storedRun] = await queries(deps.db).graphRun.execute({ organizationId, repositoryId: String(row.repositoryId), githubRunId: run.id, runAttempt: run.runAttempt });
  if (!storedRun || storedRun.actionGraphResolvedAt) return;
  let edges: WorkflowDependencyEdge[] = [];
  if (jobs.length > 1) {
    const workflowPath = run.workflowPath?.split("@", 1)[0] ?? "";
    if (!/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/.test(workflowPath) || !run.commitSha) return;
    const content = await client.getWorkflowFile(owner, repo, workflowPath, run.commitSha);
    edges = workflowDependencyEdges(content, jobs);
  }
  await deps.db.transaction(async tx => {
    const identity = { organizationId, runId: storedRun.id, runAttempt: run.runAttempt };
    const [lockedRun] = await queries(tx).lockGraphRun.execute(identity);
    if (!lockedRun) return;
    await queries(tx).deleteEdges.execute(identity);
    for (const edge of edges) {
      await queries(tx).insertEdge.execute({ ...identity, from: edge.from, to: edge.to });
    }
    await queries(tx).resolveGraph.execute(identity);
  });
}

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
  const localJobs = await queries(deps.db).localJobs.execute({ organizationId: String(row.organizationId ?? ""), repositoryId: String(row.repositoryId), githubRunId: runId, runAttempt });
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
  const filter = { repositoryId: String(row.repositoryId) };
  const [checkpoint] = await queries(deps.db).checkpoint.execute(filter);
  const completed = await listRunsSinceCompletedCheckpoint(
    page => client.listRuns(owner, repo, undefined, page),
    checkpoint?.completedRunId == null || checkpoint?.completedRunAttempt == null ? null : { runId: Number(checkpoint.completedRunId), runAttempt: Number(checkpoint.completedRunAttempt) },
  );
  for (const run of completed.runs) runs.set(`${run.id}:${run.runAttempt}`, run);
  await queries(deps.db).expireLogs.execute({ ...filter, logsVersion: GITHUB_LOG_FORMAT_VERSION });
  const activeLocal = await queries(deps.db).activeRuns.execute(filter);
  const logBackfill = await queries(deps.db).logBackfill.execute({ ...filter, logsVersion: GITHUB_LOG_FORMAT_VERSION });
  await queries(deps.db).resolveTrivialGraphs.execute(filter);
  const graphBackfill = await queries(deps.db).graphBackfill.execute(filter);
  let discovered = 0, updated = 0;
  for (const item of [...activeLocal, ...logBackfill, ...graphBackfill]) {
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
      await syncRunActionGraph(deps, client, owner, repo, row, run, listing.items);
    }
  }
  if (completed.newestCheckpoint !== null) {
    await queries(deps.db).saveCheckpoint.execute({ ...filter, runId: completed.newestCheckpoint.runId, runAttempt: completed.newestCheckpoint.runAttempt });
  }
  return { discovered, updated };
}

export async function discoverQueuedRepositoryJobs(deps: DiscoveryDeps): Promise<DiscoveryReport> {
  const rows = await queries(deps.db).repositories.execute({ fullName: deps.repositoryFullName || null });
  const report: DiscoveryReport = { repositories: rows.length, discovered: 0, updated: 0, failed: 0 };
  for (const row of rows as Record<string, unknown>[]) {
    try {
      const installationId = Number(row.installationId);
      if (deps.installationBlocked?.(installationId)) {
        console.warn("Queued GitHub job discovery skipped", { repository: row.fullName, installationId, reason: "installation_rate_limited" });
        continue;
      }
      const fullName = String(row.fullName ?? "");
      const [owner, repo] = fullName.split("/", 2);
      if (!owner || !repo || fullName.split("/").length !== 2) throw new Error("repository_name_invalid");
      const client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
      const runs = new Map<string, GithubRunSnapshot>();
      for (const status of ["queued", "pending", "in_progress"] as const) {
        const active = await client.listRuns(owner, repo, status, 1);
        for (const run of active.runs) {
          if (run.status === "queued" || run.status === "in_progress") runs.set(`${run.id}:${run.runAttempt}`, run);
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
          report.discovered += recoveredJobs.discovered;
          report.updated += recoveredJobs.updated;
          continue;
        }
        const queuedJobs: Array<{ jobId: number; queuedAt: string; ingested: boolean }> = [];
        for (const job of listing.items) {
          report.discovered += 1;
          const ingested = await applyGithubJobSnapshot({ installationId, repository: { id: Number(row.githubRepositoryId), name: String(row.name), fullName }, run, job, authoritative: true });
          if (ingested) report.updated += 1;
          if (job.status === "queued") queuedJobs.push({ jobId: job.id, queuedAt: job.queuedAt, ingested });
        }
        if (queuedJobs.length) console.log("Queued GitHub jobs discovered", { repository: fullName, installationId, runId: run.id, runAttempt: run.runAttempt, jobs: queuedJobs });
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
        await queries(deps.db).rateLimited.execute({ repositoryId: String(row.repositoryId), retryAt: rateLimitRetryAt(error) });
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
  const rows = await queries(deps.db).repositories.execute({ fullName: deps.repositoryFullName || null });
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
      if (deps.installationBlocked?.(Number(group[0]?.installationId))) continue;
      for (const row of group) {
        try {
          const value = await discoverRepository(deps, row);
          report.discovered += value.discovered;
          report.updated += value.updated;
          if (row.discoveryError != null || row.discoveryRetryAt != null) {
            await queries(deps.db).clearError.execute({ repositoryId: String(row.repositoryId) });
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : "unknown";
          report.failed += 1;
          console.error(`GitHub job discovery failed for ${String(row.fullName)}: ${code}`);
          if (isGithubRateLimitError(error)) {
            await queries(deps.db).rateLimited.execute({ repositoryId: String(row.repositoryId), retryAt: rateLimitRetryAt(error) });
            break;
          }
          if (code === "github_404") {
            await queries(deps.db).unavailable.execute({ repositoryId: String(row.repositoryId) });
            report.failed -= 1;
            continue;
          }
          if (code === "github_403") {
            await queries(deps.db).forbidden.execute({ repositoryId: String(row.repositoryId) });
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, worker));
  return report;
}
