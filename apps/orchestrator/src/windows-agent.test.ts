import { expect, test } from "bun:test";
import { WorkerConfigurePayload, type LeaseBootstrapEnvelope, type WorkerCommand, type WorkerEvent } from "@whitesmith/contracts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";
import { applyWindowsWorkerConfiguration, runWindowsLeaseCleanup, startWindowsLeaseLifecycle } from "./windows-agent.ts";

test("awaits the live cache TTL before acknowledging Windows configuration", async () => {
  const limits = { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 6 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 };
  const cache = { ttlSeconds: 60 };
  const payload = WorkerConfigurePayload.parse({
    workerId: "11111111-1111-4111-8111-111111111111",
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
    appliance: { vcpu: 32, memoryBytes: 64 * 1024 ** 3, storageBytes: 1_000 * 1024 ** 3 },
    runtime: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 },
    guestPlatforms: ["windows-x64"],
    cache: { ttlSeconds: 3600 },
  });
  let release!: () => void;
  const applied = new Promise<void>((resolve) => { release = resolve; });
  const result = applyWindowsWorkerConfiguration(limits, cache, payload, { applyTtl: () => applied });
  expect(cache).toEqual({ ttlSeconds: 60 });
  release();
  const observed = await result;
  expect(limits).toEqual({ maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 });
  expect(cache).toEqual({ ttlSeconds: 3600 });
  expect(observed.cache).toEqual(payload.cache);
});

const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const command: WorkerCommand = { version: 1, id: "33333333-3333-4333-8333-333333333333", type: "windows-container.create_lease", workerId, leaseId, occurredAt: new Date().toISOString(), payload: {} };
const bootstrap: LeaseBootstrapEnvelope = { leaseId, jobId: leaseId, nonce: "n".repeat(32), guestPlatform: "windows-x64", imageDigest: `sha256:${"a".repeat(64)}`, resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };

test("reports Windows container provisioning failures instead of leaving the lease dispatched", async () => {
  const events: WorkerEvent[] = [];
  const driver = { createLease: async () => { throw new Error("provisioning exploded"); } };
  await runLeaseLifecycle(command, driver as never, bootstrap, event => events.push(event));
  expect(events).toEqual([expect.objectContaining({ type: "lease.failed", payload: expect.objectContaining({ commandId: command.id, leaseId, nonce: bootstrap.nonce, reason: "provisioning_failed" }) })]);
});

test("coalesces duplicate Windows lease commands while provisioning", async () => {
  let creates = 0;
  const events: WorkerEvent[] = [];
  const driver = {
    createLease: async () => {
      creates += 1;
      await Bun.sleep(5);
      return { runtimeInstanceId: "container", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, state: "sandbox_attested" as const, completion: Promise.resolve(0) };
    },
    stopLease: async () => {},
    removeLease: async () => {},
  };
  const active = new Map<string, Promise<void>>();
  await Promise.all([
    startWindowsLeaseLifecycle(command, driver, bootstrap, event => events.push(event), active),
    startWindowsLeaseLifecycle(command, driver, bootstrap, event => events.push(event), active),
  ]);
  expect(creates).toBe(1);
  expect(events.filter(event => event.type === "sandbox_attested")).toHaveLength(1);
});

test("handles durable stop commands and removes the lease", async () => {
  const events: WorkerEvent[] = [];
  const calls: string[] = [];
  const stopCommand: WorkerCommand = {
    ...command,
    type: "tart.stop_lease",
    payload: { nonce: bootstrap.nonce },
  };
  await runWindowsLeaseCleanup(stopCommand, {
    stopLease: async (id) => { calls.push(`stop:${id}`); },
    removeLease: async (id) => { calls.push(`remove:${id}`); },
  }, (workerEvent) => events.push(workerEvent));

  expect(calls).toEqual([`stop:${leaseId}`, `remove:${leaseId}`]);
  expect(events).toEqual([
    expect.objectContaining({ type: "command.accepted", payload: expect.objectContaining({ commandId: command.id, leaseId }) }),
    expect.objectContaining({ type: "lease.reaped", payload: expect.objectContaining({ commandId: command.id, leaseId, nonce: bootstrap.nonce }) }),
  ]);
});
