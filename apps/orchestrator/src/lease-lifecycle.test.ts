import { expect, test } from "bun:test";
import type { LeaseBootstrapEnvelope, WorkerCommand } from "@whitesmith/contracts";
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


