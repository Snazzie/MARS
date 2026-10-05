import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorkerLeaseEvent, handleAuthenticatedWorkerEvent, timingDurations } from "./worker-lifecycle.ts";

const workerId = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
const leaseId = "22222222-2222-4222-8222-222222222222";
const nonce = "n".repeat(32);
const event = (type: string, payload: Record<string, unknown>) => ({ version: 1, id: crypto.randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });

function acceptingDb(execute: (name: string, parameters: Record<string, unknown>) => unknown = name => {
  if (name === "worker_lifecycle_reap_context") return [{ commandType: "windows-container.stop_lease", terminalResult: { exitCode: 0 } }];
  if (name === "worker_lifecycle_terminal_log_fence") return [{ id: leaseId }];
  if (name === "worker_lifecycle_log_job") return [{ organizationId: "org", runId: "run", jobId: leaseId }];
  return [{ id: leaseId }];
}) {
  const calls: Array<{ query: string; values: Record<string, unknown> }> = [];
  const db = preparedTestDatabase((query, values) => {
    calls.push({ query, values });
    return execute(query, values);
  });
  return { db, calls };
}

test("attests only the matching dispatched worker lease and nonce", async () => {
  const { db, calls } = acceptingDb();
  expect(await applyWorkerLeaseEvent(db, event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "mars-job-22222222", observed: { vcpu: 4, memoryBytes: 4_294_967_296, storageBytes: 21_474_836_480 } }))).toBe(true);
  expect(calls[0]).toMatchObject({ query: "worker_lifecycle_attest", values: { leaseId, workerId, nonce, runtimeInstanceId: "mars-job-22222222" } });
});

test("records runner completion and final VM reap monotonically", async () => {
  const completed = acceptingDb();
  expect(await applyWorkerLeaseEvent(completed.db, event("runner.finished", { leaseId, nonce, exitCode: 0 }))).toBe(true);
  expect(completed.calls[0]).toMatchObject({ query: "worker_lifecycle_finish", values: { state: "completed", leaseId, workerId, nonce, terminalResult: JSON.stringify({ exitCode: 0 }) } });

  const reaped = acceptingDb();
  expect(await applyWorkerLeaseEvent(reaped.db, event("lease.reaped", { leaseId, nonce }))).toBe(true);
  expect(reaped.calls[0]).toMatchObject({ query: "worker_lifecycle_reap", values: { leaseId, workerId, nonce } });
});
test("distinguishes duplicate reap events and identifies cleanup source and terminal reason", async () => {
  let transitions = 0;
  const { db } = acceptingDb(name => {
    if (name === "worker_lifecycle_reap") return transitions++ === 0 ? [{ id: leaseId }] : [];
    if (name === "worker_lifecycle_reap_context") return [{ commandType: "windows-container.stop_lease", terminalResult: { exitCode: 0 } }];
    return [];
  });
  const observed: Record<string, unknown>[] = [];
  const originalLog = console.log;
  console.log = (message, detail) => { if (message === "Worker lease transition") observed.push(detail as Record<string, unknown>); };
  try {
    const reaped = event("lease.reaped", { leaseId, nonce, commandId: crypto.randomUUID() });
    expect(await applyWorkerLeaseEvent(db, reaped)).toBe(true);
    expect(await applyWorkerLeaseEvent(db, reaped)).toBe(false);
  } finally {
    console.log = originalLog;
  }
  expect(observed.map(({ applied, cleanupSource, terminalReason }) => ({ applied, cleanupSource, terminalReason }))).toEqual([
    { applied: true, cleanupSource: "control_plane_stop", terminalReason: "runner_succeeded" },
    { applied: false, cleanupSource: "control_plane_stop", terminalReason: "runner_succeeded" },
  ]);
});
test("maps a nonzero runner exit to a failed terminal lease", async () => {
  const failed = acceptingDb();
  expect(await applyWorkerLeaseEvent(failed.db, event("runner.finished", { leaseId, nonce, exitCode: 17 }))).toBe(true);
  expect(failed.calls[0]).toMatchObject({ query: "worker_lifecycle_finish", values: { state: "failed", leaseId, workerId, nonce, terminalResult: JSON.stringify({ exitCode: 17 }) } });
});



test("marks cleanup failure and releases its acknowledged stop for retry", async () => {
  const { db, calls } = acceptingDb();
  const commandId = crypto.randomUUID();
  expect(await applyWorkerLeaseEvent(db, event("lease.failed", { commandId, leaseId, nonce, reason: "cleanup_failed" }))).toBe(true);
  expect(calls[0]).toMatchObject({ query: "worker_lifecycle_cleanup_failed", values: { leaseId, workerId, nonce } });
  expect(calls[1]).toMatchObject({ query: "worker_lifecycle_fail_stop_command", values: { commandId, workerId, leaseId } });
});
test("marks debug-preserved leases without scheduling cleanup", async () => {
  const { db, calls } = acceptingDb();
  expect(await applyWorkerLeaseEvent(db, event("lease.failed", { leaseId, nonce, reason: "debug_preserve" }))).toBe(true);
  expect(calls[0]).toMatchObject({ query: "worker_lifecycle_debug_preserve", values: { leaseId, workerId, nonce, debugResult: JSON.stringify({ debugPreserved: true }) } });
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
test("persists a valid worker cache entry without dispatching it", async () => {
  const generation = crypto.randomUUID();
  const entry = { entryId: crypto.randomUUID(), githubRepositoryId: "123456789012345", cacheKeyPreview: "build-linux", cacheKeyHash: "a".repeat(64), scopePreview: "refs/heads/main", scopeHash: "b".repeat(64), versionHash: "c".repeat(64), sizeBytes: "9007199254740993", createdAt: "2026-08-23T12:00:00.000Z", lastAccessedAt: "2026-08-23T12:01:00.000Z", expiresAt: "2026-08-25T12:01:00.000Z" };
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const db = preparedTestDatabase((name, parameters) => {
    calls.push({ name, parameters });
    if (name === "worker_cache_generation") return [{ generation }];
    return [];
  });
  let dispatches = 0;
  expect(await handleAuthenticatedWorkerEvent(db, { handleEvent() { dispatches++; return false; } }, event("worker.cache_entry_upsert", { generation, entry }), { send() {} })).toBe(true);
  expect(dispatches).toBe(0);
  expect(calls.find(call => call.name === "worker_cache_entry_upsert")?.parameters).toMatchObject({ workerId, entryId: entry.entryId, githubRepositoryId: entry.githubRepositoryId, generation });
});
test("stores runner cache status only for the current generation", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const db = preparedTestDatabase((name, parameters) => {
    calls.push({ name, parameters });
    return name === "worker_cache_generation" ? [{ generation }] : name === "worker_cache_runner_status" ? [{ workerId }] : [];
  });
  const frame = event("worker.runner_cache_status", { generation, enabled: true, maxGiB: 20, sizeBytes: "123", entryCount: 1, observedAt: new Date().toISOString() });
  expect(await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, frame, { send() {} })).toBe(true);
  expect(calls.find(call => call.name === "worker_cache_runner_status")?.parameters).toMatchObject({ workerId, generation, enabled: true, maxGiB: 20, sizeBytes: "123", entryCount: 1 });
  calls.length = 0;
  expect(await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, { ...frame, payload: { ...frame.payload, generation: crypto.randomUUID() } }, { send() {} })).toBe(true);
  expect(calls.map(call => call.name)).toEqual(["worker_cache_generation"]);
});

test("persists authenticated lifecycle events independently of command acknowledgement state", async () => {
  const { db, calls } = acceptingDb();
  let dispatchCalls = 0;
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent() { dispatchCalls += 1; return false; } }, event("sandbox_attested", { leaseId, nonce, runtimeInstanceId: "vm", observed: { vcpu: 1, memoryBytes: 1, storageBytes: 1 } }), { send() {} });
  expect(accepted).toBe(true);
  expect(dispatchCalls).toBe(0);
  expect(calls.length).toBeGreaterThanOrEqual(1);
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
test("accepts signed integer runner exit codes while rejecting malformed exit codes", async () => {
  const { db } = acceptingDb();
  const frame = event("runner.finished", { leaseId, nonce, exitCode: -1 });
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, frame, { send() {} });
  expect(accepted).toBe(true);

  expect(await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, { ...frame, payload: { ...frame.payload, exitCode: 1.5 } }, { send() {} })).toBe(false);
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
  const { db, calls } = acceptingDb(name => name === "worker_lifecycle_log_job" ? [{ organizationId: "org", runId: "run", jobId }] : name === "worker_lifecycle_log_step" ? [{ id: stepId }] : []);
  const attributed = event("job.log", { jobId, stepId, sequence: 0, content: "safe", occurredAt: new Date().toISOString() });
  expect(await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, attributed, { send() {} })).toBe(true);
  expect(calls.at(-1)).toMatchObject({ query: "worker_lifecycle_step_log_chunk", values: { jobId, stepId, content: "safe", sequence: 0 } });
  const unattributed = event("job.log", { jobId, stepId: null, sequence: 1, content: "fallback", occurredAt: new Date().toISOString() });
  expect(await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, unattributed, { send() {} })).toBe(true);
  expect(calls.at(-1)).toMatchObject({ query: "worker_lifecycle_log_chunk", values: { jobId, content: "fallback", sequence: 1 } });
  const missingStep = preparedTestDatabase(name => name === "worker_lifecycle_log_job" ? [{ organizationId: "org", runId: "run", jobId }] : []);
  expect(await handleAuthenticatedWorkerEvent(missingStep, { handleEvent() { return false; } }, attributed, { send() {} })).toBe(false);
});
test("acknowledges delayed logs for a terminal lease without persisting them", async () => {
  const jobId = "44444444-4444-4444-8444-444444444444";
  const calls: string[] = [];
  const db = preparedTestDatabase(name => {
    calls.push(name);
    return name === "worker_lifecycle_terminal_log_fence" ? [{ id: leaseId }] : [];
  });
  const accepted = await handleAuthenticatedWorkerEvent(db, { handleEvent() { return false; } }, event("job.log", { jobId, stepId: null, sequence: 0, content: "late", occurredAt: new Date().toISOString() }), { send() {} });
  expect(accepted).toBe(true);
  expect(calls).toEqual(["worker_lifecycle_log_job", "worker_lifecycle_terminal_log_fence"]);
});

test("persists authenticated diagnostic chunks under the configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-diagnostics-"));
  const previous = Bun.env.MARS_DIAGNOSTICS_ROOT;
  Bun.env.MARS_DIAGNOSTICS_ROOT = root;
  const diagnosticId = crypto.randomUUID();

  try {
    const accepted = await handleAuthenticatedWorkerEvent(
      acceptingDb(() => []).db,
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
