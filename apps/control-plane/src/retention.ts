import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, lt, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
const queries = defineQueries(db => ({
  sessions: db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`)).returning({ id: schema.sessions.id }).prepare("retention_sessions"),
  webhookCompleted: db.delete(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.state, "completed"), lt(schema.webhookDeliveries.receivedAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`))).returning({ id: schema.webhookDeliveries.deliveryId }).prepare("retention_webhooks_completed"),
  webhookFailed: db.delete(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.state, "failed"), lt(schema.webhookDeliveries.receivedAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`))).returning({ id: schema.webhookDeliveries.deliveryId }).prepare("retention_webhooks_failed"),
  mutations: db.delete(schema.dashboardMutations).where(lt(schema.dashboardMutations.createdAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`)).returning({ id: schema.dashboardMutations.organizationId }).prepare("retention_mutations"),
  invalidations: db.delete(schema.dashboardOutboxInvalidations).where(lt(schema.dashboardOutboxInvalidations.occurredAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`)).returning({ id: schema.dashboardOutboxInvalidations.id }).prepare("retention_invalidations"),
  logs: db.delete(schema.dashboardLogChunks).where(lt(schema.dashboardLogChunks.occurredAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`)).returning({ id: schema.dashboardLogChunks.organizationId }).prepare("retention_logs"),
  timings: db.delete(schema.dashboardJobTimingSnapshots).where(lt(schema.dashboardJobTimingSnapshots.completedAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`)).returning({ organizationId: schema.dashboardJobTimingSnapshots.organizationId, jobId: schema.dashboardJobTimingSnapshots.jobId }).prepare("retention_job_timings"),
  samples: db.delete(schema.dashboardJobResourceSamples).where(lt(schema.dashboardJobResourceSamples.occurredAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`)).returning({ organizationId: schema.dashboardJobResourceSamples.organizationId, jobId: schema.dashboardJobResourceSamples.jobId, occurredAt: schema.dashboardJobResourceSamples.occurredAt }).prepare("retention_job_resource_samples"),
  audit: db.delete(schema.auditEvents).where(lt(schema.auditEvents.createdAt, sql`now() - make_interval(days => ${sql.placeholder("days")})`)).returning({ id: schema.auditEvents.id }).prepare("retention_audit"),
}));
type RetentionConfig = {
  sessions: number;
  webhooksCompleted: number;
  webhooksFailed: number;
  mutations: number;
  invalidations: number;
  logs: number;
  audit: number;
  jobTimings: number;
  jobResourceSamples: number;
  diagnostics: number;
};

const days = (name: string, fallback: number): number => {
  const value = Number(Bun.env[`MARS_RETENTION_${name}_DAYS`] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export function retentionConfig(): RetentionConfig {
  return {
    sessions: days("SESSIONS", 1),
    webhooksCompleted: days("WEBHOOKS_COMPLETED", 30),
    webhooksFailed: days("WEBHOOKS_FAILED", 90),
    mutations: days("MUTATIONS", 7),
    invalidations: days("INVALIDATIONS", 1),
    logs: days("LOGS", 90),
    audit: days("AUDIT", 365),
    jobTimings: days("JOB_TIMINGS", 90),
    jobResourceSamples: days("JOB_RESOURCE_SAMPLES", 7),
    diagnostics: days("DIAGNOSTICS", 3),
  };
}


async function pruneDiagnosticFiles(daysToKeep: number): Promise<number> {
  const root = Bun.env.MARS_DIAGNOSTICS_ROOT ?? join(Bun.env.DATA_ROOT ?? "/var/lib/mars", "diagnostics");
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1_000;
  let removed = 0;
  for (const worker of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!worker.isDirectory()) continue;
    const workerPath = join(root, worker.name);
    for (const diagnostic of await readdir(workerPath, { withFileTypes: true }).catch(() => [])) {
      if (!diagnostic.isDirectory()) continue;
      const diagnosticPath = join(workerPath, diagnostic.name);
      const info = await stat(diagnosticPath).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await rm(diagnosticPath, { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return removed;
}
export async function pruneExpiredData(db: DatabaseClient, config = retentionConfig()): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  const prepared = queries(db);
  results.sessions = (await prepared.sessions.execute({ days: config.sessions })).length;
  results.webhooks_completed = (await prepared.webhookCompleted.execute({ days: config.webhooksCompleted })).length;
  results.webhooks_failed = (await prepared.webhookFailed.execute({ days: config.webhooksFailed })).length;
  results.mutations = (await prepared.mutations.execute({ days: config.mutations })).length;
  results.invalidations = (await prepared.invalidations.execute({ days: config.invalidations })).length;
  results.logs = (await prepared.logs.execute({ days: config.logs })).length;
  results.job_timings = (await prepared.timings.execute({ days: config.jobTimings })).length;
  results.job_resource_samples = (await prepared.samples.execute({ days: config.jobResourceSamples })).length;
  results.audit = (await prepared.audit.execute({ days: config.audit })).length;
  results.diagnostics = await pruneDiagnosticFiles(config.diagnostics);
  return results;
}
