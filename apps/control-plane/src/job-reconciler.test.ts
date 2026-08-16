import { expect, test } from "bun:test";
import { candidateWorkerFromRow } from "./job-reconciler.ts";
import { fits, reason, type Candidate } from "./scheduler.ts";

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
