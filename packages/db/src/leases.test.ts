import { expect, test } from "bun:test";
import { preparedTestDatabase } from "./prepared-test-fixture.ts";
import { bindLeaseToJob, reserveRoutingSlot } from "./leases.ts";

type Fixture = {
  eligible?: Record<string, unknown>[];
  poolActive?: Record<string, unknown>[];
  workerActive?: Record<string, unknown>[];
  cpuLeases?: Record<string, unknown>[];
  reserved?: Record<string, unknown>[];
  bound?: Record<string, unknown>[];
  existing?: Record<string, unknown>[];
};
function client(fixture: Fixture) {
  const db = preparedTestDatabase((name) => {
    if (name === "lease_eligible_worker_pool") return fixture.eligible ?? [];
    if (name === "lease_active_pool_count") return fixture.poolActive ?? [{ count: 0 }];
    if (name === "lease_active_worker_capacity") return fixture.workerActive ?? [{ count: 0, vcpu: 0, memoryBytes: 0, storageBytes: 0 }];
    if (name === "lease_worker_cpu_claims") return fixture.cpuLeases ?? [];
    if (name === "lease_reserve_routing_slot") return fixture.reserved ?? [];
    if (name === "lease_bind_github_job") return fixture.bound ?? [];
    if (name === "lease_get_job_binding") return fixture.existing ?? [];
    return [];
  });
  return db;
}
const request = { organizationId: "org", poolId: "pool", workerId: "worker", routingKey: "org:pool:labels", requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, ttlMs: 60_000 };
const eligible = { id: "pool", resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, cpuMode: "shared", platform: "linux", driver: "docker", imageDigest: "sha256:x", workerId: "worker", hostPlatform: "linux-x64", contractVersion: "1.0.0", limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, doctor: { capacity: { actualVcpu: 1, actualMemoryBytes: 1, actualStorageBytes: 1, freeVcpu: 1, freeMemoryBytes: 1, freeStorageBytes: 1 } } };
const reserved = { id: "00000000-0000-4000-8000-000000000001", jobId: null, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", requested: request.requested, cpuMode: "shared", cpuIds: null, expiresAt: new Date().toISOString() };

test("reserves an eligible routing slot transactionally", async () => {
  const result = await reserveRoutingSlot(client({ eligible: [eligible], reserved: [reserved] }), request);
  expect(result).toMatchObject({ id: reserved.id, workerId: "worker", poolId: "pool", cpuMode: "shared", cpuIds: null });
});

test("rejects reservation when the worker row is no longer eligible", async () => {
  await expect(reserveRoutingSlot(client({ eligible: [] }), request)).rejects.toThrow("worker_not_eligible");
});

test("preserves worker and pool concurrency admission errors", async () => {
  await expect(reserveRoutingSlot(client({ eligible: [eligible], poolActive: [{ count: 1 }] }), request)).rejects.toThrow("pool_capacity_exhausted");
  await expect(reserveRoutingSlot(client({ eligible: [eligible], workerActive: [{ count: 1, vcpu: 0, memoryBytes: 0, storageBytes: 0 }] }), request)).rejects.toThrow("worker_capacity_exhausted");
});

test("normalizes postgres timestamp strings in reservation results", async () => {
  const db = client({ eligible: [eligible], reserved: [{ ...reserved, expiresAt: "2026-08-20 18:36:34.099+01" }] });
  expect((await reserveRoutingSlot(db, request)).expiresAt).toBe("2026-08-20T17:36:34.099Z");
});

test("binds a GitHub job once and accepts an idempotent replay", async () => {
  await expect(bindLeaseToJob(client({ bound: [{ id: "lease" }] }), "lease", 123)).resolves.toBeUndefined();
  await expect(bindLeaseToJob(client({ existing: [{ githubJobId: 123 }] }), "lease", 123)).resolves.toBeUndefined();
});

test("rejects a conflicting GitHub job binding", async () => {
  await expect(bindLeaseToJob(client({ existing: [{ githubJobId: 456 }] }), "lease", 123)).rejects.toThrow("lease_job_conflict");
});
