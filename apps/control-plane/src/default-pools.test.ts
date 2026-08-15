import { expect, test } from "bun:test";
import { poolResourcesForLimits } from "./default-pools.ts";

const GIB = 1024 ** 3;

test("allocates conservative resources instead of every worker ceiling", () => {
  expect(poolResourcesForLimits({ maxVcpuPerPod: 5, maxMemoryBytesPerPod: 4 * GIB, maxStorageBytesPerPod: 30 * GIB, maxConcurrentPods: 3 })).toEqual({
    vcpu: 2,
    memoryBytes: 2 * GIB,
    storageBytes: 10 * GIB,
    concurrency: 1,
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
