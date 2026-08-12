import { describe, expect, test } from "bun:test";
import { ApproveWorkerRequest, PendingWorkerRequest, WorkerBootstrapRequest, WorkerConfiguration } from "@whitesmith/contracts";
import { createRequestLimiter, hasMachineIdentity, matchesWorkerIdentity, WorkerRequestError } from "./worker-requests.ts";

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
  const valid = { code: "A".repeat(43), platform: "linux-x64", publicKey: "ed25519-public", vmUuid: "00000000-0000-4000-8000-000000000001", machineUuid: "00000000-0000-4000-8000-000000000002", doctor: { probe: true }, capacity: { actualVcpu: 4, actualMemoryBytes: 4096, actualStorageBytes: 8192, freeVcpu: 4, freeMemoryBytes: 4096, freeStorageBytes: 8192 } };
  test("requires stable identity and excludes code from pending DTO", () => {
    expect(WorkerBootstrapRequest.parse(valid).machineUuid).toBe(valid.machineUuid);
    const { code: _code, ...pending } = { ...valid, limits: null };
    expect(PendingWorkerRequest.parse(pending).publicKey).toBe(valid.publicKey);
    expect(PendingWorkerRequest.safeParse(valid).success).toBe(false);
    expect(WorkerBootstrapRequest.safeParse({ ...valid, capacity: { ...valid.capacity, actualVcpu: 1.5 } }).success).toBe(false);
  });
  test("rejects administrator policy during bootstrap", () => {
    expect(WorkerBootstrapRequest.safeParse({ ...valid, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 1024, maxStorageBytesPerPod: 2048, maxConcurrentPods: 1 } }).success).toBe(false);
  });
  test("requires an organization and positive admin limits", () => {
    const limits = { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 1024, maxStorageBytesPerPod: 2048, maxConcurrentPods: 1 };
    expect(ApproveWorkerRequest.safeParse({ organizationId: valid.vmUuid, limits }).success).toBe(true);
    expect(ApproveWorkerRequest.safeParse({ organizationId: valid.vmUuid, limits: { ...limits, maxVcpuPerPod: 0 } }).success).toBe(false);
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
