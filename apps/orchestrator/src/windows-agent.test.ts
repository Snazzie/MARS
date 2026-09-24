import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerConfigurePayload, WorkerDoctorData, WorkerDoctorReport, type LeaseBootstrapEnvelope, type WorkerCapacityData, type WorkerCommand, type WorkerContainerStatus, type WorkerEvent } from "@mars/contracts";
import { runLeaseLifecycle } from "./lease-lifecycle.ts";
import { applyWindowsRunnerCachePurge, applyWindowsWorkerConfiguration, buildWindowsDoctorReport, dispatchWindowsWorkerFrame, executeWindowsWorkerCommand, reconcileWindowsRuntime, runWindowsLeaseCleanup, startWindowsLeaseLifecycle, verifiedWindowsVmImage, windowsDoctor } from "./windows-agent.ts";
const doctor = WorkerDoctorData.parse({ runtimeMode: "container", runtimeReady: true, probe: true, imageSignatures: true });
const capacity: WorkerCapacityData = { actualVcpu: 8, actualMemoryBytes: 16, actualStorageBytes: 32, freeVcpu: 7, freeMemoryBytes: 15, freeStorageBytes: 31 };
const containerStatuses: WorkerContainerStatus[] = [{
  containerId: "a".repeat(64),
  name: "build-a",
  leaseId: "22222222-2222-4222-8222-222222222222",
  state: "running",
  cpuUsagePercent: 12.5,
  memoryWorkingSetBytes: 1024,
  memoryLimitBytes: 2048,
  diskUsageBytes: 4096,
  sampledAt: "2026-08-31T12:00:00.000Z",
}, {
  containerId: "b".repeat(64),
  name: "build-b",
  leaseId: "33333333-3333-4333-8333-333333333333",
  state: "exited",
  cpuUsagePercent: null,
  memoryWorkingSetBytes: null,
  memoryLimitBytes: null,
  diskUsageBytes: 8192,
  sampledAt: "2026-08-31T12:00:00.000Z",
}];

test("Windows doctor ignores GitHub network failures but still requires local readiness evidence", async () => {
  const programData = await mkdtemp(join(tmpdir(), "mars-windows-doctor-"));
  const checkpoint = join(programData, "checkpoint");
  const stateRoot = join(programData, "Mars", "vm-provisioning");
  const digest = `sha256:${"a".repeat(64)}`;
  const contentDigest = `sha256:${"b".repeat(64)}`;
  const oldFetch = globalThis.fetch;
  const oldEnv = {
    runtime: Bun.env.MARS_WINDOWS_RUNTIME,
    programData: Bun.env.ProgramData,
    checkpointPath: Bun.env.MARS_WINDOWS_CHECKPOINT_PATH,
    checkpointDigest: Bun.env.MARS_WINDOWS_CHECKPOINT_DIGEST,
  };
  let fetchCalls = 0;
  try {
    await mkdir(checkpoint, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(checkpoint, "image.vmcx"), "vm");
    const probe = { passed: true, imageDigest: digest, contentDigest };
    await writeFile(join(checkpoint, "manifest.json"), JSON.stringify({ format: 2, kind: "hyperv-checkpoint-export", imageDigest: digest, contentDigest, probe, files: [{ path: "image.vmcx", length: 2, sha256: `sha256:${"c".repeat(64)}` }] }));
    await writeFile(join(stateRoot, "image-state.json"), JSON.stringify({ version: 1, imageDigest: digest, contentDigest, installedPath: checkpoint, ready: true, probe: { passed: true } }));
    Bun.env.MARS_WINDOWS_RUNTIME = "vm";
    Bun.env.ProgramData = programData;
    Bun.env.MARS_WINDOWS_CHECKPOINT_PATH = checkpoint;
    Bun.env.MARS_WINDOWS_CHECKPOINT_DIGEST = digest;
    globalThis.fetch = Object.assign(async () => { fetchCalls += 1; throw new Error("network unavailable"); }, { preconnect: oldFetch.preconnect });

    const ready = await windowsDoctor(false, async () => true);
    expect(fetchCalls).toBe(0);
    expect(ready.runtimeReady).toBe(true);
    expect(ready.imageSignatures).toBe(true);
    expect(ready).not.toHaveProperty("egress");

    Bun.env.MARS_WINDOWS_CHECKPOINT_DIGEST = `sha256:${"d".repeat(64)}`;
    const missing = await windowsDoctor(false, async () => true);
    expect(missing.runtimeReady).toBe(false);
    expect(missing.remediation).toContain("digest");
    expect(fetchCalls).toBe(0);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries({
      MARS_WINDOWS_RUNTIME: oldEnv.runtime,
      ProgramData: oldEnv.programData,
      MARS_WINDOWS_CHECKPOINT_PATH: oldEnv.checkpointPath,
      MARS_WINDOWS_CHECKPOINT_DIGEST: oldEnv.checkpointDigest,
    })) {
      if (value === undefined) delete Bun.env[name];
      else Bun.env[name] = value;
    }
    await rm(programData, { recursive: true, force: true });
  }
});
test("validates installed Windows VM identity and rejects stale service digests", async () => {
  const programData = await mkdtemp(join(tmpdir(), "mars-windows-image-state-"));
  const checkpoint = join(programData, "checkpoint");
  const stateRoot = join(programData, "Mars", "vm-provisioning");
  const digest = `sha256:${"a".repeat(64)}`;
  const contentDigest = `sha256:${"b".repeat(64)}`;
  try {
    await mkdir(checkpoint, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(checkpoint, "image.vmcx"), "vm");
    const probe = { passed: true, imageDigest: digest, contentDigest };
    await writeFile(join(checkpoint, "manifest.json"), JSON.stringify({ format: 2, kind: "hyperv-checkpoint-export", imageDigest: digest, contentDigest, probe, files: [{ path: "image.vmcx", length: 2, sha256: `sha256:${"c".repeat(64)}` }] }));
    await writeFile(join(stateRoot, "image-state.json"), JSON.stringify({ version: 1, imageDigest: digest, contentDigest, installedPath: checkpoint, ready: true, probe: { passed: true } }));
    expect(await verifiedWindowsVmImage(programData, checkpoint, digest)).toEqual({ ready: true, digest });
    expect((await verifiedWindowsVmImage(programData, checkpoint, `sha256:${"d".repeat(64)}`)).ready).toBe(false);
  } finally {
    await rm(programData, { recursive: true, force: true });
  }
});

test("builds a parsed Windows doctor report with the complete container inventory", () => {
  const report = buildWindowsDoctorReport({
    doctor,
    capacity,
    containers: containerStatuses,
    activeLeases: ["44444444-4444-4444-8444-444444444444"],
    preserveLeases: true,
    versions: { releaseVersion: "0.1.0", contractVersion: "0.1.0" },
  });
  expect(WorkerDoctorReport.parse(report)).toEqual({
    releaseVersion: "0.1.0",
    contractVersion: "0.1.0",
    doctor: { ...doctor, containers: containerStatuses, activeLeases: ["44444444-4444-4444-8444-444444444444"], preserveLeases: true },
    capacity,
  });
});

test("awaits the live cache TTL before acknowledging Windows configuration", async () => {
  const limits = { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 6 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 };
  const cache = { ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 };
  const payload = WorkerConfigurePayload.parse({
    workerId: "11111111-1111-4111-8111-111111111111",
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
    appliance: { vcpu: 32, memoryBytes: 64 * 1024 ** 3, storageBytes: 1_000 * 1024 ** 3 },
    runtime: { maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 },
    guestPlatforms: ["windows-x64"],
    cache: { ttlSeconds: 3600, runnerCacheEnabled: false, runnerCacheMaxGiB: 12 },
  });
  let release!: () => void;
  const applied = new Promise<void>((resolve) => { release = resolve; });
  const enabledStates: boolean[] = [];
  const maxCaps: number[] = [];
  const result = applyWindowsWorkerConfiguration(limits, cache, payload, { applyTtl: () => applied, setRunnerCacheEnabled: (enabled) => enabledStates.push(enabled), setRunnerCacheMaxGiB: (maxGiB) => maxCaps.push(maxGiB) });
  expect(cache).toEqual({ ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 });
  release();
  const observed = await result;
  expect(enabledStates).toEqual([false]);
  expect(maxCaps).toEqual([12]);
  expect(limits).toEqual({ maxVcpuPerPod: 10, maxMemoryBytesPerPod: 10 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 3 });
  expect(cache).toEqual({ ttlSeconds: 3600, runnerCacheEnabled: false, runnerCacheMaxGiB: 12 });
  expect(observed.cache).toEqual(payload.cache);
});

test("purges the Windows runner cache before acknowledging", async () => {
  const commandId = "44444444-4444-4444-8444-444444444444";
  const command: WorkerCommand = { version: 1, id: commandId, type: "worker.runner_cache_purge", workerId, leaseId: null, occurredAt: new Date().toISOString(), payload: { workerId } };
  let purges = 0;
  const result = await applyWindowsRunnerCachePurge(command, { purgeRunnerCache: async () => { purges += 1; } });
  expect(purges).toBe(1);
  expect(result.type).toBe("command.accepted");
  expect(result.payload).toEqual({ commandId, leaseId: null });
});

const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const command: WorkerCommand = { version: 1, id: "33333333-3333-4333-8333-333333333333", type: "windows-container.create_lease", workerId, leaseId, occurredAt: new Date().toISOString(), payload: {} };
const bootstrap: LeaseBootstrapEnvelope = { leaseId, jobId: leaseId, nonce: "n".repeat(32), guestPlatform: "windows-x64", contractVersion: "0.1.0", imageDigest: `sha256:${"a".repeat(64)}`, resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };

test("keeps the Windows health channel alive when a valid command fails", async () => {
  const failingCreate: WorkerCommand = { ...command, payload: { bootstrapCiphertext: "invalid-bootstrap" } };
  const sent: Record<string, unknown>[] = [];
  let closed = 0;
  const failureObserved = Promise.withResolvers<void>();
  const input = {
    workerId,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => { closed += 1; },
    sendDoctor: async () => { sent.push({ version: 1, type: "doctor", workerId, payload: {} }); },
    execute: (next: WorkerCommand) => executeWindowsWorkerCommand(next, {
      mode: "container",
      limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4, maxStorageBytesPerPod: 4, maxConcurrentPods: 1 },
      cache: { ttlSeconds: 60, runnerCacheEnabled: true, runnerCacheMaxGiB: 1 },
      cacheService: {} as never,
      driver: {} as never,
      identity: { workerId, publicKey: "", privateKey: "", encryptionPublicKey: "", encryptionPrivateKey: "" },
      activeLeases: new Map(),
      send: () => { throw new Error("command acknowledgement must not be sent"); },
      sendDoctor: () => {},
    }).catch(error => {
      failureObserved.resolve();
      throw error;
    }),
  };
  dispatchWindowsWorkerFrame(failingCreate as unknown as Record<string, unknown>, input);
  dispatchWindowsWorkerFrame({ type: "ping" }, input);
  await failureObserved.promise;
  expect(closed).toBe(0);
  expect(sent).toEqual([
    { version: 1, type: "pong", workerId },
    { version: 1, type: "doctor", workerId, payload: {} },
  ]);
});

test("closes the Windows socket for malformed worker frames", () => {
  let closed = 0;
  dispatchWindowsWorkerFrame({ type: "not-a-command" }, {
    workerId,
    send: () => {},
    close: () => { closed += 1; },
    sendDoctor: async () => {},
    execute: async () => {},
  });
  expect(closed).toBe(1);
});

test("reconciles Windows runtime before startup continues", async () => {
  const calls: string[] = [];
  await reconcileWindowsRuntime({ preserveLeases: false }, { reconcileOrphans: async () => { calls.push("reconcile"); } });
  calls.push("doctor");
  expect(calls).toEqual(["reconcile", "doctor"]);
});
test("preserves Windows runtimes when lease preservation is enabled", async () => {
  let reconciled = false;
  await reconcileWindowsRuntime({ preserveLeases: true }, { reconcileOrphans: async () => { reconciled = true; } });
  expect(reconciled).toBe(false);
});
test("aborts startup continuation when orphan reconciliation fails", async () => {
  await expect(reconcileWindowsRuntime({ preserveLeases: false }, { reconcileOrphans: async () => { throw new Error("docker unavailable"); } })).rejects.toThrow("docker unavailable");
});

test("reports Windows container provisioning failures instead of leaving the lease dispatched", async () => {
  const events: WorkerEvent[] = [];
  const driver = { createLease: async () => { throw new Error("provisioning exploded"); } };
  await runLeaseLifecycle(command, driver as never, bootstrap, event => events.push(event));
  expect(events).toEqual([expect.objectContaining({ type: "lease.failed", payload: expect.objectContaining({ commandId: command.id, leaseId, nonce: bootstrap.nonce, reason: "provisioning_failed" }) })]);
});

test("coalesces duplicate Windows lease commands while provisioning", async () => {
  let creates = 0;
  const events: WorkerEvent[] = [];
  const driver = {
    createLease: async () => {
      creates += 1;
      await Bun.sleep(5);
      return { runtimeInstanceId: "container", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, state: "sandbox_attested" as const, completion: Promise.resolve(0) };
    },
    stopLease: async () => {},
    removeLease: async () => {},
  };
  const active = new Map<string, Promise<void>>();
  await Promise.all([
    startWindowsLeaseLifecycle(command, driver, bootstrap, event => events.push(event), active),
    startWindowsLeaseLifecycle(command, driver, bootstrap, event => events.push(event), active),
  ]);
  expect(creates).toBe(1);
  expect(events.filter(event => event.type === "sandbox_attested")).toHaveLength(1);
});
test("publishes inventory while a Windows lease is running and after cleanup", async () => {
  let resolveCompletion!: (exitCode: number) => void;
  const completion = new Promise<number>(resolve => { resolveCompletion = resolve; });
  const events: WorkerEvent[] = [];
  const inventoryStates: boolean[] = [];
  const active = new Map<string, Promise<void>>();
  const lifecycle = startWindowsLeaseLifecycle(command, {
    createLease: async () => ({ runtimeInstanceId: "container", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, state: "sandbox_attested" as const, completion }),
    stopLease: async () => {},
    removeLease: async () => {},
  }, bootstrap, event => events.push(event), active, undefined, undefined, () => { inventoryStates.push(active.has(leaseId)); });
  await Promise.resolve();
  expect(events.some(event => event.type === "sandbox_attested")).toBe(true);
  expect(inventoryStates).toEqual([true]);
  resolveCompletion(0);
  await lifecycle;
  expect(inventoryStates).toEqual([true, false]);
  expect(events.at(-1)?.type).toBe("lease.reaped");
});

test("handles durable stop commands and removes the lease", async () => {
  const events: WorkerEvent[] = [];
  const calls: string[] = [];
  const inventoryStates: string[][] = [];
  const stopCommand: WorkerCommand = {
    ...command,
    type: "tart.stop_lease",
    payload: { nonce: bootstrap.nonce },
  };
  await runWindowsLeaseCleanup(stopCommand, {
    stopLease: async (id) => { calls.push(`stop:${id}`); },
    removeLease: async (id) => { calls.push(`remove:${id}`); },
  }, (workerEvent) => events.push(workerEvent), false, () => { inventoryStates.push([...calls]); });

  expect(calls).toEqual([`stop:${leaseId}`, `remove:${leaseId}`]);
  expect(inventoryStates).toEqual([[`stop:${leaseId}`, `remove:${leaseId}`]]);
  expect(events).toEqual([
    expect.objectContaining({ type: "command.accepted", payload: expect.objectContaining({ commandId: command.id, leaseId }) }),
    expect.objectContaining({ type: "lease.reaped", payload: expect.objectContaining({ commandId: command.id, leaseId, nonce: bootstrap.nonce }) }),
  ]);
});
test("transport failure does not bypass Windows lease cleanup", async () => {
  const calls: string[] = [];
  const stopCommand: WorkerCommand = { ...command, type: "windows-container.stop_lease", payload: { nonce: bootstrap.nonce } };
  await runWindowsLeaseCleanup(stopCommand, {
    stopLease: async () => { calls.push("stop"); },
    removeLease: async () => { calls.push("remove"); },
  }, () => { throw new Error("closed"); });
  expect(calls).toEqual(["stop", "remove"]);
});
