import { describe, expect, test } from "bun:test";
import { CreatePoolRequest, PoolResources, RunnerTriggerLabel, WorkerLimits } from "../packages/contracts/src/index.ts";
import { fits, reason } from "../apps/control-plane/src/scheduler.ts";
import { validSignature } from "../apps/control-plane/src/webhook.ts";
import { beginWorkerHandshake, authenticateWorker } from "../apps/control-plane/src/socket.ts";
import { generateKeyPairSync, sign } from "node:crypto";
import { createHash, createHmac } from "node:crypto";

describe("resource contracts",()=>{test("rejects fractional and zero resources",()=>{expect(PoolResources.safeParse({vcpu:0,memoryBytes:1,storageBytes:1,concurrency:1}).success).toBe(false);expect(WorkerLimits.safeParse({maxVcpuPerPod:1.5,maxMemoryBytesPerPod:1,maxStorageBytesPerPod:1,maxConcurrentPods:1}).success).toBe(false)});test("admission requires adopted ready online worker and all ceilings",()=>{const candidate={worker:{admissionState:"adopted",connectionState:"online",configurationState:"ready",limits:{maxVcpuPerPod:2,maxMemoryBytesPerPod:100,maxStorageBytesPerPod:100,maxConcurrentPods:2}},pool:{enabled:true,resources:{vcpu:2,memoryBytes:100,storageBytes:100,concurrency:1},concurrency:2,active:0,labels:["self-hosted","linux","x64","custom"],triggerLabel:"custom"},requestedLabels:["self-hosted","linux","x64","custom"]};expect(fits(candidate)).toBe(true);candidate.pool.resources={vcpu:3,memoryBytes:100,storageBytes:100,concurrency:1};expect(fits(candidate)).toBe(false);expect(reason(candidate)).toBe("resource_ceiling")})});
describe("pool creation contracts", () => {
  const valid = {
    workerId: "11111111-1111-4111-8111-111111111111",
    name: "default",
    resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 2048, concurrency: 1 },
    triggerLabel: "whitesmith-default",
    imageDigest: "ubuntu@sha256:" + "a".repeat(64),
  };

  test("accepts immutable pool requests and canonical trigger labels", () => {
    expect(CreatePoolRequest.parse(valid)).toEqual(valid);
    expect(RunnerTriggerLabel.parse("custom.label-1")).toBe("custom.label-1");
  });

  test("rejects reserved or malformed trigger labels", () => {
    for (const label of ["self-hosted", "linux", "windows", "macos", "x64", "arm64", "UPPER CASE", ""]) {
      expect(RunnerTriggerLabel.safeParse(label).success).toBe(false);
    }
  });

  test("rejects mutable image tags and unknown request fields", () => {
    expect(CreatePoolRequest.safeParse({ ...valid, imageDigest: "ubuntu:latest" }).success).toBe(false);
    expect(CreatePoolRequest.safeParse({ ...valid, organizationId: "org" }).success).toBe(false);
  });
});
describe("webhook authenticity",()=>{test("verifies strict sha256 HMAC",()=>{const body=Buffer.from('{"ok":true}');const secret="test";const signature="sha256="+createHmac("sha256",secret).update(body).digest("hex");expect(validSignature(body,signature,secret)).toBe(true);expect(validSignature(body,"sha1="+createHash("sha256").update(body).digest("hex"),secret)).toBe(false);expect(validSignature(body,signature.slice(0,-1),secret)).toBe(false)})});
describe("worker handshake",()=>{test("requires Ed25519 proof of server nonce",()=>{const key=generateKeyPairSync("ed25519");const publicKey=key.publicKey.export({format:"pem",type:"spki"}).toString();const session=beginWorkerHandshake();expect(()=>authenticateWorker(session,publicKey,sign(null,session.nonce,key.privateKey))).not.toThrow();expect(session.authenticated).toBe(true)})});
import { buildMacWorkerJoinPayload, buildMacWorkerSocketUrl, handleMacWorkerCommand } from "../apps/orchestrator/src/mac-agent.ts";
import { createWorkerChallenge, decodeWorkerSignature } from "../apps/control-plane/src/worker-socket.ts";
describe("worker socket challenge",()=>{test("uses a 32-byte nonce and decodes signatures",()=>{const signature=Buffer.alloc(64,1);const challenge=createWorkerChallenge("worker-id");expect(challenge.workerId).toBe("worker-id");expect(challenge.nonce.length).toBe(32);expect(decodeWorkerSignature(signature.toString("base64url"))).toEqual(signature)})});
describe("macOS worker agent",()=>{test("builds audience-bound join and websocket endpoints",()=>{const payload=buildMacWorkerJoinPayload({code:"join",publicKey:"key",vmUuid:"vm",limits:{maxVcpuPerPod:2,maxMemoryBytesPerPod:4294967296,maxStorageBytesPerPod:21474836480,maxConcurrentPods:1}});expect(payload.platform).toBe("macos-arm64");expect(payload.code).toBe("join");expect(buildMacWorkerSocketUrl("http://localhost:3000","worker-id")).toBe("ws://localhost:3000/api/v1/workers/connect?workerId=worker-id")})});
import { displayCell } from "../apps/web/src/format.ts";
describe("worker table values",()=>{test("renders primitive values instead of renderer objects",()=>{expect(displayCell("macos-arm64")).toBe("macos-arm64");expect(displayCell(undefined)).toBe("—");expect(displayCell({value:"x"})).toBe("{\"value\":\"x\"}")})});
import { TartVmDriver, type TartVmRuntime } from "../apps/orchestrator/src/tart.ts";
describe("Tart VM lifecycle", () => {
  test("clones, sizes, starts, bootstraps, stops, and removes one VM lease", async () => {
    const calls: string[][] = [];
    const runtime: TartVmRuntime = {
      clone: async (base, name) => { calls.push(["clone", base, name]); },
      setResources: async (name, resources) => { calls.push(["set", name, String(resources.vcpu), String(resources.memoryBytes), String(resources.storageBytes)]); },
      injectBootstrap: async (name, config) => { calls.push(["inject", name, config]); },
      startRunner: async (name) => { calls.push(["runner", name]); },
      start: async (name) => { calls.push(["start", name]); },
      stop: async (name) => { calls.push(["stop", name]); },
      remove: async (name) => { calls.push(["remove", name]); },
    };
    const driver = new TartVmDriver(runtime, "base-image", "whitesmith-job");
    const lease = await driver.createLease({
      id: "11111111-1111-4111-8111-111111111111",
      imageDigest: "base-image",
      nonce: "nonce",
      encodedJitConfig: "jit-config",
      resources: { vcpu: 2, memoryBytes: 4294967296, storageBytes: 21474836480, concurrency: 1 },
    });
    expect(lease.state).toBe("sandbox_attested");
    expect(calls).toEqual([
      ["clone", "base-image", "whitesmith-job-11111111"],
      ["set", "whitesmith-job-11111111", "2", "4294967296", "21474836480"],
      ["start", "whitesmith-job-11111111"],
      ["inject", "whitesmith-job-11111111", "jit-config"],
      ["runner", "whitesmith-job-11111111"],
    ]);
    await driver.stopLease("11111111-1111-4111-8111-111111111111");
    await driver.removeLease("11111111-1111-4111-8111-111111111111");
    expect(calls.slice(-2)).toEqual([
      ["stop", "whitesmith-job-11111111"],
      ["remove", "whitesmith-job-11111111"],
    ]);
  });
});
