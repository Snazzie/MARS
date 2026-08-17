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
  };
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
  await prune("audit", db`DELETE FROM audit_events WHERE created_at < now() - make_interval(days => ${config.audit}) RETURNING id`);
  return results;
}
