import { isIP } from "node:net";
import { open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import forge from "node-forge";
import { secureWorkerPrivatePath, type ActionCacheStore } from "./store.ts";

export type IssuedLeafCertificate = { certificatePem: string; privateKeyPem: string; expiresAt: Date };
export interface WorkerCertificateAuthority {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  issueLeaf(hostname: string, now?: Date, alternativeHostnames?: string[]): Promise<IssuedLeafCertificate>;
}

function serialNumber(): string {
  return `01${randomBytes(15).toString("hex")}`;
}

function createCertificateAuthority(): { certificatePem: string; privateKeyPem: string } {
  const keyPair = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keyPair.publicKey;
  certificate.serialNumber = serialNumber();
  certificate.validity.notBefore = new Date(Date.now() - 5 * 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000);
  const attributes = [{ name: "commonName", value: "Whitesmith Worker Cache CA" }, { name: "organizationName", value: "Whitesmith" }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(keyPair.privateKey, forge.md.sha256.create());
  return { certificatePem: forge.pki.certificateToPem(certificate), privateKeyPem: forge.pki.privateKeyToPem(keyPair.privateKey) };
}

function certificateAuthorityFromPem(certificatePem: string, privateKeyPem: string, certificatePath: string, privateKeyPath: string): WorkerCertificateAuthority {
  const caCertificate = forge.pki.certificateFromPem(certificatePem);
  const caPrivateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  return {
    certificatePem,
    privateKeyPem,
    certificatePath,
    privateKeyPath,
    async issueLeaf(hostname: string, now = new Date(), alternativeHostnames: string[] = []): Promise<IssuedLeafCertificate> {
      const hostnames = [...new Set([hostname, ...alternativeHostnames])];
      if (hostnames.some((value) => !value || /[\s/\[\]]/.test(value))) throw new Error("certificate hostname is invalid");
      const keyPair = forge.pki.rsa.generateKeyPair(2048);
      const certificate = forge.pki.createCertificate();
      certificate.publicKey = keyPair.publicKey;
      certificate.serialNumber = serialNumber();
      certificate.validity.notBefore = new Date(now.getTime() - 5 * 60_000);
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
      certificate.validity.notAfter = expiresAt;
      certificate.setSubject([{ name: "commonName", value: hostname }, { name: "organizationName", value: "Whitesmith" }]);
      certificate.setIssuer(caCertificate.subject.attributes);
      const alternativeNames = hostnames.map((value) => isIP(value) ? { type: 7, ip: value } : { type: 2, value });
      certificate.setExtensions([
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: alternativeNames },
      ]);
      certificate.sign(caPrivateKey, forge.md.sha256.create());
      return { certificatePem: forge.pki.certificateToPem(certificate), privateKeyPem: forge.pki.privateKeyToPem(keyPair.privateKey), expiresAt };
    },
  };
}

async function writeSynced(path: string, content: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

async function syncSecretsDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function loadOrCreateCertificateAuthority(store: ActionCacheStore): Promise<WorkerCertificateAuthority> {
  const privateKeyPath = store.persistentSecretPath("worker-ca-private", ".key");
  const certificatePath = store.persistentSecretPath("worker-ca-certificate", ".crt");
  const secretsDirectory = dirname(privateKeyPath);
  for (const name of await readdir(secretsDirectory)) if (name.endsWith(".tmp")) await rm(join(secretsDirectory, name), { force: true });
  const [keyResult, certificateResult] = await Promise.allSettled([readFile(privateKeyPath, "utf8"), readFile(certificatePath, "utf8")]);
  if (keyResult.status === "fulfilled" && certificateResult.status === "fulfilled") {
    await secureWorkerPrivatePath(privateKeyPath);
    return certificateAuthorityFromPem(certificateResult.value, keyResult.value, certificatePath, privateKeyPath);
  }
  for (const result of [keyResult, certificateResult]) {
    if (result.status === "rejected" && (result.reason as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("worker cache CA is unreadable", { cause: result.reason });
  }
  await Promise.all([rm(privateKeyPath, { force: true }), rm(certificatePath, { force: true })]);
  const created = createCertificateAuthority();
  const keyTemporary = join(secretsDirectory, `${randomUUID()}.tmp`);
  const certificateTemporary = join(secretsDirectory, `${randomUUID()}.tmp`);
  try {
    await Promise.all([writeSynced(keyTemporary, created.privateKeyPem), writeSynced(certificateTemporary, created.certificatePem)]);
    await rename(keyTemporary, privateKeyPath);
    await syncSecretsDirectory(secretsDirectory);
    await rename(certificateTemporary, certificatePath);
    await syncSecretsDirectory(secretsDirectory);
  } catch (error) {
    await Promise.all([rm(keyTemporary, { force: true }), rm(certificateTemporary, { force: true })]);
    throw new Error("worker cache CA persistence failed", { cause: error });
  }
  await secureWorkerPrivatePath(privateKeyPath);
  return certificateAuthorityFromPem(created.certificatePem, created.privateKeyPem, certificatePath, privateKeyPath);
}
