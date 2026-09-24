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

test("creates a Tart Ubuntu ARM64 pool from a dual-platform Mac worker", async () => {
  const digest = `mars-linux-arm64-job@sha256:${"a".repeat(64)}`;
  const macDigest = `mars-macos-arm64-job@sha256:${"c".repeat(64)}`;
  const inserted: unknown[][] = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from workers")) return [{ platform: "macos-arm64", guestPlatforms: ["macos-arm64", "linux-arm64"], limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 }, doctor: { doctor: { runtimeMode: "tart", runtimeReady: true, artifactDigests: { "macos-arm64": macDigest, "linux-arm64": digest } } } }];
    if (query.includes("select id from runner_pools")) return [];
    if (query.includes("insert into runner_pools")) inserted.push(values);
    return [];
  }, { json: (value: unknown) => value });
  await ensureDefaultPools(db as never, { "macos-arm64": `mars-macos-arm64-job@sha256:${"b".repeat(64)}` });
  expect(inserted).toHaveLength(4);
  expect(inserted.find((values) => values.includes("linux-arm64"))).toContainEqual(["mars-linux-arm64", "ubuntu"]);
  expect(inserted.find((values) => values.includes("linux-arm64"))).toContain(digest);
  expect(inserted.find((values) => values.includes("macos-arm64"))).toContain(macDigest);
});

test("lists all default pools before any worker or image is available", async () => {
  const inserted: unknown[][] = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("insert into runner_pools")) inserted.push(values);
    return [];
  }, { json: (value: unknown) => value });
  await ensureDefaultPools(db as never, {});
  expect(inserted).toHaveLength(4);
  for (const platform of ["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"]) {
    const pool = inserted.find((values) => values.includes(platform));
    expect(pool).toBeDefined();
    expect(pool).toContain("");
    expect(pool).toContain(false);
  }
  expect(inserted.find((values) => values.includes("linux-arm64"))).toContainEqual(["mars-linux-arm64", "ubuntu"]);
});

test("pins Ubuntu x64 and ARM64 defaults without claiming worker capacity", async () => {
  const inserted: unknown[][] = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join(" ").toLowerCase().includes("insert into runner_pools")) inserted.push(values);
    return [];
  }, { json: (value: unknown) => value });
  const x64 = `sha256:${"a".repeat(64)}`;
  const arm64 = `ghcr.io/example/linux-arm64-job@sha256:${"b".repeat(64)}`;
  await ensureDefaultPools(db as never, { "linux-x64": x64, "linux-arm64": arm64 });
  expect(inserted).toHaveLength(4);
  expect(inserted.find((values) => values.includes("linux-x64"))).toContain(x64);
  expect(inserted.find((values) => values.includes("linux-arm64"))).toContain(arm64);
  expect(inserted.find((values) => values.includes("linux-arm64"))).toContain("linux-docker-container");
  expect(inserted.find((values) => values.includes("linux-x64"))).toContain("linux-libvirt-vm");
  expect(inserted.find((values) => values.includes("linux-x64"))).toContain(false);
  expect(inserted.find((values) => values.includes("linux-arm64"))).toContain(false);
  expect(inserted.find((values) => values.includes("windows-x64"))).toContain(false);
  expect(inserted.find((values) => values.includes("macos-arm64"))).toContain(false);
});

test("upgrades an inert default pool when image and worker evidence arrive", async () => {
  let workers: Record<string, unknown>[] = [];
  const updates: unknown[][] = [];
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from workers")) return workers;
    if (query.includes("select id from runner_pools")) return [{ id: "existing-pool" }];
    if (query.includes("update runner_pools")) updates.push(values);
    return [];
  }, { json: (value: unknown) => value });
  const image = `sha256:${"a".repeat(64)}`;
  await ensureDefaultPools(db as never, {});
  expect(updates).toEqual([]);
  await ensureDefaultPools(db as never, { "linux-x64": image });
  expect(updates).toHaveLength(1);
  expect(updates[0]).toContain(false);
  workers = [{ platform: "linux-x64", guestPlatforms: ["linux-x64"], limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 }, doctor: {} }];
  await ensureDefaultPools(db as never, { "linux-x64": image });
  expect(updates).toHaveLength(2);
  expect(updates[1]).toContain(image);
  expect(updates[1]).toContain(true);
});

test("clamps automatic pool resources to lower worker ceilings", () => {
  expect(poolResourcesForLimits({ maxVcpuPerPod: 1, maxMemoryBytesPerPod: GIB, maxStorageBytesPerPod: 5 * GIB, maxConcurrentPods: 1 })).toEqual({
    vcpu: 1,
    memoryBytes: GIB,
    storageBytes: 5 * GIB,
    concurrency: 1,
  });
});
