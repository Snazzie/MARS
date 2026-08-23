import { expect, test } from "bun:test";
import { buildTartBootstrapArguments, buildTartRunnerArguments, buildTartSetArguments, resolveTartExecutable, TART_JIT_CONFIG_PATH, TartVmDriver } from "./tart.ts";
import * as tartModule from "./tart.ts";
import type { WorkerCacheProxy } from "@whitesmith/contracts";

const resources = (storageBytes: number) => ({ vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes, concurrency: 1 });
const workerCache: WorkerCacheProxy = { proxyUrl: "http://127.0.0.1:39123", cacheBaseUrl: "https://127.0.0.1:39443", caCertificatePem: "worker-ca", expiresAt: new Date(Date.now() + 60_000).toISOString() };

test("does not ask Tart to shrink a cloned base-image disk", () => {
  expect(buildTartSetArguments("lease-vm", resources(20 * 1024 ** 3), 50)).toEqual([
    "set", "lease-vm", "--cpu", "4", "--memory", "4096",
  ]);
});

test("expands a cloned disk when the lease requests more than the image", () => {
  expect(buildTartSetArguments("lease-vm", resources(60 * 1024 ** 3), 50)).toEqual([
    "set", "lease-vm", "--cpu", "4", "--memory", "4096", "--disk-size", "60",
  ]);
});

test("starts the VM with only a read-only bootstrap directory path", () => {
  const buildTartRunArguments = (tartModule as typeof tartModule & {
    buildTartRunArguments?: (vmName: string, bootstrapDirectory: string) => string[];
  }).buildTartRunArguments;
  expect(buildTartRunArguments).toBeFunction();
  expect(buildTartRunArguments!("lease-vm", "/private/tmp/whitesmith-bootstrap")).toEqual([
    "run",
    "--no-graphics",
    "--dir",
    "/private/tmp/whitesmith-bootstrap:ro",
    "lease-vm",
  ]);
});

test("copies bootstrap configuration from the read-only VM share without stdin attachment", () => {
  expect(buildTartBootstrapArguments("lease-vm")).toEqual([
    "exec",
    "lease-vm",
    "sh",
    "-c",
    `set -eu; umask 077; install -d -m 700 /tmp/whitesmith; rm -f ${TART_JIT_CONFIG_PATH}; cat "/Volumes/My Shared Files/jit-config" > ${TART_JIT_CONFIG_PATH}`,
  ]);
  expect(TART_JIT_CONFIG_PATH).toBe("/tmp/whitesmith/jit-config");
});

test("passes the Actions Runner root explicitly to the guest job agent", () => {
  expect(buildTartRunnerArguments("lease-vm")).toEqual([
    "exec",
    "lease-vm",
    "/usr/local/bin/whitesmith-job-agent",
    "bootstrap",
    "--config-file",
    TART_JIT_CONFIG_PATH,
    "--runner-root",
    "/opt/actions-runner",
  ]);
});
test("passes the worker cache descriptor into Tart full bootstrap", async () => {
  let received: unknown;
  const tart = {
    clone: async () => {},
    setResources: async () => {},
    startWithBootstrap: async (_vm: string, _jit: string, cache?: WorkerCacheProxy) => { received = cache; },
    startRunner: () => ({ completion: Promise.resolve(0), logs: (async function* () {})() }),
    stop: async () => {},
    remove: async () => {},
  };
  const driver = new TartVmDriver(tart, "base", "whitesmith");
  await driver.createLease({ id: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", imageDigest: "base", resources: resources(20 * 1024 ** 3), nonce: "n".repeat(32), encodedJitConfig: "jit", workerCache });
  expect(received).toEqual(workerCache);
});


test("uses the installer-provided absolute Tart executable under launchd", () => {
  expect(resolveTartExecutable("/opt/homebrew/bin/tart")).toBe("/opt/homebrew/bin/tart");
  expect(resolveTartExecutable("")).toBe("tart");
});

test("stops and deletes an orphan lease by its deterministic VM name", async () => {
  const calls: string[][] = [];
  const runtime = {
    clone: async () => {},
    setResources: async () => {},
    startWithBootstrap: async () => {},
    startRunner: () => ({ completion: Promise.resolve(0), logs: (async function* () {})() }),
    stop: async (name: string) => { calls.push(["stop", name]); },
    remove: async (name: string) => { calls.push(["remove", name]); },
  };
  const driver = new TartVmDriver(runtime, "base", "whitesmith-job");
  const leaseId = "22222222-2222-4222-8222-222222222222";
  await driver.stopLease(leaseId);
  await driver.removeLease(leaseId);
  expect(calls).toEqual([
    ["stop", "whitesmith-job-22222222"],
    ["remove", "whitesmith-job-22222222"],
  ]);
});

test("treats an already deleted orphan VM as reaped", async () => {
  const runtime = {
    clone: async () => {},
    setResources: async () => {},
    startWithBootstrap: async () => {},
    startRunner: () => ({ completion: Promise.resolve(0), logs: (async function* () {})() }),
    stop: async () => {},
    remove: async () => { throw new Error('tart delete failed: the specified VM "whitesmith-job-22222222" does not exist'); },
  };
  const driver = new TartVmDriver(runtime, "base", "whitesmith-job");
  await expect(driver.removeLease("22222222-2222-4222-8222-222222222222")).resolves.toBeUndefined();
});
