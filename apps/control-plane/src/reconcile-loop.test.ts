import { expect, test } from "bun:test";
import { startReconciliationScheduler } from "./reconcile-loop.ts";

test("runs immediately, prevents overlap, and stops future ticks", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = startReconciliationScheduler(async () => { calls += 1; await gate; }, 5);
  expect(calls).toBe(1);
  scheduler.stop();
  release();
  expect(calls).toBe(1);
});
test("runs a requested reconciliation immediately after startup", async () => {
  let calls = 0;
  const scheduler = startReconciliationScheduler(async () => { calls += 1; }, 60_000);
  expect(calls).toBe(1);
  await scheduler.trigger();
  expect(calls).toBe(2);
  scheduler.stop();
});
test("dispatches durable cleanup for terminal leases without an outstanding stop command", async () => {
  const modulePath = "./lease-cleanup.ts";
  const cleanup = await import(modulePath).catch(() => null) as null | {
    reapPendingLeases: (input: {
      db: unknown;
      dispatch: (command: unknown) => Promise<unknown>;
      workerConnected: (workerId: string) => boolean;
    }) => Promise<{ dispatched: number; skipped: number; failed: number }>;
  };
  expect(cleanup?.reapPendingLeases).toBeFunction();
  if (!cleanup) return;
  const queries: string[] = [];
  const db = Object.assign(async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [{ leaseId: "22222222-2222-4222-8222-222222222222", workerId: "11111111-1111-4111-8111-111111111111", nonce: "n".repeat(32), cleanupType: "tart.stop_lease" }];
  }, {});
  const commands: unknown[] = [];
  const report = await cleanup.reapPendingLeases({
    db,
    workerConnected: () => true,
    dispatch: async command => { commands.push(command); return {}; },
  });
  expect(report).toEqual({ dispatched: 1, skipped: 0, failed: 0 });
  expect(queries[0]).toContain("NOT EXISTS");
  expect(queries[0]).toContain("c.state='sent' AND c.occurred_at>now()-interval '1 minute'");
  expect(commands).toEqual([{
    type: "tart.stop_lease",
    workerId: "11111111-1111-4111-8111-111111111111",
    leaseId: "22222222-2222-4222-8222-222222222222",
    payload: { nonce: "n".repeat(32) },
  }]);
});
