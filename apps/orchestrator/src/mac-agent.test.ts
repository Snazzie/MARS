import { describe, expect, test } from "bun:test";
import { WorkerBootstrapRequest } from "@whitesmith/contracts";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { availableMacMemoryBytes, buildMacWorkerAuthentication, buildMacWorkerJoinPayload, parseMacWorkerIdentity } from "./mac-agent.ts";

describe("macOS memory availability", () => {
  test("converts the OS-reported free percentage to available bytes", () => {
    expect(availableMacMemoryBytes("System-wide memory free percentage: 50%", 32 * 1024 ** 3)).toBe(16 * 1024 ** 3);
  });
});

describe("worker join payload", () => {
  test("allowlists identity fields and strips caller-supplied limits", () => {
    const payload = buildMacWorkerJoinPayload({ code: "A".repeat(43), publicKey: "ed25519", vmUuid: "vm-1", limits: { maxVcpuPerPod: 2 } } as never);
    expect("limits" in payload).toBe(false);
  });
  test("emits limit-free identity payload", () => {
    const vmUuid = "00000000-0000-4000-8000-000000000001";
    const payload = buildMacWorkerJoinPayload({
      code: "A".repeat(43),
      publicKey: "ed25519",
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
      vmUuid,
      machineUuid,
      doctor: { probe: true, egress: true },
      capacity,
    });

    expect(WorkerBootstrapRequest.parse(payload)).toEqual({
      code: "A".repeat(43),
      platform: "macos-arm64",
      publicKey: "ed25519",
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
    expect(parseMacWorkerIdentity({ workerId: "worker-1", publicKey: "public", privateKey: "private" })).toEqual({ workerId: "worker-1", publicKey: "public", privateKey: "private" });
  });
  test("rejects incomplete persisted identity", () => {
    expect(() => parseMacWorkerIdentity({ workerId: "worker-1" })).toThrow("worker identity is invalid");
  });
});
