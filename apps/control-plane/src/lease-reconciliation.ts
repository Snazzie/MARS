import { and, eq, inArray, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import { applyGithubJobSnapshot, markGithubJobMissing, type GithubJobSnapshot } from "./runs.ts";
import { GithubJobsClient } from "./github-jobs.ts";
import { isGithubRateLimitError } from "./github-rate-limit.ts";

const queries = defineQueries(db => ({
  markTerminal: db.update(schema.runnerLeases).set({
    state: sql`${sql.placeholder("state")}`,
    terminalResult: sql`${sql.placeholder("terminalResult")}::jsonb`,
    cleanupState: "pending",
    updatedAt: sql`now()`,
  }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), notInArray(schema.runnerLeases.state, ["completed", "failed", "reaped"]))).prepare("lease_reconciliation_mark_terminal"),
  missingActive: db.update(schema.runnerLeases).set({
    state: "failed", cleanupState: "pending", terminalResult: sql`${sql.placeholder("terminalResult")}::jsonb`, updatedAt: sql`now()`,
  }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), notInArray(schema.runnerLeases.state, ["completed", "failed", "reaped"]))).returning({ id: schema.runnerLeases.id }).prepare("lease_reconciliation_missing_active"),
  startupFailure: db.update(schema.runnerLeases).set({
    state: "failed", cleanupState: "pending", terminalResult: sql`${sql.placeholder("terminalResult")}::jsonb`, updatedAt: sql`now()`,
  }).where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")), inArray(schema.runnerLeases.state, ["reserved", "requested", "dispatched", "provisioning", "sandbox_ready"]))).returning({ id: schema.runnerLeases.id }).prepare("lease_reconciliation_startup_failure"),
  staleLeases: db.select({
    leaseId: schema.runnerLeases.id, organizationId: schema.runnerLeases.organizationId, workerId: schema.runnerLeases.workerId,
    nonce: schema.runnerLeases.nonce, leaseState: schema.runnerLeases.state,
    leaseExpired: sql<boolean>`${schema.runnerLeases.expiresAt} < now()`,
    githubJobId: schema.runnerLeases.githubJobId,
    githubRunId: schema.dashboardRuns.githubRunId, githubRunAttempt: schema.dashboardRuns.runAttempt,
    jobStatus: schema.dashboardJobs.status, jobConclusion: schema.dashboardJobs.conclusion,
    githubRepositoryId: schema.dashboardRepositories.githubRepositoryId, repositoryName: schema.dashboardRepositories.name,
    repositoryFullName: schema.dashboardRepositories.fullName, installationId: schema.dashboardInstallations.githubInstallationId,
  }).from(schema.runnerLeases)
    .innerJoin(schema.dashboardJobs, and(eq(schema.dashboardJobs.organizationId, schema.runnerLeases.organizationId), eq(schema.dashboardJobs.githubJobId, schema.runnerLeases.githubJobId)))
    .innerJoin(schema.dashboardRuns, and(eq(schema.dashboardRuns.organizationId, schema.dashboardJobs.organizationId), eq(schema.dashboardRuns.id, schema.dashboardJobs.runId)))
    .innerJoin(schema.dashboardRepositories, and(eq(schema.dashboardRepositories.organizationId, schema.dashboardRuns.organizationId), eq(schema.dashboardRepositories.id, schema.dashboardRuns.repositoryId)))
    .innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.organizationId, schema.dashboardRepositories.organizationId), eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId)))
    .where(and(isNotNull(schema.runnerLeases.githubJobId), or(eq(schema.runnerLeases.state, "sandbox_ready"), and(sql`${schema.runnerLeases.expiresAt} < now()`, notInArray(schema.runnerLeases.state, ["completed", "failed", "reaped"])))))
    .orderBy(schema.runnerLeases.expiresAt).limit(100).prepare("lease_reconciliation_stale_leases"),
  inventory: db.update(schema.runnerLeases).set({
    state: sql`case when ${schema.runnerLeases.state} in ('completed','failed') then 'reaped' else 'failed' end`,
    terminalResult: sql`case when ${schema.runnerLeases.state} in ('completed','failed') then ${schema.runnerLeases.terminalResult} else ${sql.placeholder("terminalResult")}::jsonb end`,
    cleanupState: sql`case when ${schema.runnerLeases.state} in ('completed','failed') then 'completed' else 'pending' end`,
    updatedAt: sql`now()`,
  }).where(and(eq(schema.runnerLeases.workerId, sql.placeholder("workerId")),
    or(inArray(schema.runnerLeases.state, ["dispatched", "provisioning", "sandbox_ready", "online", "busy"]), and(inArray(schema.runnerLeases.state, ["completed", "failed"]), inArray(schema.runnerLeases.cleanupState, ["pending", "failed"]))),
    lte(schema.runnerLeases.updatedAt, sql.placeholder("inventoryObservedAt")),
    sql`not exists (select 1 from jsonb_array_elements_text(${sql.placeholder("activeLeaseIds")}::jsonb) as active(id) where active.id::uuid = ${schema.runnerLeases.id})`))
    .returning({ id: schema.runnerLeases.id }).prepare("lease_reconciliation_inventory"),
  inventoryEmpty: db.update(schema.runnerLeases).set({
    state: sql`case when ${schema.runnerLeases.state} in ('completed','failed') then 'reaped' else 'failed' end`,
    terminalResult: sql`case when ${schema.runnerLeases.state} in ('completed','failed') then ${schema.runnerLeases.terminalResult} else ${sql.placeholder("terminalResult")}::jsonb end`,
    cleanupState: sql`case when ${schema.runnerLeases.state} in ('completed','failed') then 'completed' else 'pending' end`,
    updatedAt: sql`now()`,
  }).where(and(eq(schema.runnerLeases.workerId, sql.placeholder("workerId")),
    or(inArray(schema.runnerLeases.state, ["dispatched", "provisioning", "sandbox_ready", "online", "busy"]), and(inArray(schema.runnerLeases.state, ["completed", "failed"]), inArray(schema.runnerLeases.cleanupState, ["pending", "failed"]))),
    lte(schema.runnerLeases.updatedAt, sql.placeholder("inventoryObservedAt"))))
    .returning({ id: schema.runnerLeases.id }).prepare("lease_reconciliation_inventory_empty"),
}));

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type StaleLeaseRow = {
  leaseId: string;
  organizationId: string;
  workerId: string;
  nonce: string;
  leaseState: string;
  leaseExpired: boolean;
  githubJobId: number | string;
  githubRunId: number | string;
  githubRunAttempt: number | string;
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
  await queries(deps.db).markTerminal.execute({ state, terminalResult: JSON.stringify({ reason: "github_reconciled", conclusion }), leaseId: row.leaseId, nonce: row.nonce });
}
export async function reconcileWorkerInventory(db: DatabaseClient, workerId: string, activeLeaseIds: readonly string[], inventoryObservedAt = new Date().toISOString()): Promise<number> {
  const ids = [...new Set(activeLeaseIds)];
  const args = { workerId, inventoryObservedAt, terminalResult: JSON.stringify({ reason: "worker_inventory_missing" }) };
  const statements = queries(db);
  const rows = ids.length === 0
    ? await statements.inventoryEmpty.execute(args)
    : await statements.inventory.execute({ ...args, activeLeaseIds: JSON.stringify(ids) });
  return rows.length;
}
async function markMissingLease(deps: StaleLeaseReconciliationDeps, row: StaleLeaseRow): Promise<boolean> {
  return deps.db.transaction(async tx => {
    await markGithubJobMissing(tx as unknown as DatabaseClient, {
      organizationId: row.organizationId,
      githubJobId: Number(row.githubJobId),
      observedAt: new Date().toISOString(),
    });
    const updated = await queries(tx as unknown as DatabaseClient).missingActive.execute({
      leaseId: row.leaseId, nonce: row.nonce, terminalResult: JSON.stringify({ reason: "github_job_not_found" }),
    });
    return Boolean(updated[0]);
  });
}

async function failStartupLease(deps: StaleLeaseReconciliationDeps, row: StaleLeaseRow): Promise<boolean> {
  const updated = await queries(deps.db).startupFailure.execute({
    leaseId: row.leaseId, nonce: row.nonce, terminalResult: JSON.stringify({ reason: "startup_timeout" }),
  });
  return Boolean(updated[0]);
}

export async function reconcileExpiredLeasesWithGithub(deps: StaleLeaseReconciliationDeps): Promise<StaleLeaseReconciliationReport> {
  const rows = await queries(deps.db).staleLeases.execute() as StaleLeaseRow[];
  const report: StaleLeaseReconciliationReport = { inspected: rows.length, completed: 0, released: 0, stillActive: 0, skipped: 0 };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.leaseExpired && (row.leaseState === "reserved" || row.leaseState === "requested")) {
      if (await failStartupLease(deps, row)) report.released += 1;
      else report.skipped += 1;
      continue;
    }
    const repository = splitRepository(String(row.repositoryFullName));
    const installationId = Number(row.installationId);
    const githubJobId = Number(row.githubJobId);
    const githubRunId = Number(row.githubRunId);
    const githubRunAttempt = Number(row.githubRunAttempt);
    if (!repository || !Number.isSafeInteger(installationId) || !Number.isSafeInteger(githubJobId) ||
        !Number.isSafeInteger(githubRunId) || !Number.isSafeInteger(githubRunAttempt)) {
      report.skipped += 1;
      continue;
    }
    try {
      const client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
      let job: GithubJobSnapshot;
      try {
        job = await client.getJob(repository.owner, repository.repo, githubJobId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "github_404" || message === "github_410") {
          if (await markMissingLease(deps, row)) report.released += 1;
          else report.skipped += 1;
          continue;
        }
        throw error;
      }
      if (job.id !== githubJobId || job.runId !== githubRunId || job.runAttempt !== githubRunAttempt) throw new Error("github_payload_invalid");
      if (job.status !== "completed") {
        if (row.leaseExpired && (row.leaseState === "dispatched" || row.leaseState === "provisioning" || row.leaseState === "sandbox_ready")) {
          if (await failStartupLease(deps, row)) report.released += 1;
          else report.skipped += 1;
        } else {
          report.stillActive += 1;
        }
        continue;
      }
      const run = await client.getRunAttempt(repository.owner, repository.repo, job.runId, job.runAttempt);
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
      const message = error instanceof Error ? error.message : String(error);
      if (isGithubRateLimitError(error)) {
        report.skipped += rows.length - index;
        break;
      }
      report.skipped += 1;
      console.error("GitHub stale lease reconciliation failed", { leaseId: row.leaseId, error: message });
    }
  }
  return report;
}
