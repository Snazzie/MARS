import { describe, expect, test } from "bun:test";
import { ApproveWorkerRequest, PendingWorkerRequest, WorkerBootstrapRequest } from "@whitesmith/contracts";
import { createRequestLimiter, WorkerRequestError } from "./worker-requests.ts";

describe("pending worker request contracts", () => {
  const valid = { code: "A".repeat(43), platform: "linux-x64", publicKey: "ed25519-public", vmUuid: "00000000-0000-4000-8000-000000000001", machineUuid: "00000000-0000-4000-8000-000000000002", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 1024, maxStorageBytesPerPod: 2048, maxConcurrentPods: 1 }, doctor: { probe: true }, capacity: { vcpu: 4 } };
  test("requires stable identity and excludes code from pending DTO", () => {
    expect(WorkerBootstrapRequest.parse(valid).machineUuid).toBe(valid.machineUuid);
    const { code: _code, ...pending } = valid;
    expect(PendingWorkerRequest.parse(pending).publicKey).toBe(valid.publicKey);
    expect(PendingWorkerRequest.safeParse(valid).success).toBe(false);
  });
  test("requires an organization and positive admin limits", () => {
    expect(ApproveWorkerRequest.safeParse({ organizationId: valid.vmUuid, limits: valid.limits }).success).toBe(true);
    expect(ApproveWorkerRequest.safeParse({ organizationId: valid.vmUuid, limits: { ...valid.limits, maxVcpuPerPod: 0 } }).success).toBe(false);
  });
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
