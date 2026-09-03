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
