import type { DatabaseClient } from "@mars/db";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";

type CleanupLease = { leaseId: string; workerId: string; nonce: string; cleanupType?: "linux-vm.stop_lease" | "tart.stop_lease" | "windows-container.stop_lease" | "hyperv.stop_lease" };
export type LeaseCleanupReport = { dispatched: number; skipped: number; failed: number };

export async function reapPendingLeases(input: {
  db: DatabaseClient;
  dispatch: Pick<WorkerCommandDispatcher, "dispatch">["dispatch"];
  workerConnected: (workerId: string) => boolean;
}): Promise<LeaseCleanupReport> {
  const leases = await input.db<CleanupLease[]>`SELECT l.id AS "leaseId", l.worker_id AS "workerId", l.nonce,
      COALESCE((
        SELECT CASE
          WHEN c.type='linux-vm.create_lease' THEN 'linux-vm.stop_lease'
          WHEN c.type='windows-container.create_lease' THEN 'windows-container.stop_lease'
          WHEN c.type='hyperv.create_lease' THEN 'hyperv.stop_lease'
          WHEN c.type='tart.create_lease' THEN 'tart.stop_lease'
        END
        FROM commands c
        WHERE c.lease_id=l.id AND c.type IN ('linux-vm.create_lease','windows-container.create_lease','hyperv.create_lease','tart.create_lease')
        ORDER BY c.occurred_at ASC LIMIT 1
      )) AS "cleanupType"
    FROM runner_leases l
    WHERE l.state IN ('completed','failed')
      AND l.cleanup_state IN ('pending','failed')
      AND NOT EXISTS (
        SELECT 1 FROM commands c
        WHERE c.lease_id=l.id AND c.type IN ('linux-vm.stop_lease','tart.stop_lease','windows-container.stop_lease','hyperv.stop_lease')
          AND (c.state='pending' OR (c.state='sent' AND c.occurred_at>now()-interval '1 minute'))
      )
    LIMIT 100`;
  const report: LeaseCleanupReport = { dispatched: 0, skipped: 0, failed: 0 };
  for (const lease of leases) {
    if (!lease.cleanupType) {
      const reaped = await input.db`UPDATE runner_leases SET state='reaped', cleanup_state='completed', updated_at=now()
        WHERE id=${lease.leaseId} AND nonce=${lease.nonce}
          AND state IN ('completed','failed')
          AND cleanup_state IN ('pending','failed')
        RETURNING id`;
      if (!reaped[0]) report.skipped += 1;
      continue;
    }
    try {
      await input.dispatch({ type: lease.cleanupType, workerId: lease.workerId, leaseId: lease.leaseId, payload: { nonce: lease.nonce } });
      report.dispatched += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
