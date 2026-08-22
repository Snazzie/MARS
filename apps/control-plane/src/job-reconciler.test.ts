import { expect, test } from "bun:test";
import { candidateWorkerFromRow, isDispatchableRunStatus } from "./job-reconciler.ts";
import { fits, parseProvisionLabels, reason, type Candidate } from "./scheduler.ts";

test("keeps queued jobs eligible while their workflow run is in progress", () => {
  expect(isDispatchableRunStatus("queued")).toBe(true);
  expect(isDispatchableRunStatus("in_progress")).toBe(true);
  expect(isDispatchableRunStatus("completed")).toBe(false);
});

const row = {
  worker_admission_state: "adopted",
  worker_connection_state: "online",
  worker_configuration_state: "ready",
  worker_configuration_revision: "current",
  worker_applied_configuration_revision: "current",
  worker_limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 8, maxConcurrentPods: 1 },
};

function candidate(worker: Candidate["worker"]): Candidate {
  return {
    worker,
    pool: { enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["whitesmith-windows-x64"], triggerLabel: "whitesmith-windows-x64" },
    requestedLabels: ["whitesmith-windows-x64"],
  };
}

test("maps desired and applied revisions into scheduler candidates", () => {
  expect(candidateWorkerFromRow(row)).toMatchObject({ configurationRevision: "current", appliedConfigurationRevision: "current" });
});

test("blocks a ready worker whose applied revision is stale", () => {
  const worker = candidateWorkerFromRow({ ...row, worker_applied_configuration_revision: "old" });
  expect(fits(candidate(worker))).toBe(false);
  expect(reason(candidate(worker))).toBe("worker_config_applying");
});

test("reports an online database worker without an authenticated socket as offline", () => {
  const worker = candidateWorkerFromRow({ ...row, worker_connection_state: "online" });
  expect(reason(candidate({ ...worker, connectionState: "offline" }))).toBe("worker_offline");
});

test("parses Windows CPU and memory routing labels", () => {
  expect(parseProvisionLabels(["whitesmith-windows-x64", "10VCPU", "15G"])).toEqual({
    routingLabels: ["whitesmith-windows-x64"],
    vcpu: 10,
    memoryBytes: 15 * 1024 ** 3,
  });
});

test("reports resource ceiling for a connected worker below the requested limits", () => {
  const worker = candidateWorkerFromRow({ ...row, worker_limits: { maxVcpuPerPod: 8, maxMemoryBytesPerPod: 15 * 1024 ** 3, maxStorageBytesPerPod: 50 * 1024 ** 3, maxConcurrentPods: 1 } });
  const value = candidate(worker);
  value.pool.resources = { vcpu: 16, memoryBytes: 20 * 1024 ** 3, storageBytes: 50 * 1024 ** 3, concurrency: 1 };
  value.requestedLabels = ["whitesmith-windows-x64", "10VCPU", "15G"];
  expect(fits(value)).toBe(false);
  expect(reason(value)).toBe("resource_ceiling");
});
