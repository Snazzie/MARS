import type { DatabaseClient } from "@whitesmith/db";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";

type CleanupLease = { leaseId: string; workerId: string; nonce: string };
export type LeaseCleanupReport = { dispatched: number; skipped: number; failed: number };

export async function reapPendingLeases(input: {
  db: DatabaseClient;
  dispatch: Pick<WorkerCommandDispatcher, "dispatch">["dispatch"];
  workerConnected: (workerId: string) => boolean;
}): Promise<LeaseCleanupReport> {
  const leases = await input.db<CleanupLease[]>`SELECT l.id AS "leaseId", l.worker_id AS "workerId", l.nonce
    FROM runner_leases l
    WHERE l.state IN ('completed','failed')
      AND l.cleanup_state IN ('pending','failed')
      AND NOT EXISTS (
        SELECT 1 FROM commands c
        WHERE c.lease_id=l.id AND c.type='tart.stop_lease'
          AND (c.state='pending' OR (c.state='sent' AND c.occurred_at>now()-interval '1 minute'))
      )
    ORDER BY l.updated_at
    LIMIT 100`;
  const report: LeaseCleanupReport = { dispatched: 0, skipped: 0, failed: 0 };
  for (const lease of leases) {
    if (!input.workerConnected(lease.workerId)) {
      report.skipped += 1;
      continue;
    }
    try {
      await input.dispatch({ type: "tart.stop_lease", workerId: lease.workerId, leaseId: lease.leaseId, payload: { nonce: lease.nonce } });
      report.dispatched += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
