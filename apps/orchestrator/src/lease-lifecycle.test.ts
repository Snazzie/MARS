import { expect, test } from "bun:test";
import type { LeaseBootstrapEnvelope, WorkerCommand, WorkerEvent } from "@whitesmith/contracts";
import { initialMemoryPressureState, runLeaseLifecycle, updateMemoryPressure } from "./lease-lifecycle.ts";

const command = { version: 1, id: "33333333-3333-4333-8333-333333333333", type: "windows-container.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: "22222222-2222-4222-8222-222222222222", occurredAt: new Date().toISOString(), payload: {} } satisfies WorkerCommand;
const bootstrap = { leaseId: command.leaseId!, jobId: command.leaseId!, nonce: "n".repeat(32), guestPlatform: "windows-x64", imageDigest: `repo@sha256:${"a".repeat(64)}`, resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() } satisfies LeaseBootstrapEnvelope;

test("cleanup still removes a lease after stop failure", async () => {
  const events: string[] = [];
  let removed = false;
  const driver = { createLease: async () => ({ runtimeInstanceId: "runtime", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, completion: Promise.resolve(0), state: "sandbox_attested" as const }), stopLease: async () => { throw new Error("stop"); }, removeLease: async () => { removed = true; } };
  await runLeaseLifecycle(command, driver, bootstrap, event => events.push(event.type));
  expect(removed).toBe(true);
  expect(events).toEqual(["sandbox_attested", "runner.finished", "lease.failed"]);
});
test("reports a nonzero runner exit before cleanup", async () => {
  const events: Array<{ type: string; exitCode?: unknown }> = [];
  const driver = { createLease: async () => ({ runtimeInstanceId: "runtime", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, completion: Promise.resolve(17), state: "sandbox_attested" as const }), stopLease: async () => {}, removeLease: async () => {} };
  await runLeaseLifecycle(command, driver, bootstrap, event => events.push({ type: event.type, exitCode: event.payload.exitCode }));
  expect(events).toEqual([
    { type: "sandbox_attested", exitCode: undefined },
    { type: "runner.finished", exitCode: 17 },
    { type: "lease.reaped", exitCode: undefined },
  ]);
});

test("preserves a lease when worker setting is enabled", async () => {
  const stopped: string[] = [];
  const driver = {
    createLease: async () => ({ runtimeInstanceId: "runtime", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, completion: Promise.resolve(0), state: "sandbox_attested" as const }),
    stopLease: async (leaseId: string) => { stopped.push(`stop:${leaseId}`); },
    removeLease: async (leaseId: string) => { stopped.push(`remove:${leaseId}`); },
    collectRawDiagnostics: async () => "runner diagnostics",
  };
  const events: string[] = [];
  await runLeaseLifecycle(command, driver, bootstrap, event => events.push(event.type), { preserveLeases: () => true });
  expect(stopped).toEqual([]);
  expect(events).toEqual(["sandbox_attested", "runner.finished", "diagnostic.chunk", "lease.failed"]);
});

test("passes authenticated worker cache transport and unregisters the lease", async () => {
  const workerCache = {
    proxyUrl: "http://lease-user:lease-secret@127.0.0.1:3128",
    cacheBaseUrl: "https://127.0.0.1:8443",
    caCertificatePem: "worker-ca",
    expiresAt: bootstrap.expiresAt,
  };
  let received: unknown;
  let unregistered: string | undefined;
  const driver = {
    createLease: async (lease: { workerCache?: unknown }) => {
      received = lease.workerCache;
      return { runtimeInstanceId: "runtime", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, completion: Promise.resolve(0), state: "sandbox_attested" as const };
    },
    stopLease: async () => {},
    removeLease: async () => {},
  };
  const cacheService = {
    transport: (leaseId: string, expiresAt: string) => {
      expect(leaseId).toBe(bootstrap.leaseId);
      expect(expiresAt).toBe(bootstrap.expiresAt);
      return workerCache;
    },
    unregisterLease: (leaseId: string) => { unregistered = leaseId; },
  };
  await runLeaseLifecycle(command, driver, bootstrap, () => {}, { cacheService });
  expect(received).toEqual(workerCache);
  expect(new URL(workerCache.proxyUrl).username).not.toBe("");
  expect(new URL(workerCache.proxyUrl).password).not.toBe("");
  expect(unregistered).toBe(bootstrap.leaseId);
});

test("fails lease provisioning closed when worker cache transport setup fails", async () => {
  let created = false;
  const events: WorkerEvent[] = [];
  const driver = {
    createLease: async () => {
      created = true;
      throw new Error("must not run");
    },
    stopLease: async () => {},
    removeLease: async () => {},
  };
  const cacheService = {
    transport: () => {
      throw new Error("cache unavailable");
    },
  };
  await runLeaseLifecycle(command, driver, bootstrap, event => events.push(event), { cacheService: cacheService as never });
  expect(created).toBe(false);
  expect(events).toEqual([expect.objectContaining({ type: "lease.failed", payload: expect.objectContaining({ reason: "provisioning_failed" }) })]);
});

test("requires two consecutive near-limit samples before OOM detection", () => {
  let state = initialMemoryPressureState();
  let result = updateMemoryPressure(state, { memoryWorkingSetBytes: 96, memoryLimitBytes: 100 }, 100);
  state = result.state;
  expect(state.phase).toBe("pressured");
  result = updateMemoryPressure(state, { memoryWorkingSetBytes: 97, memoryLimitBytes: 100 }, 100);
  expect(result.state.phase).toBe("oom_detected");
  expect(result.evidence?.reason).toBe("out_of_memory");
  expect(result.shouldStop).toBe(true);
});

test("detects over-limit memory immediately and does not infer OOM from missing samples", () => {
  const result = updateMemoryPressure(initialMemoryPressureState(), { memoryWorkingSetBytes: 101, memoryLimitBytes: 100 }, 100);
  expect(result.evidence?.reason).toBe("out_of_memory");
  expect(updateMemoryPressure(initialMemoryPressureState(), null, 100).evidence).toBeNull();
});

test("reports runner failure with termination evidence when completion rejects", async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const driver = {
    createLease: async () => ({
      runtimeInstanceId: "runtime",
      observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 },
      completion: Promise.reject(new Error("container disappeared")),
      state: "sandbox_attested" as const,
    }),
    stopLease: async () => {},
    removeLease: async () => {},
  };
  await runLeaseLifecycle(command, driver, bootstrap, event => events.push({ type: event.type, payload: event.payload }));
  const failure = events.find(event => event.type === "lease.failed");
  expect(failure?.payload).toMatchObject({ reason: "runner_failed", termination: { cause: "child_disappeared", exitObserved: false } });
  expect(failure?.payload).not.toHaveProperty("oom");
  expect(typeof failure?.payload.correlationId).toBe("string");
});


