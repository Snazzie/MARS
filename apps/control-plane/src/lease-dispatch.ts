import { createCipheriv, createDecipheriv, createPublicKey, createPrivateKey, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";
import { LeaseBootstrapEnvelope } from "@whitesmith/contracts";

type Ciphertext = { version: 1; algorithm: "x25519-aes-256-gcm"; ephemeralPublicKey: string; iv: string; tag: string; ciphertext: string };
export type LeaseDispatchInput = LeaseBootstrapEnvelope & { driver: "kata-k3s" | "windows-hyperv" | "tart-vm"; workerId: string; workerEncryptionPublicKey: string };
type Dispatcher = { dispatch(input: { workerId: string; leaseId: string; type: string; payload: Record<string, unknown> }): Promise<unknown> };

function derive(shared: Buffer): Buffer { return shared.subarray(0, 32); }
export function sealLeaseBootstrap(envelope: LeaseBootstrapEnvelope, workerPublicKeyPem: string): Ciphertext {
  const recipient = createPublicKey(workerPublicKeyPem);
  const ephemeral = generateKeyPairSync("x25519");
  const key = derive(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  return { version: 1, algorithm: "x25519-aes-256-gcm", ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}
export function openLeaseBootstrap(value: Ciphertext, workerPrivateKeyPem: string): LeaseBootstrapEnvelope {
  if (value.version !== 1 || value.algorithm !== "x25519-aes-256-gcm") throw new Error("lease_ciphertext_invalid");
  try {
    const ephemeral = createPublicKey({ key: Buffer.from(value.ephemeralPublicKey, "base64url"), format: "der", type: "spki" });
    const key = derive(diffieHellman({ privateKey: createPrivateKey(workerPrivateKeyPem), publicKey: ephemeral }));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    const envelope = LeaseBootstrapEnvelope.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8")));
    if (Date.parse(envelope.expiresAt) <= Date.now()) throw new Error("lease_bootstrap_expired");
    return envelope;
  } catch (error) {
    if (error instanceof Error && error.message === "lease_bootstrap_expired") throw error;
    throw new Error("lease_ciphertext_invalid");
  }
}
export async function dispatchLeaseBootstrap(dispatcher: Dispatcher, input: LeaseDispatchInput): Promise<void> {
  const { workerId, workerEncryptionPublicKey, driver, ...envelope } = input;
  if (driver === "kata-k3s") throw new Error("unsupported lease driver: kata-k3s");
  const sealed = sealLeaseBootstrap(envelope, workerEncryptionPublicKey);
  const type = driver === "windows-hyperv" ? "hyperv.create_lease" : "tart.create_lease";
  void dispatcher.dispatch({ workerId, leaseId: envelope.leaseId, type, payload: { bootstrapCiphertext: sealed } }).catch(() => undefined);
}
