import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { configurePendingWorker, requestPendingWorker } from "./worker-requests.ts";
import type { WorkerCommandDispatcher } from "./worker-dispatch.ts";

const id = "00000000-0000-4000-8000-000000000003";
const vmUuid = "00000000-0000-4000-8000-000000000001";
const machineUuid = "00000000-0000-4000-8000-000000000002";
const code = "A".repeat(43);
const candidate = createHash("sha256").update(Buffer.from(code, "base64url")).digest();
const input = { code, computerName: "build-host", platform: "linux-x64" as const, releaseVersion: "0.1.0", contractVersion: "0.1.0", publicKey: "ed25519-public", encryptionPublicKey: "x25519-public", vmUuid, machineUuid, doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
const freshWorker = (overrides: Record<string, unknown> = {}) => ({ id, vmUuid, machineUuid, fingerprint: createHash("sha256").update(input.publicKey).digest("hex"), encryptionPublicKey: input.encryptionPublicKey, admissionState: "pending", enrollmentCodeHash: candidate, enrollmentAuthenticatedAt: null, ...overrides });


test("replays a response-lost enrollment only for the exact pending identity", async () => {
  let replayTouched = false;
  const db = preparedTestDatabase(name => {
    if (name === "worker_request_bootstrap_active") return [];
    if (name === "worker_request_bootstrap_consumed") return [{ codeHash: candidate, consumedAt: new Date() }];
    if (name === "worker_request_identity_rows") return [freshWorker()];
    if (name === "worker_request_touch_replay") { replayTouched = true; return []; }
    return [];
  });
  await expect(requestPendingWorker(db, input)).resolves.toEqual({ status: "existing", workerId: id });
  expect(replayTouched).toBe(true);
});

test("rejects consumed-code replay with a different key or machine identity", async () => {
  const db = preparedTestDatabase(name => {
    if (name === "worker_request_bootstrap_active") return [];
    if (name === "worker_request_bootstrap_consumed") return [{ codeHash: candidate, consumedAt: new Date() }];
    if (name === "worker_request_identity_rows") return [freshWorker({ encryptionPublicKey: "different-encryption-key" })];
    return [];
  });
  await expect(requestPendingWorker(db, input)).rejects.toMatchObject({ code: "identity_conflict", status: 409 });
});

test("reusable development code enrolls distinct identities without touching bootstrap credentials", async () => {
  const workers: Array<{ id: string; vmUuid: string; machineUuid: string; fingerprint: string; encryptionPublicKey: string }> = [];
  const db = preparedTestDatabase((name, params) => {
    if (name === "worker_request_identity_rows") return workers.filter(row => [row.vmUuid, row.machineUuid, row.fingerprint].some(value => Object.values(params).includes(value))).map(row => ({ ...row, admissionState: "pending", enrollmentCodeHash: candidate, enrollmentAuthenticatedAt: null }));
    if (name === "worker_request_create") {
      workers.push({ id: `worker-${workers.length + 1}`, vmUuid: String(params.vmUuid), machineUuid: String(params.machineUuid), fingerprint: String(params.fingerprint), encryptionPublicKey: String(params.encryptionPublicKey) });
      return [{ id: workers.at(-1)!.id }];
    }
    return [];
  });
  const credential = { codeHash: candidate, reusable: true as const };
  expect((await requestPendingWorker(db, input, undefined, undefined, credential)).status).toBe("created");
  expect((await requestPendingWorker(db, { ...input, vmUuid: "00000000-0000-4000-8000-000000000021", machineUuid: "00000000-0000-4000-8000-000000000022", publicKey: "key-two", encryptionPublicKey: "enc-two" }, undefined, undefined, credential)).status).toBe("created");
  await expect(requestPendingWorker(db, { ...input, code: "B".repeat(43) }, undefined, undefined, credential)).rejects.toMatchObject({ status: 401 });
  await expect(requestPendingWorker(db, { ...input, machineUuid: "00000000-0000-4000-8000-000000000022" }, undefined, undefined, credential)).rejects.toMatchObject({ status: 409 });
  expect(workers).toHaveLength(2);
});

test("replays completed configuration idempotency response without mutating", async () => {
  const result = { revision: "r", fingerprint: "f", commandId: "c" };
  const db = preparedTestDatabase(name => name === "worker_request_mutation_prior" ? [{ response: result }] : []);
  const dispatcher = { replayConnected() { throw new Error("must not dispatch replay for duplicate"); } } as unknown as WorkerCommandDispatcher;
  const configuration = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 }, selectedDriver: "tart-vm" as const };
  await expect(configurePendingWorker(db, "worker", configuration, "admin", dispatcher, "same-key")).resolves.toEqual(result);
});

test("accepts independent per-job ceilings without multiplying by concurrency", async () => {
  const db = preparedTestDatabase(name => name === "worker_request_configure_lock" ? [{ id: "worker", doctor: { doctor: { capabilities: [{ driver: "tart-vm", guestPlatform: "macos-arm64", imageDigest: `sha256:${"a".repeat(64)}`, ready: true, remediation: null }] }, capacity: { freeVcpu: 1, freeMemoryBytes: 1, freeStorageBytes: 1 } }, doctorObservedAt: new Date(), admissionState: "pending", platform: "macos-arm64", guestPlatforms: ["macos-arm64"], draining: false, contractVersion: "0.1.0", desiredConfiguration: null }] : []);
  const configuration = { appliance: { vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes: 30 * 1024 ** 3 }, runtime: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 10 }, selectedDriver: "tart-vm" as const };
  await expect(configurePendingWorker(db, "worker", configuration, "admin")).resolves.toMatchObject({ revision: expect.any(String), fingerprint: expect.any(String), commandId: expect.any(String) });
});

test("configures a newly approved worker without draining, but requires drain to switch a configured driver", async () => {
  const imageDigest = `ghcr.io/example/job@sha256:${"a".repeat(64)}`;
  const configuration = { appliance: { vcpu: 12, memoryBytes: 32 * 1024 ** 3, storageBytes: 1024 * 1024 ** 3 }, runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 20 * 1024 ** 3, maxConcurrentPods: 1 }, guestPlatforms: ["linux-arm64" as const], selectedDriver: "linux-docker-container" as const };
  let previous: unknown = null;
  const db = preparedTestDatabase((name, params) => {
    if (name === "worker_request_configure_lock") return [{ id: "worker", doctor: { doctor: { capabilities: [{ driver: configuration.selectedDriver, guestPlatform: "linux-arm64", imageDigest, ready: true, remediation: null }] } }, doctorObservedAt: new Date(), admissionState: "adopted", platform: "windows-x64", guestPlatforms: ["windows-x64"], draining: false, contractVersion: "0.1.0", desiredConfiguration: previous }];
    if (name === "worker_request_active_lease_count") return [{ count: 0 }];
    if (name === "worker_request_set_configuration") previous = JSON.parse(String(params.desired));
    return [];
  });
  await expect(configurePendingWorker(db, "worker", configuration, "admin")).resolves.toMatchObject({ revision: expect.any(String) });
  previous = { ...configuration, guestPlatforms: ["windows-x64"], selectedDriver: "windows-hyperv-container" };
  await expect(configurePendingWorker(db, "worker", configuration, "admin")).rejects.toThrow("requires drained worker");
});

test("stores desired configuration and waits for acknowledgement", async () => {
  let stored: Record<string, unknown> | undefined;
  const db = preparedTestDatabase((name, params) => {
    if (name === "worker_request_active_lease_count") return [{ count: 0 }];
    if (name === "worker_request_configure_lock") return [{ id: "worker", doctor: { doctor: { capabilities: [{ driver: "windows-hyperv-container", guestPlatform: "windows-x64", imageDigest: `sha256:${"a".repeat(64)}`, ready: true, remediation: null }] }, capacity: { freeVcpu: 4, freeMemoryBytes: 4 * 1024 ** 3, freeStorageBytes: 30 * 1024 ** 3 } }, doctorObservedAt: new Date(), admissionState: "adopted", platform: "windows-x64", guestPlatforms: ["windows-x64"], draining: true, contractVersion: "0.1.0", desiredConfiguration: null }];
    if (name === "worker_request_set_configuration") stored = params;
    return [];
  });
  const configuration = { appliance: { vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes: 30 * 1024 ** 3 }, runtime: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 }, guestPlatforms: ["windows-x64" as const], selectedDriver: "windows-hyperv-container" as const, cache: { ttlSeconds: 3600 } };
  await configurePendingWorker(db, "worker", configuration, "admin");
  expect(JSON.parse(String(stored?.desired))).toMatchObject({ ...configuration, cache: { ttlSeconds: 3600, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 } });
  expect(JSON.parse(String(stored?.runtime))).toEqual(configuration.runtime);
  expect(JSON.parse(String(stored?.guestPlatforms))).toEqual(configuration.guestPlatforms);
});
