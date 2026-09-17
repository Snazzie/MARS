import { expect, test } from "bun:test";
import { reconcileQueuedJobs } from "./reconcile.ts";

test("reserves a runner slot before requesting JIT config", async () => {
  const order: string[] = [];
  let routingKey = "";
  let runnerName = "";
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-macos-arm64-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }],
    reserve: async (input) => { order.push("reserve"); routingKey = input.routingKey; return { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested }; },
    jit: async (input) => { order.push("jit"); runnerName = input.runnerName; return { encodedJitConfig: "config", runnerName: input.runnerName, labels: ["mars-macos-arm64-2vcpu-4g"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async () => { order.push("dispatch"); },
  });
  expect(result.reserved).toBe(1);
  expect(order).toEqual(["reserve", "jit", "dispatch"]);
  expect(routingKey).toBe("acme/project:4:mars-macos-arm64-2vcpu-4g");
  expect(runnerName).toMatch(/^mars-macos-arm64-2vcpu-4g-[0-9a-f-]{36}$/);
});

test("dispatches an architecture-neutral job through an architecture-specific pool", async () => {
  let jitLabels: string[] = [];
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-any-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }],
    reserve: async (input) => ({ id: "lease", nonce: "n".repeat(32), workerId: input.workerId, poolId: input.poolId, expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested }),
    jit: async (input) => {
      jitLabels = input.labels;
      return { encodedJitConfig: "config", runnerName: input.runnerName, labels: input.labels, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    dispatch: async () => {},
  });
  expect(result).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(jitLabels).toEqual(["mars-any-2vcpu-4g"]);
});
test("routes multi-platform alternatives to an online worker", async () => {
  let selectedWorker = "";
  const worker = (id: string, platform: string, connectionState: "online" | "offline") => ({
    requestedLabels: [],
    worker: { id, admissionState: "adopted" as const, connectionState, configurationState: "ready" as const, runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } },
    pool: { id: `pool-${id}`, platform, enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: [`mars-${platform}`], triggerLabel: `mars-${platform}` },
  });
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 5, labels: ["mars-windows-x64-2vcpu-4g", "mars-any-2vcpu-4g"] }],
    candidates: [worker("offline", "windows-x64", "offline"), worker("online", "macos-arm64", "online")],
    workerConnected: (workerId) => workerId === "online",
    reserve: async (input) => {
      selectedWorker = input.workerId;
      return { id: "lease", nonce: "n".repeat(32), workerId: input.workerId, poolId: input.poolId, expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested };
    },
    jit: async (input) => ({ encodedJitConfig: "config", runnerName: input.runnerName, labels: input.labels, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    dispatch: async () => {},
  });
  expect(result).toEqual({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(selectedWorker).toBe("online");
});

test("does not reserve beyond active pool capacity", async () => {
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 9, labels: ["mars-macos-arm64-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 1, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }],
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
      { installationId: 42, repositoryId: 1, repository: "acme/one", runId: 1, jobId: 1, labels: ["mars-windows-x64-2vcpu-4g"] },
      { installationId: 42, repositoryId: 2, repository: "acme/two", runId: 2, jobId: 2, labels: ["mars-windows-x64-2vcpu-4g"] },
      { installationId: 43, repositoryId: 3, repository: "acme/three", runId: 3, jobId: 3, labels: ["mars-windows-x64-2vcpu-4g"] },
    ],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" } }],
    reserve: async (input) => ({ id: `lease-${++lease}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested }),
    jit: async ({ installationId }) => { jitInstallations.push(installationId); return { encodedJitConfig: "config", runnerName: "runner", labels: ["mars-windows-x64-2vcpu-4g"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async () => {},
  });
  expect(jitInstallations).toEqual([42, 42, 43]);
  expect(result).toEqual({ reserved: 3, deferred: 0, skipped: 0, failed: 0 });
});
test("dispatches three jobs concurrently when bounded capacity allows it", async () => {
  const queued = [1, 2, 3].map((jobId) => ({ installationId: 1, repositoryId: jobId, repository: `acme/project-${jobId}`, runId: jobId, jobId, labels: ["mars-windows-x64-2vcpu-4g"] }));
  const candidate = { requestedLabels: [], worker: { id: "worker", admissionState: "adopted" as const, connectionState: "online" as const, configurationState: "ready" as const, runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" } };
  let activePreflights = 0;
  let maxActivePreflights = 0;
  let releasePreflight!: () => void;
  const preflightReleased = new Promise<void>((resolve) => { releasePreflight = resolve; });
  let lease = 0;
  const resultPromise = reconcileQueuedJobs({
    queued,
    candidates: [candidate],
    maxConcurrent: 3,
    reserve: async (input) => ({ id: `lease-${++lease}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested }),
    preflight: async () => {
      activePreflights += 1;
      maxActivePreflights = Math.max(maxActivePreflights, activePreflights);
      if (activePreflights === 3) releasePreflight();
      await preflightReleased;
      activePreflights -= 1;
      return true;
    },
    jit: async () => ({ encodedJitConfig: "config", runnerName: "runner", labels: ["mars-windows-x64-2vcpu-4g"], expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    dispatch: async () => {},
  });
  const result = await resultPromise;
  expect(maxActivePreflights).toBe(3);
  expect(result).toEqual({ reserved: 3, deferred: 0, skipped: 0, failed: 0 });
});

test("does not block a later job when an earlier job is already claimed", async () => {
  const reservedJobs: number[] = [];
  const result = await reconcileQueuedJobs({
    queued: [
      { installationId: 42, repositoryId: 1, repository: "acme/one", runId: 1, jobId: 1, labels: ["mars-windows-x64-2vcpu-4g"] },
      { installationId: 42, repositoryId: 2, repository: "acme/two", runId: 2, jobId: 2, labels: ["mars-windows-x64-2vcpu-4g"] },
    ],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" } }],
    reserve: async ({ githubJobId, requested }) => { if (githubJobId === 1) throw new Error("job_already_claimed"); reservedJobs.push(githubJobId); return { id: `lease-${githubJobId}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested }; },
    jit: async () => ({ encodedJitConfig: "config", runnerName: "runner", labels: ["mars-windows-x64-2vcpu-4g"], expiresAt: new Date(Date.now() + 60_000).toISOString() }),
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
      { installationId: 42, repositoryId: 1, repository: "acme/one", runId: 1, jobId: 1, labels: ["mars-windows-x64-2vcpu-4g"] },
      { installationId: 42, repositoryId: 2, repository: "acme/two", runId: 2, jobId: 2, labels: ["mars-windows-x64-2vcpu-4g"] },
      { installationId: 43, repositoryId: 3, repository: "acme/three", runId: 3, jobId: 3, labels: ["mars-windows-x64-2vcpu-4g"] },
    ],
    maxConcurrent: 1,
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 3 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 3 }, concurrency: 3, active: 0, labels: ["mars-windows-x64"], triggerLabel: "mars-windows-x64" } }],
    reserve: async ({ githubJobId, requested }) => { reservedJobs.push(githubJobId); return { id: `lease-${githubJobId}`, nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested }; },
    jit: async ({ installationId }) => {
      jitInstallations.push(installationId);
      if (installationId === 42) throw Object.assign(new Error("github_rate_limited"), { code: "github_rate_limited", installationId: 42, resetAt: Date.now() + 60_000 });
      return { encodedJitConfig: "config", runnerName: "runner", labels: ["mars-windows-x64-2vcpu-4g"], expiresAt: new Date(Date.now() + 60_000).toISOString() };
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
  const queued = [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-macos-arm64-2vcpu-4g"] }];
  const candidates = [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted" as const, connectionState: "online" as const, configurationState: "ready" as const, runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }];
  const deps = {
    queued,
    candidates,
    installationBlocked: () => blocked,
    reserve: async (input: { requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number } }) => { calls.push("reserve"); return { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested }; },
    jit: async () => { calls.push("jit"); return { encodedJitConfig: "config", runnerName: "runner", labels: ["mars-macos-arm64-2vcpu-4g"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
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
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-macos-arm64-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }],
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
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-macos-arm64-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }],
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
  const queued = [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-macos-arm64-2vcpu-4g"] }];
  const candidates = [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted" as const, connectionState: "online" as const, configurationState: "ready" as const, runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }];
  const deps = {
    queued,
    candidates,
    reserve: async (input: { requested: { vcpu: number; memoryBytes: number; storageBytes: number; concurrency: number } }) => {
      calls.push("reserve");
      if (++reserveAttempts === 1) throw new Error("worker_capacity_exhausted");
      return { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: input.requested };
    },
    jit: async () => { calls.push("jit"); return { encodedJitConfig: "config", runnerName: "runner", labels: ["mars-macos-arm64-2vcpu-4g"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
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
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-macos-arm64-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }],
    reserve: async () => { throw new Error("unexpected_reservation_error"); },
    jit: async () => { throw new Error("must not generate"); },
    dispatch: async () => {},
  });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 1 });
});


test("runs preflight after reserve and releases a reservation when preflight rejects", async () => {
  const order: string[] = [];
  const reservation = { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 } };
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-macos-arm64-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }],
    reserve: async () => { order.push("reserve"); return reservation; },
    preflight: async () => { order.push("preflight"); return false; },
    jit: async () => { order.push("jit"); throw new Error("must not generate"); },
    dispatch: async () => { order.push("dispatch"); },
    release: async () => { order.push("release"); },
  });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 1, failed: 0 });
  expect(order).toEqual(["reserve", "preflight", "release"]);
});

test("releases a reservation when preflight throws", async () => {
  let released = false;
  const reservation = { id: "lease", nonce: "n".repeat(32), workerId: "worker", poolId: "pool", expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 } };
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 4, labels: ["mars-macos-arm64-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: { id: "worker", admissionState: "adopted", connectionState: "online", configurationState: "ready", runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } }, pool: { id: "pool", platform: "macos-arm64", enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64" } }],
    reserve: async () => reservation,
    preflight: async () => { throw new Error("github_payload_invalid"); },
    jit: async () => { throw new Error("must not generate"); },
    dispatch: async () => {},
    release: async () => { released = true; },
  });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 1 });
  expect(released).toBe(true);
});
test("reroutes after the rotated-first compatible worker rejects capacity", async () => {
  const calls: string[] = [];
  const reservation = (workerId: string) => ({ id: `lease-${workerId}`, nonce: "n".repeat(32), workerId, poolId: `pool-${workerId}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), requested: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 } });
  const worker = (id: string) => ({ id, admissionState: "adopted" as const, connectionState: "online" as const, configurationState: "ready" as const, runtimeReady: true, configurationRevision: "current", appliedConfigurationRevision: "current", limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 100, maxConcurrentPods: 1 } });
  const pool = (id: string, workerId: string) => ({ id, platform: "macos-arm64" as const, enabled: true, resources: { vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 }, concurrency: 1, active: 0, labels: ["mars-macos-arm64"], triggerLabel: "mars-macos-arm64", workerId });
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 2, repository: "acme/project", runId: 3, jobId: 5, labels: ["mars-macos-arm64-2vcpu-4g"] }],
    candidates: [{ requestedLabels: [], worker: worker("worker-1"), pool: pool("pool-1", "worker-1") }, { requestedLabels: [], worker: worker("worker-2"), pool: pool("pool-2", "worker-2") }],
    reserve: async ({ workerId }) => {
      calls.push(`reserve-${workerId}`);
      if (workerId === "worker-2") throw new Error("worker_capacity_exhausted");
      return reservation(workerId);
    },
    jit: async ({ runnerName }) => { calls.push(`jit-${runnerName}`); return { encodedJitConfig: "config", runnerName, labels: ["mars-macos-arm64-2vcpu-4g"], expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    dispatch: async (claimed) => { calls.push(`dispatch-${claimed.workerId}`); },
  });
  expect(result).toMatchObject({ reserved: 1, deferred: 0, skipped: 0, failed: 0 });
  expect(calls.filter((call) => call.startsWith("reserve-"))).toEqual(["reserve-worker-2", "reserve-worker-1"]);
  expect(calls.filter((call) => call.startsWith("dispatch-"))).toEqual(["dispatch-worker-1"]);
});
