import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { configurePendingWorker, requestPendingWorker } from "./worker-requests.ts";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";

describe("pending worker persistence", () => {
  test("stores telemetry while leaving policy limits NULL", async () => {
    const queries: string[] = [];
    const queryValues: unknown[][] = [];
    const tx = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => { const sql = strings.join(" "); queries.push(sql); queryValues.push(values); if (sql.includes("select code_hash")) return [{ codeHash: createHash("sha256").update(Buffer.from("A".repeat(43), "base64url")).digest() }]; if (sql.includes("select id,")) return []; if (sql.includes("returning id")) return [{ id: "00000000-0000-4000-8000-000000000003" }]; return []; }, { json: (value: unknown) => value });
    const input = { code: "A".repeat(43), platform: "linux-x64" as const, publicKey: "ed25519-public", encryptionPublicKey: "x25519-public", vmUuid: "00000000-0000-4000-8000-000000000001", machineUuid: "00000000-0000-4000-8000-000000000002", doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
    const telemetry = { doctor: input.doctor, capacity: input.capacity };
    const db = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => { queries.push(strings.join(" ")); queryValues.push(values); return []; }) as unknown as Sql<{}>, { begin: async (fn: (tx: unknown) => unknown) => fn(tx) });
    const result = await requestPendingWorker(db, input);
    expect(result.status).toBe("created");
    const insertValues = queryValues.find((values, index) => queries[index].includes("insert into workers"));
    const insertIndex = queries.findIndex(query => query.includes("insert into workers"));
    expect(queries.some(query => query.includes("consumed_at is null for update"))).toBe(true);
    expect(queries.some(query => query.includes("set consumed_at=now()"))).toBe(true);
    expect(queries[insertIndex]).toContain(",null,");
    expect(insertValues).toEqual(expect.arrayContaining([telemetry]));
  });
});

test("replays completed configuration idempotency response without mutating", async () => {
  const result = { revision: "r", fingerprint: "f", commandId: "c" };
  const queries: string[] = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    queries.push(sql);
    if (sql.includes("select response from worker_mutations")) return [{ response: result }];
    return [];
  };
  const db = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => []) as unknown as Sql<{}>, {
    begin: async (fn: (transaction: unknown) => unknown) => fn(tx),
  });
  const dispatcher = { replayConnected() { throw new Error("must not dispatch replay for duplicate"); } } as unknown as WorkerCommandDispatcher;
  const configuration = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } };
  await expect(configurePendingWorker(db, "worker", configuration, "admin", dispatcher, "same-key")).resolves.toEqual(result);
  expect(queries.some(query => query.includes("update workers"))).toBe(false);
});
test("accepts independent per-job ceilings without multiplying by concurrency", async () => {
  const tx = (strings: TemplateStringsArray) => {
    const sql = strings.join(" ");
    if (sql.includes("select id, doctor")) return [{ id: "worker", doctor: { capacity: { freeVcpu: 4, freeMemoryBytes: 4 * 1024 ** 3, freeStorageBytes: 30 * 1024 ** 3 } }, admissionState: "pending", platform: "macos-arm64", guestPlatforms: ["macos-arm64"], draining: false }];
    return [];
  };
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (transaction: unknown) => unknown) => fn(tx) });
  const configuration = { appliance: { vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes: 30 * 1024 ** 3 }, runtime: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 10 } };
  await expect(configurePendingWorker(db, "worker", configuration, "admin")).resolves.toMatchObject({ revision: expect.any(String), fingerprint: expect.any(String), commandId: expect.any(String) });
});
