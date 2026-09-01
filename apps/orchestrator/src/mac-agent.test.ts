import { describe, expect, test } from "bun:test";
import { WorkerBootstrapRequest, type WorkerCommand } from "@mars/contracts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { applyWorkerConfigure, availableMacMemoryBytes, buildMacWorkerAuthentication, buildMacWorkerJoinPayload, parseMacWorkerIdentity, runMacLeaseLifecycle, runWorkerJoin, startMacLeaseLifecycle } from "./mac-agent.ts";

test("awaits the live cache TTL before acknowledging macOS worker configuration", async () => {
  const workerId = "00000000-0000-4000-8000-000000000001";
  const command: WorkerCommand = {
    version: 1,
    id: "00000000-0000-4000-8000-000000000002",
    type: "worker.configure",
    workerId,
    leaseId: null,
    occurredAt: "2026-08-23T00:00:00.000Z",
    payload: {
      workerId,
      appliance: { vcpu: 8, memoryBytes: 16_000, storageBytes: 64_000 },
      runtime: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_000, maxStorageBytesPerPod: 16_000, maxConcurrentPods: 4 },
      guestPlatforms: ["macos-arm64"],
      cache: { ttlSeconds: 5400, runnerCacheEnabled: false },
      revision: "a".repeat(64),
      fingerprint: "b".repeat(64),
    },
  };
  const limits = { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 };
  const cache = { ttlSeconds: 60, runnerCacheEnabled: true };
  let release!: () => void;
  const applied = new Promise<void>((resolve) => { release = resolve; });
  const enabledStates: boolean[] = [];
  const result = applyWorkerConfigure(command, limits, cache, { applyTtl: () => applied, setRunnerCacheEnabled: (enabled) => enabledStates.push(enabled) });
  expect(cache).toEqual({ ttlSeconds: 60, runnerCacheEnabled: true });
  release();
  const configured = await result;
  expect(enabledStates).toEqual([false]);
  expect(cache).toEqual({ ttlSeconds: 5400, runnerCacheEnabled: false });
  expect(configured.payload).toEqual({
    commandId: command.id,
    workerId,
    revision: "a".repeat(64),
    observed: {
      appliance: command.payload.appliance,
      runtime: command.payload.runtime,
      guestPlatforms: ["macos-arm64"],
      cache: { ttlSeconds: 5400, runnerCacheEnabled: false },
    },
  });
});

describe("macOS memory availability", () => {
  test("converts the OS-reported free percentage to available bytes", () => {
    expect(availableMacMemoryBytes("System-wide memory free percentage: 50%", 32 * 1024 ** 3)).toBe(16 * 1024 ** 3);
  });
});

describe("worker join payload", () => {
  test("allowlists identity fields and strips caller-supplied limits", () => {
    const payload = buildMacWorkerJoinPayload({ code: "A".repeat(43), publicKey: "ed25519", encryptionPublicKey: "x25519", vmUuid: "vm-1", limits: { maxVcpuPerPod: 2 } } as never);
    expect("limits" in payload).toBe(false);
  });
  test("emits limit-free identity payload", () => {
    const vmUuid = "00000000-0000-4000-8000-000000000001";
    const payload = buildMacWorkerJoinPayload({
      code: "A".repeat(43),
      publicKey: "ed25519",
      encryptionPublicKey: "x25519",
      vmUuid,
      machineUuid: "00000000-0000-4000-8000-000000000002",
      doctor: {},
      capacity: { actualVcpu: 0, actualMemoryBytes: 0, actualStorageBytes: 0, freeVcpu: 0, freeMemoryBytes: 0, freeStorageBytes: 0 },
    });
    expect(payload.platform).toBe("macos-arm64");
    expect(payload.vmUuid).toBe(vmUuid);
  });
  test("emits the complete strict worker bootstrap contract", () => {
    const vmUuid = "00000000-0000-4000-8000-000000000001";
    const machineUuid = "00000000-0000-4000-8000-000000000002";
    const capacity = {
      actualVcpu: 10,
      actualMemoryBytes: 32 * 1024 ** 3,
      actualStorageBytes: 500 * 1024 ** 3,
      freeVcpu: 8,
      freeMemoryBytes: 24 * 1024 ** 3,
      freeStorageBytes: 300 * 1024 ** 3,
    };
    const payload = buildMacWorkerJoinPayload({
      code: "A".repeat(43),
      publicKey: "ed25519",
      encryptionPublicKey: "x25519",
      vmUuid,
      machineUuid,
      doctor: { probe: true, egress: true },
      capacity,
    });

    expect(WorkerBootstrapRequest.parse(payload)).toEqual({
      code: "A".repeat(43),
      platform: "macos-arm64",
      publicKey: "ed25519",
      encryptionPublicKey: "x25519",
      vmUuid,
      machineUuid,
      doctor: { probe: true, egress: true, containers: [] },
      capacity,
    });
  });
});
test("signs worker websocket challenges with the enrolled key", () => {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const challenge = Buffer.from("challenge").toString("base64url");
  const frame = buildMacWorkerAuthentication(challenge, "worker-1", privateKey);
  expect(frame.workerId).toBe("worker-1");
  expect(verifySignature(null, Buffer.from(challenge, "base64url"), publicKey, Buffer.from(frame.signature, "base64url"))).toBe(true);
});
describe("worker identity persistence", () => {
  test("accepts the persisted worker key, id, and stable host identity shape", () => {
    expect(parseMacWorkerIdentity({ workerId: "", publicKey: "public", privateKey: "private", encryptionPublicKey: "encryption-public", encryptionPrivateKey: "encryption-private", vmUuid: "vm", machineUuid: "machine" })).toEqual({ workerId: "", publicKey: "public", privateKey: "private", encryptionPublicKey: "encryption-public", encryptionPrivateKey: "encryption-private", vmUuid: "vm", machineUuid: "machine", preserveLeases: false });
  });
  test("rejects incomplete persisted identity", () => {
    expect(() => parseMacWorkerIdentity({ workerId: "worker-1" })).toThrow("worker identity is invalid");
  });
  test("reuses a persisted partial identity after a response-loss retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-mac-join-"));
    const identityPath = join(root, "worker-identity.json");
    const codePath = join(root, "join-code");
    const identity = {
      workerId: "",
      publicKey: "persisted-signing-public",
      privateKey: "persisted-signing-private",
      encryptionPublicKey: "persisted-encryption-public",
      encryptionPrivateKey: "persisted-encryption-private",
      vmUuid: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      machineUuid: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
    };
    await writeFile(identityPath, `${JSON.stringify(identity)}\n`);
    await writeFile(codePath, `${"A".repeat(43)}\n`);
    const previousIdentityPath = Bun.env.MARS_WORKER_IDENTITY_FILE;
    const previousJoinCodePath = Bun.env.MARS_JOIN_CODE_FILE;
    const previousTartDigest = Bun.env.MARS_TART_IMAGE_DIGEST;
    const previousSpawnSync = Bun.spawnSync;
    const previousSleep = Bun.sleep;
    const previousFetch = globalThis.fetch;
    const requests: string[] = [];
    let joinAttempts = 0;
    try {
      Bun.env.MARS_WORKER_IDENTITY_FILE = identityPath;
      Bun.env.MARS_JOIN_CODE_FILE = codePath;
      Bun.env.MARS_TART_IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
      Object.defineProperty(Bun, "spawnSync", { value: () => ({ exitCode: 0, stdout: Buffer.from("System-wide memory free percentage: 50%"), stderr: Buffer.from("") }) });
      Object.defineProperty(Bun, "sleep", { value: async () => {} });
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (!url.endsWith("/api/workers/join")) return Response.json({});
        requests.push(String(init?.body));
        joinAttempts += 1;
        if (joinAttempts === 1) throw new Error("response lost after server consumed enrollment");
        return Response.json({ workerId: "worker-replayed" });
      }) as typeof globalThis.fetch;

      await runWorkerJoin("macos-arm64", "http://localhost:3000");
      const saved = JSON.parse(await readFile(identityPath, "utf8"));
      expect(saved).toMatchObject({ ...identity, workerId: "worker-replayed", vmUuid: identity.vmUuid.toLowerCase(), machineUuid: identity.machineUuid.toLowerCase(), preserveLeases: false });
      expect(joinAttempts).toBe(2);
      expect(requests).toHaveLength(2);
      const firstPayload = WorkerBootstrapRequest.parse(JSON.parse(requests[0]!));
      const secondPayload = WorkerBootstrapRequest.parse(JSON.parse(requests[1]!));
      expect(secondPayload).toEqual(firstPayload);
      expect(firstPayload).toMatchObject({ publicKey: identity.publicKey, encryptionPublicKey: identity.encryptionPublicKey, vmUuid: identity.vmUuid.toLowerCase(), machineUuid: identity.machineUuid.toLowerCase() });
    } finally {
      if (previousIdentityPath === undefined) delete Bun.env.MARS_WORKER_IDENTITY_FILE;
      else Bun.env.MARS_WORKER_IDENTITY_FILE = previousIdentityPath;
      if (previousJoinCodePath === undefined) delete Bun.env.MARS_JOIN_CODE_FILE;
      else Bun.env.MARS_JOIN_CODE_FILE = previousJoinCodePath;
      if (previousTartDigest === undefined) delete Bun.env.MARS_TART_IMAGE_DIGEST;
      else Bun.env.MARS_TART_IMAGE_DIGEST = previousTartDigest;
      Object.defineProperty(Bun, "spawnSync", { value: previousSpawnSync });
      Object.defineProperty(Bun, "sleep", { value: previousSleep });
      globalThis.fetch = previousFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("emits attestation, runner completion, and reap around one lease", async () => {
  const calls: string[] = [];
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const driver = {
    async createLease() {
      calls.push("create");
      return { runtimeInstanceId: "vm-1", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, state: "sandbox_attested" as const, completion: Promise.resolve(0) };
    },
    async stopLease() { calls.push("stop"); },
    async removeLease() { calls.push("remove"); },
  };
  const bootstrap = { leaseId: "22222222-2222-4222-8222-222222222222", jobId: "44444444-4444-4444-8444-444444444444", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await runMacLeaseLifecycle({ version: 1, id: "33333333-3333-4333-8333-333333333333", type: "tart.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: bootstrap.leaseId, occurredAt: new Date().toISOString(), payload: {} }, driver as never, bootstrap, event => sent.push(event as never));
  expect(calls).toEqual(["create", "stop", "remove"]);
  expect(sent.map(event => event.type)).toEqual(["sandbox_attested", "runner.finished", "lease.reaped"]);
  expect(sent[1]!.payload).toMatchObject({ leaseId: bootstrap.leaseId, nonce: bootstrap.nonce, exitCode: 0 });
});

test("reports cleanup failure after runner completion without claiming reap", async () => {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const driver = {
    async createLease() { return { runtimeInstanceId: "vm-1", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, state: "sandbox_attested" as const, completion: Promise.resolve(1) }; },
    async stopLease() { throw new Error("stop failed"); },
    async removeLease() {},
  };
  const bootstrap = { leaseId: "22222222-2222-4222-8222-222222222222", jobId: "44444444-4444-4444-8444-444444444444", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await runMacLeaseLifecycle({ version: 1, id: "33333333-3333-4333-8333-333333333333", type: "tart.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: bootstrap.leaseId, occurredAt: new Date().toISOString(), payload: {} }, driver as never, bootstrap, event => sent.push(event as never));
  expect(sent.map(event => event.type)).toEqual(["sandbox_attested", "runner.finished", "lease.failed"]);
  expect(sent[1]!.payload.exitCode).toBe(1);
  expect(sent[2]!.payload.reason).toBe("cleanup_failed");
});

test("passes authenticated worker cache transport into macOS runtime and unregisters it", async () => {
  const workerCache = { proxyUrl: "http://lease-user:lease-secret@127.0.0.1:3128", cacheBaseUrl: "https://127.0.0.1:8443", caCertificatePem: "worker-ca", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let received: unknown;
  let unregistered: string | undefined;
  const driver = {
    async createLease(lease: { workerCache?: unknown }) {
      received = lease.workerCache;
      return { runtimeInstanceId: "vm-1", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, state: "sandbox_attested" as const, completion: Promise.resolve(0) };
    },
    async stopLease() {},
    async removeLease() {},
  };
  const bootstrap = { leaseId: "22222222-2222-4222-8222-222222222222", jobId: "44444444-4444-4444-8444-444444444444", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: workerCache.expiresAt };
  await runMacLeaseLifecycle({ version: 1, id: "33333333-3333-4333-8333-333333333333", type: "tart.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: bootstrap.leaseId, occurredAt: new Date().toISOString(), payload: {} }, driver as never, bootstrap, () => {}, false, {
    transport: () => workerCache,
    unregisterLease: (leaseId) => { unregistered = leaseId; },
  });
  expect(received).toEqual(workerCache);
  expect(new URL(workerCache.proxyUrl).username).not.toBe("");
  expect(new URL(workerCache.proxyUrl).password).not.toBe("");
  expect(unregistered).toBe(bootstrap.leaseId);
});

test("fails macOS lease provisioning closed when worker cache transport setup fails", async () => {
  let created = false;
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const driver = {
    async createLease() { created = true; throw new Error("must not run"); },
    async stopLease() {},
    async removeLease() {},
  };
  const bootstrap = { leaseId: "22222222-2222-4222-8222-222222222222", jobId: "44444444-4444-4444-8444-444444444444", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await runMacLeaseLifecycle({ version: 1, id: "33333333-3333-4333-8333-333333333333", type: "tart.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: bootstrap.leaseId, occurredAt: new Date().toISOString(), payload: {} }, driver as never, bootstrap, event => sent.push(event as never), false, { transport: () => { throw new Error("cache unavailable"); }, unregisterLease() {} });
  expect(created).toBe(false);
  expect(sent).toEqual([expect.objectContaining({ type: "lease.failed", payload: expect.objectContaining({ reason: "provisioning_failed" }) })]);
});

test("deduplicates repeated delivery of an active lease", async () => {
  let creates = 0;
  let finishRunner!: (exitCode: number) => void;
  const completion = new Promise<number>(resolve => { finishRunner = resolve; });
  const active = new Map<string, Promise<void>>();
  const driver = {
    async createLease() { creates += 1; return { runtimeInstanceId: "vm-1", observed: { vcpu: 1, memoryBytes: 2, storageBytes: 3 }, state: "sandbox_attested" as const, completion }; },
    async stopLease() {},
    async removeLease() {},
  };
  const bootstrap = { leaseId: "22222222-2222-4222-8222-222222222222", jobId: "44444444-4444-4444-8444-444444444444", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const command = { version: 1 as const, id: "33333333-3333-4333-8333-333333333333", type: "tart.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: bootstrap.leaseId, occurredAt: new Date().toISOString(), payload: {} };
  const first = startMacLeaseLifecycle(command, driver as never, bootstrap, () => {}, active);
  const duplicate = startMacLeaseLifecycle({ ...command, id: "44444444-4444-4444-8444-444444444444" }, driver as never, bootstrap, () => {}, active);
  expect(duplicate).toBe(first);
  expect(creates).toBe(1);
  finishRunner(0);
  await first;
  expect(active.size).toBe(0);
});
