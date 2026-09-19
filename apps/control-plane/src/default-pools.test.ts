import { expect, test } from "bun:test";
import { ensureDefaultPools, poolResourcesForLimits, poolResourcesForWorkers } from "./default-pools.ts";

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

test("uses portable job defaults while summing shared pool concurrency", () => {
  expect(poolResourcesForWorkers([
    { maxVcpuPerPod: 5, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 },
    { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * GIB, maxStorageBytesPerPod: 20 * GIB, maxConcurrentPods: 5 },
  ])).toEqual({
    vcpu: 2,
    memoryBytes: 4 * GIB,
    storageBytes: 20 * GIB,
    concurrency: 7,
  });
});

test("recalculates shared pool concurrency after worker limits change", async () => {
  let limits = [
    { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 },
    { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 3 },
  ];
  const concurrency: number[] = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from workers")) return limits.map((workerLimits) => ({ platform: "windows-x64", guestPlatforms: ["windows-x64"], limits: workerLimits, doctor: { doctor: { runtimeMode: "vm", runtimeReady: true, probe: true, imageSignatures: true, artifactDigest: "sha256:image" } } }));
    if (query.includes("select id from runner_pools")) return [{ id: "pool" }];
    if (query.includes("update runner_pools")) concurrency.push((values[3] as { concurrency: number }).concurrency);
    return [];
  }, { json: (value: unknown) => value });

  await ensureDefaultPools(db as never, { "windows-x64": "sha256:image" });
  limits = [{ ...limits[0]!, maxConcurrentPods: 7 }, limits[1]!];
  await ensureDefaultPools(db as never, { "windows-x64": "sha256:image" });

  expect(concurrency).toEqual([5, 10]);
});

test("clamps automatic pool resources to lower worker ceilings", () => {
  expect(poolResourcesForLimits({ maxVcpuPerPod: 1, maxMemoryBytesPerPod: GIB, maxStorageBytesPerPod: 5 * GIB, maxConcurrentPods: 1 })).toEqual({
    vcpu: 1,
    memoryBytes: GIB,
    storageBytes: 5 * GIB,
    concurrency: 1,
  });
});
