import type { DatabaseClient } from "@whitesmith/db";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";

type CleanupLease = { leaseId: string; workerId: string; nonce: string; cleanupType?: "tart.stop_lease" | "windows-container.stop_lease" | "hyperv.stop_lease" };

export async function reapPendingLeases(input: {
  db: DatabaseClient;
  dispatch: Pick<WorkerCommandDispatcher, "dispatch">["dispatch"];
  workerConnected: (workerId: string) => boolean;
}): Promise<LeaseCleanupReport> {
  const leases = await input.db<CleanupLease[]>`SELECT l.id AS "leaseId", l.worker_id AS "workerId", l.nonce,
      COALESCE((
        SELECT CASE
          WHEN c.type='windows-container.create_lease' THEN 'windows-container.stop_lease'
          WHEN c.type='hyperv.create_lease' THEN 'hyperv.stop_lease'
          ELSE 'tart.stop_lease'
        END
        FROM commands c
        WHERE c.lease_id=l.id AND c.type IN ('windows-container.create_lease','hyperv.create_lease','tart.create_lease')
        ORDER BY c.occurred_at ASC LIMIT 1
      ), 'tart.stop_lease') AS "cleanupType"
    FROM runner_leases l
    WHERE l.state IN ('completed','failed')
      AND l.cleanup_state IN ('pending','failed')
      AND NOT EXISTS (
        SELECT 1 FROM commands c
        WHERE c.lease_id=l.id AND c.type IN ('tart.stop_lease','windows-container.stop_lease','hyperv.stop_lease')
          AND (c.state='pending' OR (c.state='sent' AND c.occurred_at>now()-interval '1 minute'))
      )
    LIMIT 100`;
  const report: LeaseCleanupReport = { dispatched: 0, skipped: 0, failed: 0 };
  for (const lease of leases) {
    if (!input.workerConnected(lease.workerId)) {
      report.skipped += 1;
      continue;
    }
    try {
      await input.dispatch({ type: lease.cleanupType ?? "tart.stop_lease", workerId: lease.workerId, leaseId: lease.leaseId, payload: { nonce: lease.nonce } });
      report.dispatched += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
