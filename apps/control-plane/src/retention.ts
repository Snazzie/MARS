import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";
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
  const value = Number(Bun.env[`WHITESMITH_RETENTION_${name}_DAYS`] ?? fallback);
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
  const root = Bun.env.WHITESMITH_DIAGNOSTICS_ROOT ?? join(Bun.env.DATA_ROOT ?? "/var/lib/whitesmith", "diagnostics");
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
export async function pruneExpiredData(db: Sql<{}>, config = retentionConfig()): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  const prune = async (name: string, query: PromiseLike<readonly unknown[]>): Promise<void> => {
    const rows = await query;
    results[name] = rows.length;
  };
  await prune("sessions", db`DELETE FROM sessions WHERE expires_at < now() - make_interval(days => ${config.sessions}) RETURNING id`);
  await prune("webhooks_completed", db`DELETE FROM webhook_deliveries WHERE state='completed' AND received_at < now() - make_interval(days => ${config.webhooksCompleted}) RETURNING delivery_id`);
  await prune("webhooks_failed", db`DELETE FROM webhook_deliveries WHERE state='failed' AND received_at < now() - make_interval(days => ${config.webhooksFailed}) RETURNING delivery_id`);
  await prune("mutations", db`DELETE FROM dashboard_mutations WHERE created_at < now() - make_interval(days => ${config.mutations}) RETURNING organization_id`);
  await prune("invalidations", db`DELETE FROM dashboard_outbox_invalidations WHERE occurred_at < now() - make_interval(days => ${config.invalidations}) RETURNING id`);
  await prune("logs", db`DELETE FROM dashboard_log_chunks WHERE occurred_at < now() - make_interval(days => ${config.logs}) RETURNING organization_id`);
  await prune("job_timings", db`DELETE FROM dashboard_job_timing_snapshots WHERE completed_at < now() - make_interval(days => ${config.jobTimings}) RETURNING organization_id, job_id`);
  await prune("job_resource_samples", db`DELETE FROM dashboard_job_resource_samples WHERE occurred_at < now() - make_interval(days => ${config.jobResourceSamples}) RETURNING organization_id, job_id, occurred_at`);
  await prune("audit", db`DELETE FROM audit_events WHERE created_at < now() - make_interval(days => ${config.audit}) RETURNING id`);
  results.diagnostics = await pruneDiagnosticFiles(config.diagnostics);
  return results;
}
