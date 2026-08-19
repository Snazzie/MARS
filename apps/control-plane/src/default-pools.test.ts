import { expect, test } from "bun:test";
import { poolResourcesForLimits, poolResourcesForWorkers } from "./default-pools.ts";

const GIB = 1024 ** 3;

test("allocates three useful sandboxes within the acknowledged worker ceiling", () => {
  expect(poolResourcesForLimits({ maxVcpuPerPod: 5, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 3 })).toEqual({
    vcpu: 4,
    memoryBytes: 6 * GIB,
    storageBytes: 30 * GIB,
    concurrency: 3,
  });
});

test("preserves worker concurrency above the old automatic cap", () => {
  expect(poolResourcesForLimits({ maxVcpuPerPod: 5, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 7 }).concurrency).toBe(7);
});

test("sums concurrency across workers sharing a default platform pool", () => {
  expect(poolResourcesForWorkers([
    { maxVcpuPerPod: 5, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 },
    { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * GIB, maxStorageBytesPerPod: 20 * GIB, maxConcurrentPods: 5 },
  ])).toEqual({
    vcpu: 7,
    memoryBytes: 12 * GIB,
    storageBytes: 60 * GIB,
    concurrency: 7,
  });
});

test("clamps automatic pool resources to lower worker ceilings", () => {
  expect(poolResourcesForLimits({ maxVcpuPerPod: 1, maxMemoryBytesPerPod: GIB, maxStorageBytesPerPod: 5 * GIB, maxConcurrentPods: 1 })).toEqual({
    vcpu: 1,
    memoryBytes: GIB,
    storageBytes: 5 * GIB,
    concurrency: 1,
  });
});
