import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorkerLeaseEvent, handleAuthenticatedWorkerEvent, timingDurations } from "./worker-lifecycle.ts";

const workerId = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
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
  const accepted = await applyWorkerLeaseEvent(db, event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "mars-job-22222222", observed: { vcpu: 4, memoryBytes: 4_294_967_296, storageBytes: 21_474_836_480 } }));
  expect(accepted).toBe(true);
  expect(calls[0]!.query).toContain("state='sandbox_ready'");
  expect(calls[0]!.query).toContain("worker_id=");
  expect(calls[0]!.query).toContain("nonce=");
  expect(calls[0]!.query).toContain("state='dispatched'");
  expect(calls[0]!.values).toContain(workerId);
  expect(calls[0]!.values).toContain(nonce);
});
test("sandbox attestation marks the dashboard job and run in progress", async () => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join(" "), values });
    return [{ id: leaseId, organizationId: "org-1", runId: "run-1", jobId: "job-1" }];
  }, {}) as never;
  await applyWorkerLeaseEvent(db, event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "vm", observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }));
  expect(calls.some(({ query, values }) => query.includes("UPDATE dashboard_jobs") && values.includes("in_progress"))).toBe(true);
  expect(calls.some(({ query, values }) => query.includes("UPDATE dashboard_runs") && values.includes("in_progress"))).toBe(true);
  expect(calls.some(({ query }) => query.includes("expires_at=GREATEST"))).toBe(true);
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
test("maps a nonzero runner exit to a failed terminal lease", async () => {
  const failed = acceptingDb();
  expect(await applyWorkerLeaseEvent(failed.db, event("runner.finished", { leaseId, nonce, exitCode: 17 }))).toBe(true);
  expect(failed.calls[0]!.values).toContain("failed");
  expect(failed.calls[0]!.values).toContainEqual({ exitCode: 17 });
});


test("marks cleanup failure without erasing the terminal runner result", async () => {
  const { db, calls } = acceptingDb();
  expect(await applyWorkerLeaseEvent(db, event("lease.failed", { leaseId, nonce, reason: "cleanup_failed" }))).toBe(true);
  expect(calls[0]!.query).toContain("cleanup_state='failed'");
  expect(calls[0]!.query).not.toContain("terminal_result=");
  expect(calls[0]!.query).toContain("'completed','failed'");
});

test("marks debug-preserved leases without scheduling cleanup", async () => {
  const { db, calls } = acceptingDb();
  expect(await applyWorkerLeaseEvent(db, event("lease.failed", { leaseId, nonce, reason: "debug_preserve" }))).toBe(true);
  expect(calls[0]!.query).toContain("cleanup_state='debug_preserved'");
  expect(calls[0]!.query).not.toContain("cleanup_state='pending'");
});
test("computes bounded completed-job phase durations", () => {
  expect(timingDurations({
    queuedAt: "2026-08-16T00:00:00.000Z",
    startedAt: "2026-08-16T00:00:02.000Z",
    completedAt: "2026-08-16T00:00:10.000Z",
    allocationStartedAt: "2026-08-16T00:00:01.000Z",
    sandboxReadyAt: "2026-08-16T00:00:03.000Z",
    reapingStartedAt: "2026-08-16T00:00:10.000Z",
    reapedAt: "2026-08-16T00:00:11.000Z",
  })).toEqual({ queueDurationMs: 2000, startupDurationMs: 2000, executionDurationMs: 7000, cleanupDurationMs: 1000, totalDurationMs: 10000 });
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
test("routes authenticated worker cache telemetry to durable cache storage", async () => {
  const { db, calls } = acceptingDb();
  const generation = crypto.randomUUID();
  const dispatched: unknown[] = [];
  const accepted = await handleAuthenticatedWorkerEvent(
    db,
    { handleEvent(input) { dispatched.push(input); return true; } },
    event("worker.cache_entry_upsert", {
      generation,
      entry: {
        entryId: crypto.randomUUID(),
        githubRepositoryId: "123456789012345",
        cacheKeyPreview: "build-linux",
        cacheKeyHash: "a".repeat(64),
        scopePreview: "refs/heads/main",
        scopeHash: "b".repeat(64),
        versionHash: "c".repeat(64),
        sizeBytes: "9007199254740993",
        createdAt: "2026-08-23T12:00:00.000Z",
        lastAccessedAt: "2026-08-23T12:01:00.000Z",
        expiresAt: "2026-08-25T12:01:00.000Z",
      },
    }),
    { send() {} },
  );
  expect(accepted).toBe(true);
  expect(dispatched).toHaveLength(0);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  const insert = calls.find((call) => call.query.includes("INSERT INTO worker_cache_entries"));
  expect(insert?.query).toContain("INSERT INTO worker_cache_entries");
  expect(insert?.values).toContain(workerId);
});
test("routes authenticated runner cache status telemetry to durable status columns", async () => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    calls.push({ query, values });
    return query.includes("SELECT generation FROM worker_cache_status") ? [{ generation }] : [];
  }, {}) as never;
  db.begin = async (fn: (tx: typeof db) => unknown) => fn(db);
  const accepted = await handleAuthenticatedWorkerEvent(
    db,
    { handleEvent() { return false; } },
    event("worker.runner_cache_status", { generation, enabled: true, maxGiB: 20, sizeBytes: "123", entryCount: 1, observedAt: new Date().toISOString() }),
    { send() {} },
  );
  expect(accepted).toBe(true);
  expect(calls.some(({ query }) => query.includes("UPDATE worker_cache_status SET runner_cache_enabled"))).toBe(true);
});
test("accepts cache snapshot telemetry frames", async () => {
  const base = acceptingDb();
  const db = Object.assign(base.db, { begin: async (fn: (tx: typeof base.db) => unknown) => fn(base.db) }) as typeof base.db;
  const accepted = await handleAuthenticatedWorkerEvent(
    db,
    { handleEvent() { return false; } },
    event("worker.cache_snapshot_begin", {
      snapshotId: crypto.randomUUID(),
      status: {
        generation: crypto.randomUUID(),
        ready: true,
        ttlSeconds: 3600,
        proxyOrigin: "http://proxy.example.test",
        cacheBaseUrl: "https://cache.example.test",
        sizeBytes: "0",
        entryCount: 0,
        observedAt: new Date().toISOString(),
        error: null,
      },
    }),
    { send() {} },
  );
  expect(accepted).toBe(true);
});


test("persists authenticated lifecycle events independently of command acknowledgement state", async () => {
  const { db, calls } = acceptingDb();
  let dispatchCalls = 0;
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent() { dispatchCalls += 1; return false; } }, event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "vm", observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }), { send() {} });
  expect(accepted).toBe(true);
  expect(dispatchCalls).toBe(0);
  expect(calls.length).toBeGreaterThanOrEqual(1);
});

test("accepts a valid stale lifecycle event without closing the authenticated socket", async () => {
  const db = Object.assign(async () => [], {}) as never;
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, event("lease.failed", { leaseId, nonce, reason: "provisioning_failed" }), { send() {} });
  expect(accepted).toBe(true);
});
test("acknowledges a durable stop command when its reaped event arrives", async () => {
  const { db } = acceptingDb();
  const commandId = crypto.randomUUID();
  const dispatched: unknown[] = [];
  const socket = { send() {} };
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent(input, receivedSocket) { dispatched.push(input, receivedSocket); return true; } }, event("lease.reaped", { commandId, leaseId, nonce }), socket);
  expect(accepted).toBe(true);
  expect(dispatched).toEqual([expect.objectContaining({ type: "lease.reaped", payload: expect.objectContaining({ commandId }) }), socket]);
});
test("rejects malformed or unauthenticated lifecycle events without touching storage", async () => {
  const { db, calls } = acceptingDb();
  expect(await applyWorkerLeaseEvent(db, event("sandbox_attested", { leaseId, nonce: "short", runtimeInstanceId: "vm", observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }))).toBe(false);
  expect(await applyWorkerLeaseEvent(db, { ...event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "vm", observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }), workerId: "not-a-uuid" })).toBe(false);
  expect(calls).toHaveLength(0);
});

test("persists attributed and unattributed log chunks idempotently and rejects unknown steps", async () => {
  const stepId = "33333333-3333-4333-8333-333333333333";
  const jobId = "44444444-4444-4444-8444-444444444444";
  const calls: string[] = [];
  let lookup = 0;
  const db = Object.assign(async (strings: TemplateStringsArray) => {
    calls.push(strings.join(" "));
    lookup += 1;
    return lookup === 1 ? [{ organizationId: "org", runId: "run", jobId }] : [{ id: stepId }];
  }, {}) as never;
  const attributed = event("job.log", { jobId, stepId, sequence: 0, content: "safe", occurredAt: new Date().toISOString() });
  expect(await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, attributed, { send() {} })).toBe(true);
  expect(calls.at(-1)).toContain("dashboard_step_log_chunks");
  const unattributed = event("job.log", { jobId, stepId: null, sequence: 1, content: "fallback", occurredAt: new Date().toISOString() });
  expect(await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, unattributed, { send() {} })).toBe(true);

  expect(calls.at(-1)).toContain("dashboard_log_chunks");
  const unknownDb = Object.assign(async (_strings: TemplateStringsArray, ..._values: unknown[]) => (calls.length < 0 ? [{ organizationId: "org", runId: "run", jobId }] : []), {}) as never;
  expect(await handleAuthenticatedWorkerEvent(unknownDb, { handleEvent() { return false; } }, attributed, { send() {} })).toBe(false);
});

test("persists authenticated diagnostic chunks under the configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-diagnostics-"));
  const previous = Bun.env.MARS_DIAGNOSTICS_ROOT;
  Bun.env.MARS_DIAGNOSTICS_ROOT = root;
  const diagnosticId = crypto.randomUUID();
  try {
    const accepted = await handleAuthenticatedWorkerEvent(
      Object.assign(async () => [], {}) as never,
      { handleEvent() { return false; } },
      event("diagnostic.chunk", { jobId: crypto.randomUUID(), leaseId, diagnosticId, sequence: 0, content: "raw worker evidence", final: true }),
      { send() {} },
    );
    expect(accepted).toBe(true);
    expect(await readFile(join(root, workerId, diagnosticId, "00000000.log"), "utf8")).toBe("raw worker evidence");
  } finally {
    if (previous === undefined) delete Bun.env.MARS_DIAGNOSTICS_ROOT;
    else Bun.env.MARS_DIAGNOSTICS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
