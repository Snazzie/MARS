import { describe, expect, test } from "bun:test";
import { applyLinuxWorkerConfigure, handleLinuxWorkerCommand } from "./linux-agent.ts";
import type { WorkerCommand } from "@whitesmith/contracts";

const workerId = "00000000-0000-4000-8000-000000000001";
const command: WorkerCommand = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000002",
  type: "worker.configure",
  workerId,
  leaseId: null,
  occurredAt: "2026-08-11T00:00:00.000Z",
  payload: {
    workerId,
    appliance: { vcpu: 8, memoryBytes: 16_000, storageBytes: 64_000 },
    runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_000, maxStorageBytesPerPod: 16_000, maxConcurrentPods: 4 },
    guestPlatforms: ["linux-x64"],
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
  },
};

describe("Linux worker.configure", () => {
  test("applies resources and emits exact acknowledged observation", () => {
    const resources = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } };
    const event = applyLinuxWorkerConfigure(command, resources);
    expect(resources).toEqual({ appliance: { vcpu: 8, memoryBytes: 16_000, storageBytes: 64_000 }, runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_000, maxStorageBytesPerPod: 16_000, maxConcurrentPods: 4 } });
    expect(event.type).toBe("worker.configured");
    expect(event.workerId).toBe(workerId);
    expect(event.payload).toEqual({ commandId: command.id, workerId, revision: "a".repeat(64), observed: { appliance: resources.appliance, runtime: resources.runtime, guestPlatforms: ["linux-x64"] } });
  });

  test("consumes only worker.configure", () => {
    const resources = { appliance: { vcpu: 1, memoryBytes: 1, storageBytes: 1 }, runtime: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 } };
    expect(() => handleLinuxWorkerCommand({ ...command, type: "doctor" }, resources)).toThrow("unsupported worker command");
  });
});
