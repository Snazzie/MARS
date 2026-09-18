import { expect, test } from "bun:test";
import type { DatabaseClient } from "@mars/db";
import { reapPendingLeases } from "./lease-cleanup.ts";

test("reaps a terminal lease with no create command without dispatching a stop", async () => {
  const queries: string[] = [];
  let dispatches = 0;
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.startsWith("SELECT l.id")) {
      return [{ leaseId: "lease-1", workerId: "worker-1", nonce: "n".repeat(32), cleanupType: undefined }];
    }
    if (query.includes("UPDATE runner_leases")) return [{ id: "lease-1" }];
    return [];
  }) as unknown as DatabaseClient;

  const report = await reapPendingLeases({
    db,
    dispatch: async () => { dispatches += 1; },
    workerConnected: () => true,
  });

  expect(report).toEqual({ dispatched: 0, skipped: 0, failed: 0 });
  expect(dispatches).toBe(0);
  expect(queries.some(query => query.includes("UPDATE runner_leases SET state='reaped'") && query.includes("cleanup_state='completed'") && query.includes("nonce="))).toBe(true);
});

test("skips cleanup dispatch while the worker is disconnected", async () => {
  let dispatches = 0;
  const db = (async (strings: TemplateStringsArray) => {
    if (strings.join(" ").startsWith("SELECT l.id")) return [{ leaseId: "lease-2", workerId: "worker-2", nonce: "m".repeat(32), cleanupType: "windows-container.stop_lease" }];
    return [];
  }) as unknown as DatabaseClient;
  const report = await reapPendingLeases({
    db,
    dispatch: async () => { dispatches += 1; },
    workerConnected: () => false,
  });
  expect(report).toEqual({ dispatched: 0, skipped: 1, failed: 0 });
  expect(dispatches).toBe(0);
});

test("does not dispatch another stop after a stop was queued or accepted", async () => {
  let dispatches = 0;
  const queries: string[] = [];
  const db2 = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [];
  }) as unknown as DatabaseClient;

  const report = await reapPendingLeases({
    db: db2,
    dispatch: async () => { dispatches += 1; },
    workerConnected: () => true,
  });

  expect(report).toEqual({ dispatched: 0, skipped: 0, failed: 0 });
  expect(dispatches).toBe(0);
  expect(queries[0]).toContain("c.state IN ('pending','sent','acknowledged')");
  expect(queries[0]).toContain("c.payload->>'nonce'=l.nonce");
});
