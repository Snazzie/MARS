import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Sql } from "@mars/db";
import { configurePendingWorker, requestPendingWorker } from "./worker-requests.ts";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";

describe("pending worker persistence", () => {
  test("stores telemetry while leaving policy limits NULL", async () => {
    const queries: string[] = [];
    const queryValues: unknown[][] = [];
    const tx = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => { const sql = strings.join(" "); queries.push(sql); queryValues.push(values); if (sql.includes("select code_hash")) return [{ codeHash: createHash("sha256").update(Buffer.from("A".repeat(43), "base64url")).digest() }]; if (sql.includes("select id,")) return []; if (sql.includes("returning id")) return [{ id: "00000000-0000-4000-8000-000000000003" }]; return []; }, { json: (value: unknown) => value });
    const input = { code: "A".repeat(43), computerName: "build-host", platform: "linux-x64" as const, releaseVersion: "0.1.0", contractVersion: "0.1.0", publicKey: "ed25519-public", encryptionPublicKey: "x25519-public", vmUuid: "00000000-0000-4000-8000-000000000001", machineUuid: "00000000-0000-4000-8000-000000000002", doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
    const telemetry = { doctor: { ...input.doctor, containers: [] }, capacity: input.capacity };
    const db = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => { queries.push(strings.join(" ")); queryValues.push(values); return []; }) as unknown as Sql<{}>, { begin: async (fn: (tx: unknown) => unknown) => fn(tx) });
    const result = await requestPendingWorker(db, input);
    expect(result.status).toBe("created");
    const insertValues = queryValues.find((values, index) => queries[index].includes("insert into workers"));
    const insertIndex = queries.findIndex(query => query.includes("insert into workers"));
    expect(queries.some(query => query.includes("consumed_at is null for update"))).toBe(true);
    expect(queries.some(query => query.includes("set consumed_at=now()"))).toBe(true);
    expect(queries[insertIndex]).toContain(",null,");
    expect(insertValues).toContain(input.computerName);
    expect(insertValues).toEqual(expect.arrayContaining([telemetry]));
  });
});
test("replays a response-lost enrollment only for the exact pending identity", async () => {
  const code = "A".repeat(43);
  const candidate = createHash("sha256").update(Buffer.from(code, "base64url")).digest();
  const input = { code, computerName: "build-host", platform: "linux-x64" as const, releaseVersion: "0.1.0", contractVersion: "0.1.0", publicKey: "ed25519-public", encryptionPublicKey: "x25519-public", vmUuid: "00000000-0000-4000-8000-000000000001", machineUuid: "00000000-0000-4000-8000-000000000002", doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
  const queries: string[] = [];
  const tx = (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (query.includes("consumed_at is not null")) return [{ codeHash: candidate, consumedAt: "2026-08-28T00:00:00.000Z" }];
    if (query.includes("from workers")) return [{
      id: "00000000-0000-4000-8000-000000000003",
      vmUuid: input.vmUuid,
      machineUuid: input.machineUuid,
      fingerprint: createHash("sha256").update(input.publicKey).digest("hex"),
      publicKey: input.publicKey,
      encryptionPublicKey: input.encryptionPublicKey,
      admissionState: "pending",
      enrollmentCodeHash: candidate,
      enrollmentAuthenticatedAt: null,
    }];
    return [];
  };
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, {
    begin: async (fn: (tx: unknown) => unknown) => fn(tx),
  });
  await expect(requestPendingWorker(db, input)).resolves.toEqual({ status: "existing", workerId: "00000000-0000-4000-8000-000000000003" });
  expect(queries.some(query => query.includes("set consumed_at=now()"))).toBe(false);
});

test("rejects consumed-code replay with a different key or machine identity", async () => {
  const code = "A".repeat(43);
  const candidate = createHash("sha256").update(Buffer.from(code, "base64url")).digest();
  const input = { code, computerName: "build-host", platform: "linux-x64" as const, releaseVersion: "0.1.0", contractVersion: "0.1.0", publicKey: "ed25519-public", encryptionPublicKey: "x25519-public", vmUuid: "00000000-0000-4000-8000-000000000001", machineUuid: "00000000-0000-4000-8000-000000000002", doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
  const tx = (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("consumed_at is not null")) return [{ codeHash: candidate, consumedAt: "2026-08-28T00:00:00.000Z" }];
    if (query.includes("from workers")) return [{
      id: "00000000-0000-4000-8000-000000000003",
      vmUuid: input.vmUuid,
      machineUuid: input.machineUuid,
      fingerprint: createHash("sha256").update(input.publicKey).digest("hex"),
      publicKey: input.publicKey,
      encryptionPublicKey: "different-encryption-key",
      admissionState: "pending",
      enrollmentCodeHash: candidate,
      enrollmentAuthenticatedAt: null,
    }];
    return [];
  };
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, {
    begin: async (fn: (tx: unknown) => unknown) => fn(tx),
  });
  await expect(requestPendingWorker(db, input)).rejects.toMatchObject({ code: "identity_conflict", status: 409 });
});

test("reusable development code enrolls distinct identities without touching bootstrap credentials", async () => {
  const code = "A".repeat(43);
  const codeHash = createHash("sha256").update(Buffer.from(code, "base64url")).digest();
  const workers: Array<{ id: string; vmUuid: string; machineUuid: string; fingerprint: string; encryptionPublicKey: string }> = [];
  const queries: string[] = [];
  const tx = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    queries.push(sql);
    if (sql.includes("from workers")) return workers.filter(row => [row.vmUuid, row.machineUuid, row.fingerprint].some(value => values.includes(value))).map(row => ({ ...row, admissionState: "pending", enrollmentAuthenticatedAt: null }));
    if (sql.includes("insert into workers")) {
      const id = `00000000-0000-4000-8000-${String(workers.length + 1).padStart(12, "0")}`;
      workers.push({ id, vmUuid: String(values[9]), machineUuid: String(values[10]), fingerprint: String(values[8]), encryptionPublicKey: String(values[7]) });
      return [{ id }];
    }
    return [];
  }, { json: (value: unknown) => value });
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (transaction: unknown) => unknown) => fn(tx) });
  const input = { code, computerName: "host", platform: "linux-x64" as const, releaseVersion: "0.1.0", contractVersion: "0.1.0", publicKey: "key-one", encryptionPublicKey: "enc-one", vmUuid: "00000000-0000-4000-8000-000000000011", machineUuid: "00000000-0000-4000-8000-000000000012", doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
  const credential = { codeHash, reusable: true as const };
  expect((await requestPendingWorker(db, input, undefined, undefined, credential)).status).toBe("created");
  expect((await requestPendingWorker(db, { ...input, vmUuid: "00000000-0000-4000-8000-000000000021", machineUuid: "00000000-0000-4000-8000-000000000022", publicKey: "key-two", encryptionPublicKey: "enc-two" }, undefined, undefined, credential)).status).toBe("created");
  await expect(requestPendingWorker(db, { ...input, code: "B".repeat(43) }, undefined, undefined, credential)).rejects.toMatchObject({ status: 401 });
  await expect(requestPendingWorker(db, { ...input, machineUuid: "00000000-0000-4000-8000-000000000022" }, undefined, undefined, credential)).rejects.toMatchObject({ status: 409 });
  expect(workers).toHaveLength(2);
  expect(queries.some(query => query.includes("worker_bootstrap_credentials"))).toBe(false);
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
  const configuration = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, selectedDriver: "tart-vm" as const };
  await expect(configurePendingWorker(db, "worker", configuration, "admin", dispatcher, "same-key")).resolves.toEqual(result);
  expect(queries.some(query => query.includes("update workers"))).toBe(false);
});
test("accepts independent per-job ceilings without multiplying by concurrency", async () => {
  const tx = (strings: TemplateStringsArray) => {
    const sql = strings.join(" ");
    if (sql.includes("select id, doctor")) return [{ id: "worker", doctor: { doctor: { capabilities: [{ driver: "tart-vm", guestPlatform: "macos-arm64", imageDigest: "sha256:" + "a".repeat(64), ready: true, remediation: null }] }, capacity: { freeVcpu: 1, freeMemoryBytes: 1, freeStorageBytes: 1 } }, doctorObservedAt: new Date(), admissionState: "pending", platform: "macos-arm64", guestPlatforms: ["macos-arm64"], draining: false }];
    return [];
  };
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (transaction: unknown) => unknown) => fn(tx) });
  const configuration = { appliance: { vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes: 30 * 1024 ** 3 }, runtime: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 10 }, selectedDriver: "tart-vm" as const };
  await expect(configurePendingWorker(db, "worker", configuration, "admin")).resolves.toMatchObject({ revision: expect.any(String), fingerprint: expect.any(String), commandId: expect.any(String) });
});

test("configures a newly approved worker without draining, but requires drain to switch a configured driver", async () => {
  const imageDigest = "ghcr.io/example/job@sha256:" + "a".repeat(64);
  const configuration = { appliance: { vcpu: 12, memoryBytes: 32 * 1024 ** 3, storageBytes: 1024 * 1024 ** 3 }, runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 20 * 1024 ** 3, maxConcurrentPods: 1 }, guestPlatforms: ["linux-arm64" as const], selectedDriver: "linux-docker-container" as const };
  let previous: unknown = null;
  const tx = (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("select id, doctor")) return [{
      id: "worker", doctor: { doctor: { capabilities: [{ driver: configuration.selectedDriver, guestPlatform: "linux-arm64", imageDigest, ready: true, remediation: null }] } },
      doctorObservedAt: new Date(), admissionState: "adopted", platform: "windows-x64", guestPlatforms: ["windows-x64"], draining: false, desiredConfiguration: previous,
    }];
    if (query.includes("select count(*)::int as count from runner_leases")) return [{ count: 0 }];
    return [];
  };
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, { begin: async (fn: (transaction: unknown) => unknown) => fn(tx) });
  await expect(configurePendingWorker(db, "worker", configuration, "admin")).resolves.toMatchObject({ revision: expect.any(String) });
  previous = { ...configuration, guestPlatforms: ["windows-x64"], selectedDriver: "windows-hyperv-container" };
  await expect(configurePendingWorker(db, "worker", configuration, "admin")).rejects.toThrow("requires drained worker");
});

test("stores desired configuration and waits for acknowledgement", async () => {
  const queries: string[] = [];
  const parameters: unknown[][] = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    queries.push(query);
    parameters.push(values);
    if (query.includes("select count(*)::int as count from runner_leases")) return [{ count: 0 }];
    if (query.includes("select id, doctor")) return [{
      id: "worker",
      doctor: { doctor: { capabilities: [{ driver: "windows-hyperv-container", guestPlatform: "windows-x64", imageDigest: "sha256:" + "a".repeat(64), ready: true, remediation: null }] }, capacity: { freeVcpu: 4, freeMemoryBytes: 4 * 1024 ** 3, freeStorageBytes: 30 * 1024 ** 3 } },
      doctorObservedAt: new Date(),
      admissionState: "adopted",
      platform: "windows-x64",
      guestPlatforms: ["windows-x64"],
      draining: true,
    }];
    return [];
  };
  const db = Object.assign(((strings: TemplateStringsArray) => []) as unknown as Sql<{}>, {
    begin: async (fn: (transaction: unknown) => unknown) => fn(tx),
  });
  const configuration = {
    appliance: { vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes: 30 * 1024 ** 3 },
    runtime: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 },
    guestPlatforms: ["windows-x64" as const],
    selectedDriver: "windows-hyperv-container" as const,
    cache: { ttlSeconds: 3600 },
  };
  await configurePendingWorker(db, "worker", configuration, "admin");
  const update = queries.find(query => query.includes("update workers set"));
  expect(update).toContain("desired_configuration=");
  expect(update).toContain("configuration_state='applying'");
  const updateValues = parameters[queries.indexOf(update!)];
  expect(updateValues).toContainEqual(configuration.runtime);
  expect(updateValues).toContainEqual(configuration.guestPlatforms);
  expect(parameters.flat()).toContainEqual(expect.objectContaining({ cache: { ttlSeconds: 3600, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } }));
  expect(updateValues.some(value => typeof value === "string" && (value.startsWith("{") || value.startsWith("[")))).toBe(false);
});
