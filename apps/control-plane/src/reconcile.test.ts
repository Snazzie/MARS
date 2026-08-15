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

test("attempts at most one admissible job per installation", async () => {
  const jitInstallations: number[] = [];
  let lease = 0;
  const result = await reconcileQueuedJobs({
    queued: [
      { installationId: 42, repositoryId: 1, repository: "acme/one", runId: 1, jobId: 1, labels: ["whitesmith-windows-x64"] },
      { installationId: 42, repositoryId: 2, repository: "acme/two", runId: 2, jobId: 2, labels: ["whitesmith-windows-x64"] },
      { installationId: 43, repositoryId: 3, repository: "acme/three", runId: 3, jobId: 3, labels: ["whitesmith-windows-x64"] },
    ],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["whitesmith-windows-x64"], triggerLabel: "whitesmith-windows-x64" } }],
    reserve: async () => ({ id: `lease-${++lease}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    jit: async ({ installationId }) => { jitInstallations.push(installationId); return { encodedJitConfig: "config", runnerName: "runner", labels: ["whitesmith-windows-x64"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async () => {},
  });
  expect(jitInstallations).toEqual([42, 43]);
  expect(result).toEqual({ reserved: 2, skipped: 1, failed: 0 });
});

test("continues other installations after a rate-limited JIT attempt", async () => {
  const jitInstallations: number[] = [];
  const reservedJobs: number[] = [];
  const result = await reconcileQueuedJobs({
    queued: [
      { installationId: 42, repositoryId: 1, repository: "acme/one", runId: 1, jobId: 1, labels: ["whitesmith-windows-x64"] },
      { installationId: 42, repositoryId: 2, repository: "acme/two", runId: 2, jobId: 2, labels: ["whitesmith-windows-x64"] },
      { installationId: 43, repositoryId: 3, repository: "acme/three", runId: 3, jobId: 3, labels: ["whitesmith-windows-x64"] },
    ],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["whitesmith-windows-x64"], triggerLabel: "whitesmith-windows-x64" } }],
    reserve: async ({ githubJobId }) => { reservedJobs.push(githubJobId); return { id: `lease-${githubJobId}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    jit: async ({ installationId }) => {
      jitInstallations.push(installationId);
      if (installationId === 42) throw Object.assign(new Error("github_rate_limited"), { code: "github_rate_limited", installationId: 42, resetAt: Date.now() + 60_000 });
      return { encodedJitConfig: "config", runnerName: "runner", labels: ["whitesmith-windows-x64"], expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    dispatch: async () => {},
    release: async () => {},
  });
  expect(jitInstallations).toEqual([42, 43]);
  expect(reservedJobs).toEqual([1, 3]);
  expect(result).toEqual({ reserved: 1, skipped: 1, failed: 1 });
});
