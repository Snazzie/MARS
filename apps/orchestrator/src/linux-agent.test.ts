import { describe, expect, test } from "bun:test";
import { applyLinuxWorkerConfigure, buildLinuxWorkerJoinPayload, createLinuxIdentity, handleLinuxWorkerCommand } from "./linux-agent.ts";
import type { WorkerCommand } from "@mars/contracts";

const workerId = "00000000-0000-4000-8000-000000000001";
const command: WorkerCommand = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000002",
  type: "worker.configure",
  workerId,
  leaseId: null,
  occurredAt: "2026-08-11T00:00:00.000Z",
  payload: {
    workerId,
    appliance: { vcpu: 8, memoryBytes: 16_000, storageBytes: 64_000 },
    runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_000, maxStorageBytesPerPod: 16_000, maxConcurrentPods: 4 },
    guestPlatforms: ["linux-x64"],
    cache: { ttlSeconds: 7200 },
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
  },
};

describe("Linux worker.configure", () => {
  test("awaits the live cache TTL before emitting the acknowledged observation", async () => {
    const resources = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, cache: { ttlSeconds: 60 } };
    let release!: () => void;
    const applied = new Promise<void>((resolve) => { release = resolve; });
    const result = applyLinuxWorkerConfigure(command, resources, { applyTtl: () => applied });
    expect(resources.cache).toEqual({ ttlSeconds: 60 });
    release();
    const event = await result;
    expect(resources).toEqual({ appliance: { vcpu: 8, memoryBytes: 16_000, storageBytes: 64_000 }, runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_000, maxStorageBytesPerPod: 16_000, maxConcurrentPods: 4 }, cache: { ttlSeconds: 7200 } });
    expect(event.type).toBe("worker.configured");
    expect(event.workerId).toBe(workerId);
    expect(event.payload).toEqual({ commandId: command.id, workerId, revision: "a".repeat(64), observed: { appliance: resources.appliance, runtime: resources.runtime, guestPlatforms: ["linux-x64"], cache: resources.cache } });
  });

  test("consumes only worker.configure", async () => {
    const resources = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, cache: { ttlSeconds: 60 } };
    await expect(handleLinuxWorkerCommand({ ...command, type: "doctor" }, resources, { applyTtl: async () => {} })).rejects.toThrow("unsupported worker command");
  });
});

test("builds a Linux enrollment payload with digest-bound VM evidence", () => {
  const payload = buildLinuxWorkerJoinPayload({
    code: "A".repeat(43),
    publicKey: "public",
    encryptionPublicKey: "encryption",
    vmUuid: workerId,
    machineUuid: workerId,
    doctor: { runtimeMode: "vm", artifactSource: "worker_local", artifactDigest: `sha256:${"a".repeat(64)}`, runtimeReady: true, libvirtReady: true, networkReady: true, cloneStorageReady: true, realVmSmoke: true, imageSignatures: true, smokeArtifactDigest: `sha256:${"a".repeat(64)}`, smokeObservedAt: "2026-08-11T00:00:00.000Z" },
    capacity: { actualVcpu: 8, actualMemoryBytes: 16_000, actualStorageBytes: 64_000, freeVcpu: 8, freeMemoryBytes: 16_000, freeStorageBytes: 64_000 },
  });
  expect(payload.platform).toBe("linux-x64");
  expect(payload.doctor.smokeArtifactDigest).toBe(payload.doctor.artifactDigest);
});
test("creates persisted identity with stable UUIDs before enrollment", () => {
  const identity = createLinuxIdentity();
  expect(identity.workerId).toBe("");
  expect(identity.vmUuid).toMatch(/^[0-9a-f-]{36}$/i);
  expect(identity.machineUuid).toMatch(/^[0-9a-f-]{36}$/i);
});
