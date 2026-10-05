import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { reapPendingLeases } from "./lease-cleanup.ts";

test("reaps a terminal lease with no create command without dispatching a stop", async () => {
  let dispatches = 0;
  const db = preparedTestDatabase(name => name === "lease_cleanup_candidates"
    ? [{ leaseId: "lease-1", workerId: "worker-1", nonce: "n".repeat(32), cleanupType: null }]
    : name === "lease_cleanup_reap" ? [{ id: "lease-1" }] : []);
  const report = await reapPendingLeases({ db, dispatch: async () => { dispatches += 1; }, workerConnected: () => true });
  expect(report).toEqual({ dispatched: 0, skipped: 0, failed: 0 });
  expect(dispatches).toBe(0);
});

test("skips cleanup dispatch while the worker is disconnected", async () => {
  let dispatches = 0;
  const db = preparedTestDatabase(name => name === "lease_cleanup_candidates"
    ? [{ leaseId: "lease-2", workerId: "worker-2", nonce: "m".repeat(32), cleanupType: "windows-container.stop_lease" }]
    : []);
  const report = await reapPendingLeases({ db, dispatch: async () => { dispatches += 1; }, workerConnected: () => false });
  expect(report).toEqual({ dispatched: 0, skipped: 1, failed: 0 });
  expect(dispatches).toBe(0);
});

test("does not dispatch another stop after a stop was queued or accepted", async () => {
  let dispatches = 0;
  const db = preparedTestDatabase(() => []);
  const report = await reapPendingLeases({ db, dispatch: async () => { dispatches += 1; }, workerConnected: () => true });
  expect(report).toEqual({ dispatched: 0, skipped: 0, failed: 0 });
  expect(dispatches).toBe(0);
});
