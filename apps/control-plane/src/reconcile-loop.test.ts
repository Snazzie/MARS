import { expect, jest, test } from "bun:test";
import { startImmediateCron, startReconciliationScheduler } from "./reconcile-loop.ts";

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
test("reports the active timer and queues a single pass while dispatch is busy", async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = startReconciliationScheduler(async () => { if (++runs === 1) await gate; }, 60_000);
  try {
    expect(scheduler.status()).toMatchObject({ running: true, pending: false, intervalMs: 60_000 });
    expect(scheduler.status().nextTickAt).toBeGreaterThan(Date.now());
    const next = scheduler.trigger();
    expect(scheduler.status()).toMatchObject({ running: true, pending: true });
    release();
    await next;
    expect(runs).toBe(2);
    expect(scheduler.status().pending).toBe(false);
  } finally {
    scheduler.stop();
  }
  expect(scheduler.status().nextTickAt).toBeNull();
});
test("queued discovery starts immediately, never overlaps, and does not block dispatch", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-29T12:00:00Z"));
  let releaseDiscovery!: () => void;
  const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
  let discoveries = 0, dispatches = 0;
  const dispatch = startReconciliationScheduler(async () => { dispatches += 1; }, 60_000);
  const discovery = startImmediateCron("*/5 * * * *", async () => {
    discoveries += 1;
    if (discoveries === 1) await discoveryGate;
  });
  try {
    expect(discoveries).toBe(1);
    jest.advanceTimersByTime(5 * 60_000);
    await dispatch.trigger();
    expect(dispatches).toBeGreaterThan(1);
    expect(discoveries).toBe(1);
    releaseDiscovery();
    await discoveryGate;
    await Promise.resolve();
    jest.advanceTimersByTime(5 * 60_000);
    expect(discoveries).toBe(2);
  } finally {
    releaseDiscovery();
    dispatch.stop();
    discovery.stop();
    jest.useRealTimers();
  }
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
  expect(queries[0]).toContain("c.state IN ('pending','sent','acknowledged')");
  expect(queries[0]).not.toContain("interval '1 minute'");
  expect(commands).toEqual([{
    type: "tart.stop_lease",
    workerId: "11111111-1111-4111-8111-111111111111",
    leaseId: "22222222-2222-4222-8222-222222222222",
    payload: { nonce: "n".repeat(32) },
  }]);
});
test("can delay the initial reconciliation while trigger remains immediate", async () => {
  let calls = 0;
  const scheduler = startReconciliationScheduler(async () => { calls += 1; }, 10, false);
  expect(calls).toBe(0);
  await scheduler.trigger();
  expect(calls).toBe(1);
  scheduler.stop();
});
