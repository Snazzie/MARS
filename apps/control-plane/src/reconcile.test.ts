import { expect, test } from "bun:test";
import { reconcileQueuedJobs } from "./reconcile.ts";

test("reserves a runner slot before requesting JIT config", async () => {
  const order: string[] = [];
  let routingKey = "";
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["self-hosted", "macos", "arm64", "mars-default"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["self-hosted", "macos", "arm64", "mars-default"], triggerLabel: "mars-default" } }],
    reserve: async (input) => { order.push("reserve"); routingKey = input.routingKey; return { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested }; },
    jit: async () => { order.push("jit"); return { encodedJitConfig: "config", runnerName: "runner", labels: ["self-hosted"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async () => { order.push("dispatch"); },
  });
  expect(result.reserved).toBe(1);
  expect(order).toEqual(["reserve", "jit", "dispatch"]);
  expect(routingKey).toBe("acme/project:4:arm64,macos,mars-default,self-hosted");
});

test("does not reserve beyond active pool capacity", async () => {
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 9, labels: ["self-hosted", "macos", "arm64", "mars-default"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 1, labels: ["self-hosted", "macos", "arm64", "mars-default"], triggerLabel: "mars-default" } }],
    reserve: async () => { throw new Error("must not reserve"); },
    jit: async () => { throw new Error("must not generate"); },
    dispatch: async () => {},
  });
  expect(result.skipped).toBe(1);
});

test("uses every available pool slot for one installation", async () => {
  const jitInstallations: number[] = [];
  let lease = 0;
  const result = await reconcileQueuedJobs({
    queued: [
      { installationId: 42, repositoryId: 1, repository: "acme/one", runId: 1, jobId: 1, labels: ["mars-windows-x64"] },
      { installationId: 42, repositoryId: 2, repository: "acme/two", runId: 2, jobId: 2, labels: ["mars-windows-x64"] },
      { installationId: 43, repositoryId: 3, repository: "acme/three", runId: 3, jobId: 3, labels: ["mars-windows-x64"] },
    ],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" } }],
    reserve: async (input) => ({ id: `lease-${++lease}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested }),
    jit: async ({ installationId }) => { jitInstallations.push(installationId); return { encodedJitConfig: "config", runnerName: "runner", labels: ["mars-windows-x64"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async () => {},
  });
  expect(jitInstallations).toEqual([42, 42, 43]);
  expect(result).toEqual({ reserved: 3, deferred: 0, skipped: 0, failed: 0 });
});

test("does not block a later job when an earlier job is already claimed", async () => {
  const reservedJobs: number[] = [];
  const result = await reconcileQueuedJobs({
    queued: [
      { installationId: 42, repositoryId: 1, repository: "acme/one", runId: 1, jobId: 1, labels: ["mars-windows-x64"] },
      { installationId: 42, repositoryId: 2, repository: "acme/two", runId: 2, jobId: 2, labels: ["mars-windows-x64"] },
    ],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" } }],
    reserve: async ({ githubJobId, requested }) => { if (githubJobId === 1) throw new Error("job_already_claimed"); reservedJobs.push(githubJobId); return { id: `lease-${githubJobId}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested }; },
    jit: async () => ({ encodedJitConfig: "config", runnerName: "runner", labels: ["mars-windows-x64"], expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    dispatch: async () => {},
  });
  expect(reservedJobs).toEqual([2]);
  expect(result).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 1 });
});
test("continues other installations after a rate-limited JIT attempt", async () => {
  const jitInstallations: number[] = [];
  const reservedJobs: number[] = [];
  const result = await reconcileQueuedJobs({
    queued: [
      { installationId: 42, repositoryId: 1, repository: "acme/one", runId: 1, jobId: 1, labels: ["mars-windows-x64"] },
      { installationId: 42, repositoryId: 2, repository: "acme/two", runId: 2, jobId: 2, labels: ["mars-windows-x64"] },
      { installationId: 43, repositoryId: 3, repository: "acme/three", runId: 3, jobId: 3, labels: ["mars-windows-x64"] },
    ],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" } }],
    reserve: async ({ githubJobId, requested }) => { reservedJobs.push(githubJobId); return { id: `lease-${githubJobId}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested }; },
    jit: async ({ installationId }) => {
      jitInstallations.push(installationId);
      if (installationId === 42) throw Object.assign(new Error("github_rate_limited"), { code: "github_rate_limited", installationId: 42, resetAt: Date.now() + 60_000 });
      return { encodedJitConfig: "config", runnerName: "runner", labels: ["mars-windows-x64"], expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    dispatch: async () => {},
    release: async () => {},
  });
  expect(jitInstallations).toEqual([42, 43]);
  expect(reservedJobs).toEqual([1, 3]);
  expect(result).toEqual({ reserved: 1, deferred: 0, skipped: 1, failed: 1 });
});
 
test("resumes routing after an installation cooldown clears", async () => {
  let blocked = true;
  const calls: string[] = [];
  const queued = [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["self-hosted", "macos", "arm64", "mars-default"] }];
  const candidates = [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted" as const, connectionState: "online" as const, configurationState: "ready" as const, runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["self-hosted", "macos", "arm64", "mars-default"], triggerLabel: "mars-default" } }];
  const deps = {
    queued,
    candidates,
    installationBlocked: () => blocked,
    reserve: async (input: { requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number } }) => { calls.push("reserve"); return { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested }; },
    jit: async () => { calls.push("jit"); return { encodedJitConfig: "config", runnerName: "runner", labels: ["self-hosted"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async () => { calls.push("dispatch"); },
  };
  const blockedResult = await reconcileQueuedJobs(deps);
  expect(blockedResult).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 });
  expect(calls).toEqual([]);
  blocked = false;
  const resumedResult = await reconcileQueuedJobs(deps);
  expect(resumedResult).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(calls).toEqual(["reserve", "jit", "dispatch"]);
});

test("defers jobs when worker capacity is exhausted", async () => {
  const calls: string[] = [];
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["self-hosted", "macos", "arm64", "mars-default"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["self-hosted", "macos", "arm64", "mars-default"], triggerLabel: "mars-default" } }],
    reserve: async () => { throw new Error("worker_capacity_exhausted"); },
    jit: async () => { calls.push("jit"); throw new Error("must not generate"); },
    dispatch: async () => { calls.push("dispatch"); },
  });
  expect(result).toEqual({ reserved: 0, deferred: 1, skipped: 0, failed: 0 });
  expect(calls).toEqual([]);
});
test("defers jobs when pool capacity is exhausted", async () => {
  const calls: string[] = [];
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["self-hosted", "macos", "arm64", "mars-default"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["self-hosted", "macos", "arm64", "mars-default"], triggerLabel: "mars-default" } }],
    reserve: async () => { throw new Error("pool_capacity_exhausted"); },
    jit: async () => { calls.push("jit"); throw new Error("must not generate"); },
    dispatch: async () => { calls.push("dispatch"); },
  });
  expect(result).toEqual({ reserved: 0, deferred: 1, skipped: 0, failed: 0 });
  expect(calls).toEqual([]);
});
test("recovers deferred work when worker capacity returns", async () => {
  let reserveAttempts = 0;
  const calls: string[] = [];
  const queued = [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["self-hosted", "macos", "arm64", "mars-default"] }];
  const candidates = [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted" as const, connectionState: "online" as const, configurationState: "ready" as const, runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["self-hosted", "macos", "arm64", "mars-default"], triggerLabel: "mars-default" } }];
  const deps = {
    queued,
    candidates,
    reserve: async (input: { requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number } }) => {
      calls.push("reserve");
      if (++reserveAttempts === 1) throw new Error("worker_capacity_exhausted");
      return { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested };
    },
    jit: async () => { calls.push("jit"); return { encodedJitConfig: "config", runnerName: "runner", labels: ["self-hosted"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async () => { calls.push("dispatch"); },
  };
  const first = await reconcileQueuedJobs(deps);
  expect(first).toEqual({ reserved: 0, deferred: 1, skipped: 0, failed: 0 });
  const second = await reconcileQueuedJobs(deps);
  expect(second).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(calls).toEqual(["reserve", "reserve", "jit", "dispatch"]);
});

test("fails jobs when reservation fails unexpectedly", async () => {
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["self-hosted", "macos", "arm64", "mars-default"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 100, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["self-hosted", "macos", "arm64", "mars-default"], triggerLabel: "mars-default" } }],
    reserve: async () => { throw new Error("unexpected_reservation_error"); },
    jit: async () => { throw new Error("must not generate"); },
    dispatch: async () => {},
  });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 1 });
});
