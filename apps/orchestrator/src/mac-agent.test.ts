import { describe, expect, test } from "bun:test";
import { WorkerBootstrapRequest } from "@whitesmith/contracts";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { availableMacMemoryBytes, buildMacWorkerAuthentication, buildMacWorkerJoinPayload, parseMacWorkerIdentity, runMacLeaseLifecycle, startMacLeaseLifecycle } from "./mac-agent.ts";

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
      doctor: { probe: true, egress: true },
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
  test("accepts the persisted worker key and id shape", () => {
    expect(parseMacWorkerIdentity({ workerId: "worker-1", publicKey: "public", privateKey: "private", encryptionPublicKey: "encryption-public", encryptionPrivateKey: "encryption-private" })).toEqual({ workerId: "worker-1", publicKey: "public", privateKey: "private", encryptionPublicKey: "encryption-public", encryptionPrivateKey: "encryption-private" });
  });
  test("rejects incomplete persisted identity", () => {
    expect(() => parseMacWorkerIdentity({ workerId: "worker-1" })).toThrow("worker identity is invalid");
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
  const bootstrap = { leaseId: "22222222-2222-4222-8222-222222222222", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };
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
  const bootstrap = { leaseId: "22222222-2222-4222-8222-222222222222", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await runMacLeaseLifecycle({ version: 1, id: "33333333-3333-4333-8333-333333333333", type: "tart.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: bootstrap.leaseId, occurredAt: new Date().toISOString(), payload: {} }, driver as never, bootstrap, event => sent.push(event as never));
  expect(sent.map(event => event.type)).toEqual(["sandbox_attested", "runner.finished", "lease.failed"]);
  expect(sent[1]!.payload.exitCode).toBe(1);
  expect(sent[2]!.payload.reason).toBe("cleanup_failed");
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
  const bootstrap = { leaseId: "22222222-2222-4222-8222-222222222222", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 2, storageBytes: 3, concurrency: 1 }, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const command = { version: 1 as const, id: "33333333-3333-4333-8333-333333333333", type: "tart.create_lease", workerId: "11111111-1111-4111-8111-111111111111", leaseId: bootstrap.leaseId, occurredAt: new Date().toISOString(), payload: {} };
  const first = startMacLeaseLifecycle(command, driver as never, bootstrap, () => {}, active);
  const duplicate = startMacLeaseLifecycle({ ...command, id: "44444444-4444-4444-8444-444444444444" }, driver as never, bootstrap, () => {}, active);
  expect(duplicate).toBe(first);
  expect(creates).toBe(1);
  finishRunner(0);
  await first;
  expect(active.size).toBe(0);
});
