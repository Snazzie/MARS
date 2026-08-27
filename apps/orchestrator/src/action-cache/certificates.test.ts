import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadOrCreateCertificateAuthority } from "./certificates.ts";
import { openActionCacheStore } from "./store.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "mars-cache-credentials-")); roots.push(value); return value; }

test("persists a private worker CA at UUID-derived paths and signs short-lived host leaves", async () => {
  const cacheRoot = await root();
  const store = await openActionCacheStore({ root: cacheRoot, ttlSeconds: 3600 });
  const first = await loadOrCreateCertificateAuthority(store);
  expect(basename(first.privateKeyPath)).toMatch(/^[0-9a-f-]{36}\.key$/);
  expect(basename(first.certificatePath)).toMatch(/^[0-9a-f-]{36}\.crt$/);
  expect(first.certificatePem).toContain("BEGIN CERTIFICATE");
  expect(first.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
  const leaf = await first.issueLeaf("results-receiver.actions.githubusercontent.com", new Date("2026-08-23T00:00:00.000Z"));
  expect(leaf.certificatePem).toContain("BEGIN CERTIFICATE");
  expect(leaf.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
  expect(leaf.expiresAt.getTime() - new Date("2026-08-23T00:00:00.000Z").getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  const second = await loadOrCreateCertificateAuthority(store);
  expect(second.certificatePem).toBe(first.certificatePem);
  expect(await readFile(first.privateKeyPath, "utf8")).toBe(first.privateKeyPem);
  if (process.platform !== "win32") expect((await stat(first.privateKeyPath)).mode & 0o777).toBe(0o600);
  await store.close();
});

test("recovers an interrupted worker CA pair publication", async () => {
  const cacheRoot = await root();
  const store = await openActionCacheStore({ root: cacheRoot, ttlSeconds: 3600 });
  const privateKeyPath = store.persistentSecretPath("worker-ca-private", ".key");
  await writeFile(privateKeyPath, "interrupted", { mode: 0o600 });
  const recovered = await loadOrCreateCertificateAuthority(store);
  expect(recovered.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
  expect(recovered.certificatePem).toContain("BEGIN CERTIFICATE");
  expect((await readdir(join(cacheRoot, "secrets"))).some((name) => name.endsWith(".tmp"))).toBe(false);
  await store.close();
});

