import { and, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";

const queries = defineQueries(db => ({
  candidates: db.select({
    leaseId: schema.runnerLeases.id, workerId: schema.runnerLeases.workerId, workerName: schema.workers.name, nonce: schema.runnerLeases.nonce,
    cleanupType: sql<CleanupLease["cleanupType"]>`(select case
      when ${schema.commands.type}='linux-vm.create_lease' then 'linux-vm.stop_lease'
      when ${schema.commands.type}='linux-container.create_lease' then 'linux-container.stop_lease'
      when ${schema.commands.type}='windows-container.create_lease' then 'windows-container.stop_lease'
      when ${schema.commands.type}='hyperv.create_lease' then 'hyperv.stop_lease'
      when ${schema.commands.type}='tart.create_lease' then 'tart.stop_lease'
    end from ${schema.commands} where ${schema.commands.leaseId}=${schema.runnerLeases.id}
      and ${inArray(schema.commands.type, ["linux-vm.create_lease", "linux-container.create_lease", "windows-container.create_lease", "hyperv.create_lease", "tart.create_lease"])}
      order by ${schema.commands.occurredAt} asc limit 1)`,
  }).from(schema.runnerLeases).leftJoin(schema.workers, eq(schema.workers.id, schema.runnerLeases.workerId))
    .where(and(inArray(schema.runnerLeases.state, ["completed", "failed"]), inArray(schema.runnerLeases.cleanupState, ["pending", "failed"]),
      sql`not exists (select 1 from ${schema.commands} where ${schema.commands.leaseId}=${schema.runnerLeases.id}
        and ${inArray(schema.commands.type, ["linux-vm.stop_lease", "linux-container.stop_lease", "tart.stop_lease", "windows-container.stop_lease", "hyperv.stop_lease"])}
        and ${schema.commands.payload}->>'nonce'=${schema.runnerLeases.nonce}
        and ${inArray(schema.commands.state, ["pending", "sent", "acknowledged"])})`))
    .limit(100).prepare("lease_cleanup_candidates"),
  reap: db.update(schema.runnerLeases).set({ state: "reaped", cleanupState: "completed", updatedAt: sql`now()` })
    .where(and(eq(schema.runnerLeases.id, sql.placeholder("leaseId")), eq(schema.runnerLeases.nonce, sql.placeholder("nonce")),
      inArray(schema.runnerLeases.state, ["completed", "failed"]), inArray(schema.runnerLeases.cleanupState, ["pending", "failed"])))
    .returning({ id: schema.runnerLeases.id }).prepare("lease_cleanup_reap"),
}));

type CleanupLease = { leaseId: string; workerId: string; workerName?: string; nonce: string; cleanupType?: "linux-vm.stop_lease" | "linux-container.stop_lease" | "tart.stop_lease" | "windows-container.stop_lease" | "hyperv.stop_lease" };
export type LeaseCleanupReport = { dispatched: number; skipped: number; failed: number };

export async function reapPendingLeases(input: {
  db: DatabaseClient;
  dispatch: (command: { type: string; workerId: string; leaseId: string; payload: Record<string, unknown> }) => Promise<unknown>;
  workerConnected: (workerId: string) => boolean;
}): Promise<LeaseCleanupReport> {
  const leases = await queries(input.db).candidates.execute() as CleanupLease[];
  const report: LeaseCleanupReport = { dispatched: 0, skipped: 0, failed: 0 };
  for (const lease of leases) {
    if (!lease.cleanupType) {
      const reaped = await queries(input.db).reap.execute({ leaseId: lease.leaseId, nonce: lease.nonce });
      if (!reaped[0]) report.skipped += 1;
      continue;
    }
    if (!input.workerConnected(lease.workerId)) {
      report.skipped += 1;
      continue;
    }
    try {
      await input.dispatch({ type: lease.cleanupType, workerId: lease.workerId, leaseId: lease.leaseId, payload: { nonce: lease.nonce } });
      console.log("Lease cleanup dispatched", { leaseId: lease.leaseId, workerId: lease.workerId, workerName: lease.workerName, commandType: lease.cleanupType });
      report.dispatched += 1;
    } catch (error) {
      console.error("Lease cleanup dispatch failed", { leaseId: lease.leaseId, workerId: lease.workerId, workerName: lease.workerName, commandType: lease.cleanupType, error: error instanceof Error ? error.message : String(error) });
      report.failed += 1;
    }
  }
  return report;
}
