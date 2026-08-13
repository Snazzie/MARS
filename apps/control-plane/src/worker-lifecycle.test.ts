import { expect, test } from "bun:test";
import { applyWorkerLeaseEvent, handleAuthenticatedWorkerEvent } from "./worker-lifecycle.ts";

const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const nonce = "n".repeat(32);
const event = (type: string, payload: Record<string, unknown>) => ({ version: 1, id: crypto.randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });

function acceptingDb() {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join(" "), values });
    return [{ id: leaseId }];
  }, {}) as never;
  return { db, calls };
}

test("attests only the matching dispatched worker lease and nonce", async () => {
  const { db, calls } = acceptingDb();
  const accepted = await applyWorkerLeaseEvent(db, event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "whitesmith-job-22222222", observed: { vcpu: 4, memoryBytes: 4_294_967_296, storageBytes: 21_474_836_480 } }));
  expect(accepted).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.query).toContain("state='sandbox_ready'");
  expect(calls[0]!.query).toContain("worker_id=");
  expect(calls[0]!.query).toContain("nonce=");
  expect(calls[0]!.query).toContain("state='dispatched'");
  expect(calls[0]!.values).toContain(workerId);
  expect(calls[0]!.values).toContain(nonce);
});

test("records runner completion and final VM reap monotonically", async () => {
  const completed = acceptingDb();
  expect(await applyWorkerLeaseEvent(completed.db, event("runner.finished", { leaseId, nonce, exitCode: 0 }))).toBe(true);
  expect(completed.calls[0]!.values).toContain("completed");
  expect(completed.calls[0]!.query).toContain("cleanup_state='pending'");

  const reaped = acceptingDb();
  expect(await applyWorkerLeaseEvent(reaped.db, event("lease.reaped", { leaseId, nonce }))).toBe(true);
  expect(reaped.calls[0]!.query).toContain("state='reaped'");
  expect(reaped.calls[0]!.query).toContain("cleanup_state='completed'");
});

test("marks cleanup failure without erasing the terminal runner result", async () => {
  const { db, calls } = acceptingDb();
  expect(await applyWorkerLeaseEvent(db, event("lease.failed", { leaseId, nonce, reason: "cleanup_failed" }))).toBe(true);
  expect(calls[0]!.query).toContain("cleanup_state='failed'");
  expect(calls[0]!.query).not.toContain("terminal_result=");
  expect(calls[0]!.query).toContain("'completed','failed'");
});

test("routes accepted commands through the dispatcher without mutating lease state", async () => {
  const { db, calls } = acceptingDb();
  const dispatched: unknown[] = [];
  const socket = { send() {} };
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent(input, receivedSocket) { dispatched.push(input, receivedSocket); return true; } }, event("command.accepted", { commandId: crypto.randomUUID(), leaseId }), socket);
  expect(accepted).toBe(true);
  expect(dispatched).toEqual([expect.objectContaining({ type: "command.accepted" }), socket]);
  expect(calls).toHaveLength(0);
});

test("persists authenticated lifecycle events independently of command acknowledgement state", async () => {
  const { db, calls } = acceptingDb();
  let dispatchCalls = 0;
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent() { dispatchCalls += 1; return false; } }, event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "vm", observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }), { send() {} });
  expect(accepted).toBe(true);
  expect(dispatchCalls).toBe(0);
  expect(calls).toHaveLength(1);
});

test("accepts a valid stale lifecycle event without closing the authenticated socket", async () => {
  const db = Object.assign(async () => [], {}) as never;
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, event("lease.failed", { leaseId, nonce, reason: "provisioning_failed" }), { send() {} });
  expect(accepted).toBe(true);
});
test("rejects malformed or unauthenticated lifecycle events without touching storage", async () => {
  const { db, calls } = acceptingDb();
  expect(await applyWorkerLeaseEvent(db, event("sandbox_attested", { leaseId, nonce: "short", runtimeInstanceId: "vm", observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }))).toBe(false);
  expect(await applyWorkerLeaseEvent(db, { ...event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "vm", observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }), workerId: "not-a-uuid" })).toBe(false);
  expect(calls).toHaveLength(0);
});
