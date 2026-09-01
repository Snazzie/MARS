import { describe, expect, test } from "bun:test";
import { ApproveWorkerRequest, PendingWorkerRequest, WorkerBootstrapRequest, WorkerConfiguration } from "@mars/contracts";
import { createRequestLimiter, hasMachineIdentity, matchesWorkerIdentity, purgeWorkerRunnerCache, WorkerRequestError } from "./worker-requests.ts";
import { pendingWorkerDto } from "./http/worker-routes.ts";

test("post-enrollment configuration is strict and excludes organization binding", () => {
  const configuration = {
    appliance: { vcpu: 4, memoryBytes: 16 * 1024 ** 3, storageBytes: 100 * 1024 ** 3 },
    runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 40 * 1024 ** 3, maxConcurrentPods: 2 },
  };
  expect(WorkerConfiguration.safeParse(configuration).success).toBe(true);
  expect(WorkerConfiguration.safeParse({ ...configuration, organizationId: "org" }).success).toBe(false);
  expect(WorkerConfiguration.safeParse({ ...configuration, runtime: { ...configuration.runtime, maxVcpuPerPod: 5 } }).success).toBe(true);
});

describe("pending worker request contracts", () => {
  const valid = { code: "A".repeat(43), platform: "linux-x64", publicKey: "ed25519-public", encryptionPublicKey: "x25519-public", vmUuid: "00000000-0000-4000-8000-000000000001", machineUuid: "00000000-0000-4000-8000-000000000002", doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
  test("requires stable identity and excludes code from pending DTO", () => {
    expect(WorkerBootstrapRequest.parse(valid).machineUuid).toBe(valid.machineUuid);
    const { code: _code, encryptionPublicKey: _encryptionPublicKey, ...pending } = { ...valid, limits: null };
    expect(PendingWorkerRequest.parse(pending).publicKey).toBe(valid.publicKey);
    expect(PendingWorkerRequest.safeParse(valid).success).toBe(false);
    expect(WorkerBootstrapRequest.safeParse({ ...valid, capacity: { ...valid.capacity, actualVcpu: 1.5 } }).success).toBe(false);
  });
  test("rejects administrator policy during bootstrap", () => {
    expect(WorkerBootstrapRequest.safeParse({ ...valid, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 1024, maxStorageBytesPerPod: 2048, maxConcurrentPods: 1 } }).success).toBe(false);
  });
  test("accepts positive global worker limits without organization ownership", () => {
    const limits = { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 1024, maxStorageBytesPerPod: 2048, maxConcurrentPods: 1 };
    expect(ApproveWorkerRequest.safeParse({ limits }).success).toBe(true);
    expect(ApproveWorkerRequest.safeParse({ limits: { ...limits, maxVcpuPerPod: 0 } }).success).toBe(false);
  });
});

test("pending worker DTO ignores database-only columns", () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000003",
    name: "worker",
    platform: "macos-arm64" as const,
    admissionState: "pending",
    connectionState: "offline",
    configurationState: "unconfigured",
    publicKey: "ed25519-public",
    encryptionPublicKey: "x25519-public",
    fingerprint: "fingerprint",
    vmUuid: "00000000-0000-4000-8000-000000000001",
    machineUuid: "00000000-0000-4000-8000-000000000002",
    limits: null,
    doctor: {
      doctor: { probe: true },
      capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 },
    },
    lastRequestedAt: new Date(),
  };
  expect(pendingWorkerDto(row)).toEqual({
    id: row.id,
    fingerprint: row.fingerprint,
    platform: row.platform,
    guestPlatforms: ["macos-arm64"],
    publicKey: row.publicKey,
    vmUuid: row.vmUuid,
    machineUuid: row.machineUuid,
    limits: null,
    doctor: { ...row.doctor.doctor, containers: [] },
    capacity: row.doctor.capacity,
    admissionState: "pending",
    connectionState: "offline",
    configurationState: "unconfigured",
  });
});

test("pending worker DTO fails closed when legacy telemetry lacks capacity", () => {
  const row = {
    id: "00000000-0000-0000-0000-000000000003",
    platform: "windows-x64" as const,
    admissionState: "pending",
    connectionState: "offline",
    configurationState: "unconfigured",
    publicKey: "ed25519-public",
    fingerprint: "fingerprint",
    vmUuid: "00000000-0000-0000-0000-000000000001",
    machineUuid: "00000000-0000-0000-0000-000000000002",
    limits: null,
    doctor: { probe: true },
  };
  expect(pendingWorkerDto(row)).toMatchObject({
    capacity: { actualVcpu: 0, actualMemoryBytes: 0, actualStorageBytes: 0, freeVcpu: 0, freeMemoryBytes: 0, freeStorageBytes: 0 },
    doctor: { probe: true },
  });
});

test("reused machine identity is not an exact reconnect", () => {
  const row = { vmUuid: "vm-original", machineUuid: "machine-original", fingerprint: "fp-original" };
  expect(matchesWorkerIdentity(row, { vmUuid: "vm-new", machineUuid: "machine-original" }, "fp-new")).toBe(false);
});


test("legacy rows without machine identity are quarantined from approval", () => {
  expect(hasMachineIdentity({ machineUuid: null })).toBe(false);
  expect(hasMachineIdentity({ machineUuid: "machine-1" })).toBe(true);
});
test("invalid bootstrap attempts are limited per trusted source and successful requests clear the bucket", () => {
  const limiter = createRequestLimiter();
  expect(Array.from({ length: 5 }, () => limiter.allow("source-a")).every(Boolean)).toBe(true);
  expect(limiter.allow("source-a")).toBe(false);
  expect(limiter.allow("source-b")).toBe(true);
  limiter.clear("source-a");
  expect(limiter.allow("source-a")).toBe(true);
  expect(new WorkerRequestError("invalid_bootstrap").status).toBe(401);
  expect(new WorkerRequestError("identity_conflict").status).toBe(409);
});
describe("durable runner cache purge", () => {
  const workerId = "cbb0e9d8-23ff-480e-8465-408197c0c2d2";
  const makeDb = (prior: { workerId: string; commandId: string } | null = null) => {
    const queries: string[] = [];
    type FakeQuery = {
      (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
      begin<T>(fn: (tx: FakeQuery) => Promise<T>): Promise<T>;
    };
    const query = (async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      queries.push(text);
      if (text.includes("select response from worker_mutations")) return prior ? [{ response: prior }] : [];
      if (text.includes("select id,admission_state")) return [{ id: workerId, admissionState: "adopted" }];
      return [];
    }) as FakeQuery;
    query.begin = async <T>(fn: (tx: FakeQuery) => Promise<T>) => fn(query);
    return { db: query as never, queries };
  };
  test("persists an authenticated no-lease purge command and audit event", async () => {
    const { db, queries } = makeDb();
    const replayed: string[] = [];
    const result = await purgeWorkerRunnerCache(db, workerId, "admin", { replayConnected: async id => { replayed.push(id); } }, "purge-once");
    expect(result.workerId).toBe(workerId);
    expect(result.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(replayed).toEqual([workerId]);
    expect(queries.some(query => query.includes("'worker.runner_cache_purge'"))).toBe(true);
    expect(queries.some(query => query.includes("'worker.runner_cache_purge_requested'"))).toBe(true);
    expect(queries.some(query => query.includes("worker_mutations"))).toBe(true);
  });

  test("returns an idempotent command without replaying or inserting it again", async () => {
    const prior = { workerId, commandId: "b430a582-a516-48a6-abb9-72c1af04a8c3" };
    const { db, queries } = makeDb(prior);
    const replayed: string[] = [];
    await expect(purgeWorkerRunnerCache(db, workerId, "admin", { replayConnected: async id => { replayed.push(id); } }, "purge-once")).resolves.toEqual(prior);
    expect(replayed).toEqual([]);
    expect(queries.some(query => query.includes("insert into commands"))).toBe(false);
  });
});
