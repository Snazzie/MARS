import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { ensureDefaultPools, poolResourcesForLimits, poolResourcesForWorkers } from "./default-pools.ts";

type TestPool = { id: string; name: string; platform: string; driver: string; imageDigest: string; resources: unknown; labels: unknown; triggerLabel: string; enabled: boolean };
function poolDatabase(initialWorkers: Record<string, unknown>[] = []) {
  const pools = new Map<string, TestPool>();
  let workers = initialWorkers;
  let nextId = 0;
  const db = preparedTestDatabase((name, values) => {
    if (name === "default_pools_workers") return workers;
    if (name === "default_pools_find" || name === "default_pools_find_alternate") {
      const pool = [...pools.values()].find(item => item.name === values.name || name === "default_pools_find" && item.triggerLabel === values.label);
      return pool ? [{ id: pool.id, driver: pool.driver, platform: pool.platform, imageDigest: pool.imageDigest }] : [];
    }
    if (name === "default_pools_relabel_arm64") {
      const pool = [...pools.values()].find(item => item.id === values.id);
      if (pool?.triggerLabel === "mars-linux-arm64") Object.assign(pool, { triggerLabel: values.label, labels: JSON.parse(String(values.labels)) });
      return [];
    }
    if (name === "default_pools_update") {
      const pool = [...pools.values()].find(item => item.id === values.id);
      if (pool) Object.assign(pool, { resources: JSON.parse(String(values.resources)), enabled: values.enabled });
      return [];
    }
    if (name === "default_pools_insert") {
      const pool: TestPool = { id: `pool-${++nextId}`, name: String(values.name), platform: String(values.platform), driver: String(values.driver), imageDigest: String(values.imageDigest), resources: typeof values.resources === "string" ? JSON.parse(values.resources) : values.resources, labels: typeof values.labels === "string" ? JSON.parse(values.labels) : values.labels, triggerLabel: String(values.label), enabled: Boolean(values.enabled) };
      pools.set(pool.id, pool);
      return [];
    }
    return [];
  });
  return { db, pools, set workers(value: Record<string, unknown>[]) { workers = value; } };
}
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
  const limits = [
    { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 },
    { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 3 },
  ];
  const workers = limits.map(workerLimits => ({ platform: "windows-x64", guestPlatforms: ["windows-x64"], limits: workerLimits, desiredConfiguration: { selectedDriver: "windows-hyperv-container" }, doctor: { doctor: { capabilities: [{ driver: "windows-hyperv-container", guestPlatform: "windows-x64", ready: true, imageDigest: "sha256:image", remediation: null }] } } }));
  const fixture = poolDatabase(workers);
  await ensureDefaultPools(fixture.db, { "windows-x64": "sha256:image" });
  fixture.workers = workers.map((worker, index) => ({ ...worker, limits: { ...limits[index]!, maxConcurrentPods: index === 0 ? 7 : limits[index]!.maxConcurrentPods } }));
  await ensureDefaultPools(fixture.db, { "windows-x64": "sha256:image" });
  expect([...fixture.pools.values()].find(pool => pool.name === "default-windows-x64")?.resources).toMatchObject({ concurrency: 10 });
});

test("creates a Tart Ubuntu ARM64 pool from a dual-platform Mac worker", async () => {
  const digest = `mars-linux-arm64-job@sha256:${"a".repeat(64)}`;
  const macDigest = `mars-macos-arm64-job@sha256:${"c".repeat(64)}`;
  const limits = { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 };
  const fixture = poolDatabase([{ platform: "macos-arm64", guestPlatforms: ["macos-arm64", "linux-arm64"], limits, desiredConfiguration: { selectedDriver: "tart-vm" }, doctor: { doctor: { capabilities: [{ driver: "tart-vm", guestPlatform: "macos-arm64", imageDigest: macDigest, ready: true }, { driver: "tart-vm", guestPlatform: "linux-arm64", imageDigest: digest, ready: true }] } } }]);
  await ensureDefaultPools(fixture.db, { "macos-arm64": `mars-macos-arm64-job@sha256:${"b".repeat(64)}` });
  expect(fixture.pools.size).toBe(4);
  expect([...fixture.pools.values()].find(pool => pool.name === "default-linux-arm64")).toMatchObject({ driver: "tart-vm", imageDigest: digest, labels: ["mars-ubuntu-arm64", "ubuntu"], enabled: true });
  expect([...fixture.pools.values()].find(pool => pool.name === "default-macos-arm64")).toMatchObject({ imageDigest: macDigest, enabled: true });
});

test("keeps the Tart Ubuntu pool and provisions a Docker pool for an ARM64 Windows worker", async () => {
  const tartDigest = `mars-linux-arm64-job@sha256:${"a".repeat(64)}`;
  const dockerDigest = `ghcr.io/example/job@sha256:${"b".repeat(64)}`;
  const limits = { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 };
  const mac = { platform: "macos-arm64", guestPlatforms: ["macos-arm64", "linux-arm64"], limits, desiredConfiguration: { selectedDriver: "tart-vm" }, doctor: { doctor: { capabilities: [{ driver: "tart-vm", guestPlatform: "linux-arm64", imageDigest: tartDigest, ready: true }] } } };
  const windows = { platform: "windows-arm64", guestPlatforms: ["linux-arm64"], limits, desiredConfiguration: { selectedDriver: "linux-docker-container" }, doctor: { doctor: { capabilities: [{ driver: "linux-docker-container", guestPlatform: "linux-arm64", imageDigest: dockerDigest, ready: true }] } } };
  const fixture = poolDatabase([mac, windows]);
  await ensureDefaultPools(fixture.db, {});
  expect([...fixture.pools.values()].find(pool => pool.name === "default-linux-arm64")).toMatchObject({ driver: "tart-vm", enabled: true });
  expect([...fixture.pools.values()].find(pool => pool.name === "default-linux-arm64-container")).toMatchObject({ driver: "linux-docker-container", imageDigest: dockerDigest, labels: ["mars-ubuntu-arm64", "mars-ubuntu-arm64-container", "ubuntu"], enabled: true });
  fixture.workers = [mac];
  await ensureDefaultPools(fixture.db, {});
  expect([...fixture.pools.values()].find(pool => pool.name === "default-linux-arm64-container")?.enabled).toBe(false);
  expect([...fixture.pools.values()].find(pool => pool.name === "default-linux-arm64")?.enabled).toBe(true);
});

test("routes configured Ubuntu x64 image versions through their own trigger labels", async () => {
  for (const version of ["22", "24", "26"] as const) {
    const fixture = poolDatabase();
    await ensureDefaultPools(fixture.db, { ubuntuVersion: version, "linux-x64": "sha256:image" });
    expect([...fixture.pools.values()].find(pool => pool.platform === "linux-x64")?.triggerLabel).toBe(`mars-ubuntu-${version}`);
  }
});

test("lists all default pools before any worker or image is available", async () => {
  const fixture = poolDatabase();
  await ensureDefaultPools(fixture.db, {});
  expect(fixture.pools.size).toBe(4);
  for (const platform of ["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"]) {
    expect([...fixture.pools.values()].find(pool => pool.platform === platform)).toMatchObject({ imageDigest: "", enabled: false });
  }
  expect([...fixture.pools.values()].find(pool => pool.platform === "linux-arm64")?.labels).toEqual(["mars-ubuntu-arm64", "ubuntu"]);
});

test("updates the existing default ARM64 pool's broad Linux label", async () => {
  const fixture = poolDatabase();
  fixture.pools.set("arm-pool", { id: "arm-pool", name: "default-linux-arm64", platform: "linux-arm64", driver: "linux-docker-container", imageDigest: "sha256:image", resources: {}, labels: ["mars-ubuntu-arm64"], triggerLabel: "mars-linux-arm64", enabled: false });
  await ensureDefaultPools(fixture.db, {});
  expect(fixture.pools.get("arm-pool")).toMatchObject({ triggerLabel: "mars-ubuntu-arm64", labels: ["mars-ubuntu-arm64", "ubuntu"] });
});


test("retains a default pool's driver and digest while readiness changes", async () => {
  const fixture = poolDatabase();
  fixture.pools.set("existing-pool", { id: "existing-pool", name: "default-linux-x64", platform: "linux-x64", driver: "linux-libvirt-vm", imageDigest: "sha256:pinned", resources: {}, labels: [], triggerLabel: "mars-ubuntu-24", enabled: true });
  await ensureDefaultPools(fixture.db, { "linux-x64": "sha256:other" });
  expect(fixture.pools.get("existing-pool")).toMatchObject({ driver: "linux-libvirt-vm", imageDigest: "sha256:pinned", enabled: false });
  fixture.workers = [{ platform: "linux-x64", guestPlatforms: ["linux-x64"], limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * GIB, maxStorageBytesPerPod: 40 * GIB, maxConcurrentPods: 2 }, desiredConfiguration: { selectedDriver: "linux-libvirt-vm" }, doctor: { doctor: { capabilities: [{ driver: "linux-libvirt-vm", guestPlatform: "linux-x64", ready: true, imageDigest: "sha256:new-worker-image" }] } } }];
  await ensureDefaultPools(fixture.db, { "linux-x64": "sha256:other" });
  expect(fixture.pools.get("existing-pool")).toMatchObject({ driver: "linux-libvirt-vm", imageDigest: "sha256:pinned", enabled: true });
});

test("clamps automatic pool resources to lower worker ceilings", () => {
  expect(poolResourcesForLimits({ maxVcpuPerPod: 1, maxMemoryBytesPerPod: GIB, maxStorageBytesPerPod: 5 * GIB, maxConcurrentPods: 1 })).toEqual({
    vcpu: 1,
    memoryBytes: GIB,
    storageBytes: 5 * GIB,
    concurrency: 1,
  });
});
