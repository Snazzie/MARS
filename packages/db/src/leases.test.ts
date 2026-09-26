import { expect, test } from "bun:test";
import type { Sql } from "postgres";
import { reserveRoutingSlot, bindLeaseToJob } from "./leases.ts";

test("reserves a routing slot before any JIT request", async () => {
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } }];
    if (query.includes("insert into runner_leases")) return [{ id: "00000000-0000-4000-8000-000000000001", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date().toISOString() }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  const result = await reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 });
  expect(result.id).toBe("00000000-0000-4000-8000-000000000001");
});

test("rejects reservation when the worker row is no longer eligible", async () => {
  const tx = ((strings: TemplateStringsArray) => {
    if (strings.join(" ").toLowerCase().includes("from runner_pools")) return [];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  await expect(reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 })).rejects.toThrow("worker_not_eligible");
});
test("normalizes PostgreSQL timestamp strings for encrypted lease bootstraps", async () => {
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } }];
    if (query.includes("insert into runner_leases")) return [{ id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: "2026-08-20 18:36:34.099+01" }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  const result = await reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 });
  expect(result.expiresAt).toBe("2026-08-20T17:36:34.099Z");
});
test("reserves when current free capacity already includes active leases", async () => {
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 10, memoryBytes: 10, storageBytes: 10, concurrency: 10 }, limits: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10, maxStorageBytesPerPod: 10, maxConcurrentPods: 10 }, doctor: { capacity: { freeVcpu: 4, freeMemoryBytes: 4, freeStorageBytes: 4 } } }];
    if (query.startsWith('select cpu_mode as "cpumode"')) return [];
    if (query.includes("from runner_leases")) return [{ count: 1, vcpu: 3, memoryBytes: 3, storageBytes: 3 }];
    if (query.includes("insert into runner_leases")) return [{ id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date().toISOString() }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  await expect(reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 2, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 })).resolves.toMatchObject({ id: "lease" });
});
test("reserves a shared pool slot for a ready worker", async () => {
  const queries: string[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(strings.join(" "));
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) {
      if (query.includes("p.worker_id")) throw new Error("shared_pool_must_not_bind_pool_to_worker");
      return [{ id: "pool", workerId: "worker", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } }];
    }
    if (query.includes("insert into runner_leases")) return [{ id: "00000000-0000-4000-8000-000000000002", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date().toISOString() }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  const result = await reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 });
  expect(result.workerId).toBe("worker");
});
test("rejects a job when aggregate worker capacity is exhausted", async () => {
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", poolConcurrency: 10, resources: { vcpu: 10, memoryBytes: 10, storageBytes: 10, concurrency: 10 }, limits: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10, maxStorageBytesPerPod: 10, maxConcurrentPods: 10 }, doctor: { capacity: { freeVcpu: 4, freeMemoryBytes: 4, freeStorageBytes: 4 } } }];
    if (query.startsWith('select cpu_mode as "cpumode"')) return [];
    if (query.includes("from runner_leases")) return [{ count: 1, vcpu: 3, memoryBytes: 3, storageBytes: 3 }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  await expect(reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 5, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 })).rejects.toThrow("worker_capacity_exhausted");
});
test("rejects a reservation when active leases plus request exceed actual capacity", async () => {
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 10, memoryBytes: 10, storageBytes: 10, concurrency: 10 }, limits: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10, maxStorageBytesPerPod: 10, maxConcurrentPods: 10 }, doctor: { capacity: { actualVcpu: 8, actualMemoryBytes: 8, actualStorageBytes: 8, freeVcpu: 8, freeMemoryBytes: 8, freeStorageBytes: 8 } } }];
    if (query.startsWith('select cpu_mode as "cpumode"')) return [];
    if (query.includes("from runner_leases")) return [{ count: 1, vcpu: 7, memoryBytes: 7, storageBytes: 7 }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  await expect(reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 2, memoryBytes: 2, storageBytes: 2, concurrency: 1 }, ttlMs: 60_000 })).rejects.toThrow("worker_capacity_exhausted");
});

test("rejects a job when doctor-reported free memory is exhausted", async () => {
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", poolConcurrency: 10, resources: { vcpu: 10, memoryBytes: 10, storageBytes: 10, concurrency: 10 }, limits: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10, maxStorageBytesPerPod: 10, maxConcurrentPods: 10 }, doctor: { capacity: { freeVcpu: 10, freeMemoryBytes: 4, freeStorageBytes: 10 } } }];
    if (query.startsWith('select cpu_mode as "cpumode"')) return [];
    if (query.includes("from runner_leases")) return [{ count: 1, vcpu: 1, memoryBytes: 1, storageBytes: 1 }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  await expect(reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 1, memoryBytes: 5, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 })).rejects.toThrow("worker_capacity_exhausted");
});

test("binds a GitHub job only once", async () => {
  const queries: string[] = [];
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => { queries.push(strings.join(" ")); return [{ id: "lease" }]; }) as unknown as Sql<{}>;
  await bindLeaseToJob(db, "lease", 123);
  expect(queries[0]).toContain("github_job_id");
});

test("does not reuse a merely failed lease for a new reservation", async () => {
  const queries: string[] = [];
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    queries.push(query);
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } }];
    if (query.includes("insert into runner_leases") && query.includes("state in ('failed','reaped')")) return [{ id: "failed-lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date().toISOString(), requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, jobId: 123 }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });

  await expect(reserveRoutingSlot(db, {
    organizationId: "org",
    poolId: "pool",
    workerId: "worker",
    githubJobId: 123,
    routingKey: "org:pool:labels",
    requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 },
    ttlMs: 60_000,
  })).rejects.toThrow("job_already_claimed");
  expect(queries.some(query => query.includes("insert into runner_leases"))).toBe(true);
});

test("invalidates pending and sent create commands when a reaped lease is reused", async () => {
  const queries: string[] = [];
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    queries.push(query);
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } }];
    if (query.includes("insert into runner_leases")) return [{ id: "reaped-lease", nonce: "new-nonce", workerId: "worker", poolId: "pool", expiresAt: new Date().toISOString(), requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, jobId: 123 }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });

  await expect(reserveRoutingSlot(db, {
    organizationId: "org",
    poolId: "pool",
    workerId: "worker",
    githubJobId: 123,
    routingKey: "org:pool:labels",
    requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 },
    ttlMs: 60_000,
  })).resolves.toMatchObject({ id: "reaped-lease" });
  const insertIndex = queries.findIndex(query => query.includes("insert into runner_leases"));
  const invalidationIndex = queries.findIndex(query => query.includes("update commands"));
  const invalidation = queries[invalidationIndex];
  expect(invalidation).toBeDefined();
  expect(invalidation).toContain("lease_id=");
  expect(invalidation).toContain("state in ('pending','sent')");
  expect(invalidation).toContain("create_lease");
  expect(invalidationIndex).toBeGreaterThan(insertIndex);
});
test("does not query organization capacity while reserving within worker and pool limits", async () => {
  const queries: string[] = [];
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    queries.push(query);
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 4, memoryBytes: 4, storageBytes: 4, concurrency: 2 }, limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 4, maxConcurrentPods: 2 } }];
    if (query.includes("insert into runner_leases")) return [{ id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date().toISOString(), requested: { vcpu: 2, memoryBytes: 2, storageBytes: 2, concurrency: 1 } }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  await expect(reserveRoutingSlot(db, {
    organizationId: "org",
    poolId: "pool",
    workerId: "worker",
    routingKey: "org:pool:labels",
    requested: { vcpu: 2, memoryBytes: 2, storageBytes: 2, concurrency: 1 },
    ttlMs: 60_000,
  })).resolves.toMatchObject({ id: "lease" });
  expect(queries.some(query => query.includes("organization_settings"))).toBe(false);
});

test("exclusive Linux reservations hold disjoint CPU IDs until reaped", async () => {
  const claims: { cpuMode: string; cpuIds: number[]; state: string }[] = [];
  let inventory = [0, 1, 2, 3];
  const resources = { vcpu: 2, memoryBytes: 1, storageBytes: 1, concurrency: 3 };
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ resources, cpuMode: "exclusive", hostPlatform: "linux-arm64", contractVersion: "0.4.0", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 2, maxStorageBytesPerPod: 2, maxConcurrentPods: 3 }, doctor: { doctor: { availableCpuIds: inventory }, capacity: { actualVcpu: 4, actualMemoryBytes: 10, actualStorageBytes: 10, freeVcpu: 4, freeMemoryBytes: 10, freeStorageBytes: 10 } } }];
    if (query.startsWith("select count(*)") && query.includes("pool_id=")) return [{ count: claims.filter(claim => claim.state !== "reaped").length }];
    if (query.startsWith("select count(*)")) return [{ count: claims.filter(claim => claim.state !== "reaped").length, vcpu: claims.filter(claim => claim.state !== "reaped").length * 2, memoryBytes: 0, storageBytes: 0 }];
    if (query.startsWith('select cpu_mode as "cpumode"')) return claims.filter(claim => claim.state !== "reaped");
    if (query.includes("insert into runner_leases")) {
      const cpuIds = values[8] as number[];
      claims.push({ cpuMode: "exclusive", cpuIds, state: "reserved" });
      return [{ id: `lease-${claims.length}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", requested: resources, cpuMode: "exclusive", cpuIds, expiresAt: new Date().toISOString() }];
    }
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  const input = { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool", requested: resources, ttlMs: 60_000 };
  expect((await reserveRoutingSlot(db, input)).cpuIds).toEqual([0, 1]);
  expect((await reserveRoutingSlot(db, input)).cpuIds).toEqual([2, 3]);
  await expect(reserveRoutingSlot(db, input)).rejects.toThrow("worker_capacity_exhausted");
  claims[0]!.state = "failed";
  await expect(reserveRoutingSlot(db, input)).rejects.toThrow("worker_capacity_exhausted");
  claims[0]!.state = "reaped";
  expect((await reserveRoutingSlot(db, input)).cpuIds).toEqual([0, 1]);
  for (const claim of claims) claim.state = "reaped";
  claims.push({ cpuMode: "shared", cpuIds: [], state: "failed" });
  await expect(reserveRoutingSlot(db, input)).rejects.toThrow("worker_capacity_exhausted");
  claims.at(-1)!.state = "reaped";
  inventory = [];
  await expect(reserveRoutingSlot(db, input)).rejects.toThrow("worker_capacity_exhausted");
});
