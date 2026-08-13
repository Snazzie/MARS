import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { openLeaseBootstrap, sealLeaseBootstrap, dispatchLeaseBootstrap } from "./lease-dispatch.ts";

test("seals and opens a lease JIT bootstrap without plaintext payload", () => {
  const keys = generateKeyPairSync("x25519");
  const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const envelope = { leaseId: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString(), imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 } };
  const sealed = sealLeaseBootstrap(envelope, publicKey);
  expect(JSON.stringify(sealed)).not.toContain("secret");
  expect(openLeaseBootstrap(sealed, privateKey)).toEqual(envelope);
});

test("dispatches ciphertext under a non-secret command field", async () => {
  const calls: unknown[] = [];
  const keys = generateKeyPairSync("x25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const envelope = { leaseId: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", nonce: "n".repeat(32), guestPlatform: "macos-arm64" as const, encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString(), imageDigest: "sha256:test", resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 } };
  await dispatchLeaseBootstrap({ dispatch: async (input: unknown) => { calls.push(input); } }, { driver: "tart-vm", ...envelope, workerId: "22222222-2222-4222-8222-222222222222", workerEncryptionPublicKey: publicKey });
  expect((calls[0] as { type: string }).type).toBe("tart.create_lease");
  expect(JSON.stringify(calls[0])).not.toContain("secret");
});

test("dispatches Windows leases to the Hyper-V VM command", async () => {
  const calls: unknown[] = [];
  const keys = generateKeyPairSync("x25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  await dispatchLeaseBootstrap({ dispatch: async (input: unknown) => { calls.push(input); } }, { driver: "windows-hyperv", leaseId: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333", workerEncryptionPublicKey: publicKey, guestPlatform: "windows-x64", imageDigest: "sha256:" + "a".repeat(64), resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 }, nonce: "n".repeat(32), encodedJitConfig: "secret", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  expect((calls[0] as { type: string }).type).toBe("hyperv.create_lease");
});
