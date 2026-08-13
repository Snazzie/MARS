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
