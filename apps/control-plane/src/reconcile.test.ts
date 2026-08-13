import { expect, test } from "bun:test";
import { reconcileQueuedJobs } from "./reconcile.ts";

test("reserves a runner slot before requesting JIT config", async () => {
  const order: string[] = [];
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["self-hosted", "macos", "arm64", "whitesmith-default"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["self-hosted", "macos", "arm64", "whitesmith-default"], triggerLabel: "whitesmith-default" } }],
    reserve: async () => { order.push("reserve"); return { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    jit: async () => { order.push("jit"); return { encodedJitConfig: "config", runnerName: "runner", labels: ["self-hosted"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async () => { order.push("dispatch"); },
  });
  expect(result.reserved).toBe(1);
  expect(order).toEqual(["reserve", "jit", "dispatch"]);
});

test("does not reserve beyond active pool capacity", async () => {
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 9, labels: ["self-hosted", "macos", "arm64", "whitesmith-default"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 1, labels: ["self-hosted", "macos", "arm64", "whitesmith-default"], triggerLabel: "whitesmith-default" } }],
    reserve: async () => { throw new Error("must not reserve"); },
    jit: async () => { throw new Error("must not generate"); },
    dispatch: async () => {},
  });
  expect(result.skipped).toBe(1);
});
