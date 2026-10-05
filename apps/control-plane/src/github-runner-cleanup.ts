import { GithubJobsClient } from "./github-jobs.ts";

import { and, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";

const queries = defineQueries(db => {
  const queuedCount = db.select({ value: sql<number>`count(*)::int` }).from(schema.dashboardJobs)
    .innerJoin(schema.dashboardRuns, eq(schema.dashboardRuns.id, schema.dashboardJobs.runId))
    .where(and(eq(schema.dashboardRuns.repositoryId, schema.dashboardRepositories.id), eq(schema.dashboardJobs.status, "queued")));
  return {
    tracked: db.select({
      leaseId: schema.runnerLeases.id,
      runnerId: schema.runnerLeases.runnerId,
      installationId: schema.dashboardInstallations.githubInstallationId,
      repository: schema.dashboardRepositories.fullName,
      workerName: schema.workers.name,
    }).from(schema.runnerLeases)
      .innerJoin(schema.dashboardJobs, and(eq(schema.dashboardJobs.githubJobId, schema.runnerLeases.githubJobId), eq(schema.dashboardJobs.organizationId, schema.runnerLeases.organizationId)))
      .innerJoin(schema.dashboardRuns, eq(schema.dashboardRuns.id, schema.dashboardJobs.runId))
      .innerJoin(schema.dashboardRepositories, eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId))
      .innerJoin(schema.dashboardInstallations, eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId))
      .leftJoin(schema.workers, eq(schema.workers.id, schema.runnerLeases.workerId))
      .where(and(isNotNull(schema.runnerLeases.runnerId), eq(schema.runnerLeases.state, "reaped"), eq(schema.runnerLeases.cleanupState, "completed")))
      .limit(sql.placeholder("limit")).prepare("github_runner_cleanup_tracked"),
    clearRunner: db.update(schema.runnerLeases).set({ runnerId: null, updatedAt: sql`now()` })
      .where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.runnerId, sql.placeholder("runnerId")), eq(schema.runnerLeases.state, "reaped")))
      .prepare("github_runner_cleanup_clear"),
    repositories: db.select({
      repository: schema.dashboardRepositories.fullName,
      installationId: schema.dashboardInstallations.githubInstallationId,
      queued: sql<number>`(${queuedCount})`.as("queued"),
    }).from(schema.dashboardRepositories).innerJoin(schema.dashboardInstallations, eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId))
      .where(and(eq(schema.dashboardInstallations.state, "approved"), eq(schema.dashboardRepositories.available, true)))
      .orderBy(desc(queuedCount), schema.dashboardRepositories.fullName).prepare("github_runner_cleanup_repositories"),
    workers: db.select({ name: schema.workers.name, id: schema.workers.id }).from(schema.workers).prepare("github_runner_cleanup_workers"),
    active: db.select({ id: schema.runnerLeases.id }).from(schema.runnerLeases)
      .innerJoin(schema.dashboardJobs, and(eq(schema.dashboardJobs.githubJobId, schema.runnerLeases.githubJobId), eq(schema.dashboardJobs.organizationId, schema.runnerLeases.organizationId)))
      .innerJoin(schema.dashboardRuns, eq(schema.dashboardRuns.id, schema.dashboardJobs.runId))
      .innerJoin(schema.dashboardRepositories, eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId))
      .where(and(eq(schema.dashboardRepositories.fullName, sql.placeholder("repository")), notInArray(schema.runnerLeases.state, ["reaped", "completed", "failed"])))
      .limit(1).prepare("github_runner_cleanup_active"),
    owned: db.select({ id: schema.runnerLeases.id }).from(schema.runnerLeases).where(eq(schema.runnerLeases.runnerId, sql.placeholder("runnerId"))).limit(1).prepare("github_runner_cleanup_owned"),
  };
});

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
  const prepared = queries(input.db);
  const tracked = await prepared.tracked.execute({ limit });
  for (const row of tracked) {
    const [owner, repo] = row.repository.split("/", 2);
    if (input.installationBlocked?.(Number(row.installationId))) continue;
    if (!owner || !repo) continue;
    try {
      await client(Number(row.installationId)).deleteRunner(owner, repo, Number(row.runnerId));
    } catch (error) {
      if (!(error instanceof Error && error.message === "github_404")) {
        result.failed++;
        let runner: Awaited<ReturnType<GithubJobsClient["getRunner"]>> | undefined;
        let inspectionError: string | undefined;
        if (error instanceof Error && error.message === "github_422") {
          try {
            runner = await client(Number(row.installationId)).getRunner(owner, repo, Number(row.runnerId));
          } catch (inspectionFailure) {
            inspectionError = inspectionFailure instanceof Error ? inspectionFailure.message : String(inspectionFailure);
          }
        }
        console.error("GitHub runner cleanup failed", {
          leaseId: row.leaseId,
          runnerId: Number(row.runnerId),
          repository: row.repository,
          error: error instanceof Error ? error.message : String(error),
          githubMessage: error instanceof Error ? error.cause : undefined,
          runner,
          inspectionError,
        });
        continue;
      }
    }
    await prepared.clearRunner.execute({ leaseId: row.leaseId, runnerId: Number(row.runnerId) });
    result.deleted++;
  }
  if (result.failed || result.deleted >= limit) return result;

  // Legacy registrations predate persisted runner IDs. Only reclaim offline runners
  // matching our naming format and a known worker, when no lease for the repo is live.
  const repositories = await prepared.repositories.execute();
  const workers = await prepared.workers.execute();
  const names = new Set(workers.flatMap(worker => [worker.name, worker.id]));
  const preferred = repositories.findIndex(repo => Number(repo.queued) > 0 && !input.installationBlocked?.(Number(repo.installationId)));
  const start = preferred >= 0 ? preferred : legacyCursor % Math.max(1, repositories.length);
  for (let offset = 0; offset < repositories.length; offset++) {
    const index = (start + offset) % repositories.length;
    const repository = repositories[index]!;
    if (input.installationBlocked?.(Number(repository.installationId))) continue;
    const [owner, repo] = repository.repository.split("/", 2);
    if (!owner || !repo) continue;
    const active = await prepared.active.execute({ repository: repository.repository });
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
        const owned = await prepared.owned.execute({ runnerId: runner.id });
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
