import { describe, expect, test } from "bun:test";
import { applyLinuxWorkerConfigure, buildLinuxWorkerJoinPayload, createLinuxIdentity, executeLinuxWorkerCommand, handleLinuxWorkerCommand } from "./linux-agent.ts";
import type { WorkerCommand, WorkerEvent } from "@mars/contracts";


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
    cache: { ttlSeconds: 7200, runnerCacheEnabled: false, runnerCacheMaxGiB: 12 },
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
  },
};

describe("Linux worker.configure", () => {
  test("applies TTL and runner cache state before acknowledging the observed configuration", async () => {
    const resources = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, cache: { ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } };
    let release!: () => void;
    const applied = new Promise<void>((resolve) => { release = resolve; });
    const enabledStates: boolean[] = [];
    const maxCaps: number[] = [];
    const result = applyLinuxWorkerConfigure(command, resources, { applyTtl: () => applied, setRunnerCacheEnabled: (enabled) => enabledStates.push(enabled), setRunnerCacheMaxGiB: (maxGiB) => maxCaps.push(maxGiB) });
    expect(resources.cache).toEqual({ ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 });
    release();
    const event = await result;
    expect(enabledStates).toEqual([false]);
    expect(maxCaps).toEqual([12]);
    expect(resources).toEqual({ appliance: { vcpu: 8, memoryBytes: 16_000, storageBytes: 64_000 }, runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_000, maxStorageBytesPerPod: 16_000, maxConcurrentPods: 4 }, cache: { ttlSeconds: 7200, runnerCacheEnabled: false, runnerCacheMaxGiB: 12 } });
    expect(event.type).toBe("worker.configured");
    expect(event.workerId).toBe(workerId);
    expect(event.payload).toEqual({ commandId: command.id, workerId, revision: "a".repeat(64), observed: { appliance: resources.appliance, runtime: resources.runtime, guestPlatforms: ["linux-x64"], selectedDriver: "linux-libvirt-vm", cache: resources.cache } });
  });
  test("rejects a selected driver that cannot run the configured guest", async () => {
    await expect(applyLinuxWorkerConfigure({ ...command, payload: { ...command.payload, selectedDriver: "linux-docker-container" } }, { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, cache: { ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } }, { applyTtl: async () => {}, setRunnerCacheEnabled: () => {}, setRunnerCacheMaxGiB: () => {} })).rejects.toThrow("incompatible");
  });

  test("consumes only worker.configure", async () => {
    const resources = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, cache: { ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } };
    await expect(handleLinuxWorkerCommand({ ...command, type: "doctor" }, resources, { applyTtl: async () => {}, setRunnerCacheEnabled: () => {}, setRunnerCacheMaxGiB: () => {} })).rejects.toThrow("unsupported worker command");
  });
});

test("purges only the runner cache and acknowledges after completion", async () => {
  let purges = 0;
  const result = await handleLinuxWorkerCommand(
    { ...command, id: "00000000-0000-4000-8000-000000000003", type: "worker.runner_cache_purge", payload: { workerId } },
    { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, cache: { ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } },
    { applyTtl: async () => {}, setRunnerCacheEnabled: () => {}, setRunnerCacheMaxGiB: () => {}, purgeRunnerCache: async () => { purges += 1; } },
  );
  expect(purges).toBe(1);
  expect(result.type).toBe("command.accepted");
  expect(result.payload).toEqual({ commandId: "00000000-0000-4000-8000-000000000003", leaseId: null });
});
test("leaves command failures unacknowledged so health frames can continue", async () => {
  const resources = {
    appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 },
    runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 },
    cache: { ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 },
  };
  const sent: WorkerEvent[] = [];
  const failingCommand = {
    ...command,
    id: "00000000-0000-4000-8000-000000000004",
    type: "linux-vm.create_lease",
    leaseId: "00000000-0000-4000-8000-000000000005",
    payload: {},
  } as WorkerCommand;
  await expect(executeLinuxWorkerCommand(failingCommand, resources, {
    driver: { createLease: async () => { throw new Error("not reached"); }, stopLease: async () => {}, removeLease: async () => {} },
    encryptionPrivateKey: "unused",
    runtimeReady: () => true,
    send: (event) => sent.push(event),
    activeLeases: new Map(),
    cacheService: { applyTtl: async () => {}, setRunnerCacheEnabled: () => {}, setRunnerCacheMaxGiB: () => {} } as never,
  })).rejects.toThrow("bootstrap_ciphertext_missing");
  expect(sent).toEqual([]);
  sent.push({ version: 1, id: "00000000-0000-4000-8000-000000000006", workerId, type: "pong", occurredAt: new Date().toISOString(), payload: {} });
  sent.push({ version: 1, id: "00000000-0000-4000-8000-000000000007", workerId, type: "doctor", occurredAt: new Date().toISOString(), payload: {} });
  expect(sent.map((event) => event.type)).toEqual(["pong", "doctor"]);
});


test("builds a Linux enrollment payload with digest-bound VM evidence", () => {
  const payload = buildLinuxWorkerJoinPayload({
    code: "A".repeat(43),
    computerName: "linux-builder",
    releaseVersion: "0.1.0",
    contractVersion: "0.1.0",
    publicKey: "public",
    encryptionPublicKey: "encryption",
    vmUuid: workerId,
    machineUuid: workerId,
    doctor: { runtimeMode: "vm", artifactSource: "worker_local", artifactDigest: `sha256:${"a".repeat(64)}`, runtimeReady: true, libvirtReady: true, networkReady: true, cloneStorageReady: true, realVmSmoke: true, imageSignatures: true, smokeArtifactDigest: `sha256:${"a".repeat(64)}`, smokeObservedAt: "2026-08-11T00:00:00.000Z" },
    capacity: { actualVcpu: 8, actualMemoryBytes: 16_000, actualStorageBytes: 64_000, freeVcpu: 8, freeMemoryBytes: 16_000, freeStorageBytes: 64_000 },
  });
  expect(payload.platform).toBe("linux-x64");
  expect(payload.computerName).toBe("linux-builder");
  expect(payload.doctor.smokeArtifactDigest).toBe(payload.doctor.artifactDigest);
});
test("creates persisted identity with stable UUIDs before enrollment", () => {
  const identity = createLinuxIdentity();
  expect(identity.workerId).toBe("");
  expect(identity.vmUuid).toMatch(/^[0-9a-f-]{36}$/i);
  expect(identity.machineUuid).toMatch(/^[0-9a-f-]{36}$/i);
});
