import { expect, test } from "bun:test";
import type { Sql } from "postgres";
import { reserveRoutingSlot, bindLeaseToJob } from "./leases.ts";

test("reserves a routing slot before any JIT request", async () => {
  const queries: string[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(strings.join(" "));
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } }];
    if (query.includes("insert into runner_leases")) return [{ id: "00000000-0000-4000-8000-000000000001", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date().toISOString() }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  const result = await reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 });
  expect(result.id).toBe("00000000-0000-4000-8000-000000000001");
  expect(queries.some((query) => query.toLowerCase().includes("insert into runner_leases"))).toBe(true);
});
test("reserves when current free capacity already includes active leases", async () => {
  const tx = ((strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from runner_pools")) return [{ id: "pool", workerId: "worker", resources: { vcpu: 10, memoryBytes: 10, storageBytes: 10, concurrency: 10 }, limits: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10, maxStorageBytesPerPod: 10, maxConcurrentPods: 10 }, doctor: { capacity: { freeVcpu: 4, freeMemoryBytes: 4, freeStorageBytes: 4 } } }];
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
    if (query.includes("from runner_leases")) return [{ count: 1, vcpu: 3, memoryBytes: 3, storageBytes: 3 }];
    return [];
  }) as unknown as Sql<{}>;
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (value: Sql<{}>) => unknown) => fn(tx) });
  await expect(reserveRoutingSlot(db, { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 5, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 })).rejects.toThrow("worker_capacity_exhausted");
});

test("binds a GitHub job only once", async () => {
  const queries: string[] = [];
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => { queries.push(strings.join(" ")); return [{ id: "lease" }]; }) as unknown as Sql<{}>;
  await bindLeaseToJob(db, "lease", 123);
  expect(queries[0]).toContain("github_job_id");
});
