import { expect, test } from "bun:test";
import { buildTartBootstrapArguments, buildTartRunnerArguments, buildTartSetArguments, resolveTartExecutable, TART_JIT_CONFIG_PATH, TartVmDriver } from "./tart.ts";
import * as tartModule from "./tart.ts";
import type { WorkerCacheProxy } from "@mars/contracts";

const resources = (storageBytes: number) => ({ vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes, concurrency: 1 });
const workerCache: WorkerCacheProxy = { proxyUrl: "http://127.0.0.1:39123", cacheBaseUrl: "https://127.0.0.1:39443", caCertificatePem: "worker-ca", expiresAt: new Date(Date.now() + 60_000).toISOString(), registrationUrl: "https://127.0.0.1:39443/_mars/register", registrationChallenge: "c".repeat(32) };

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
  expect(buildTartRunArguments!("lease-vm", "/private/tmp/mars-bootstrap")).toEqual([
    "run",
    "--no-graphics",
    "--no-audio",
    "lease-vm",
  ]);
});
test("streams bootstrap configuration through Tart stdin", () => {
  expect(buildTartBootstrapArguments("lease-vm")).toEqual([
    "exec",
    "-i",
    "lease-vm",
    "sh",
    "-c",
    `set -eu; umask 077; install -d -m 700 /tmp/mars; rm -f ${TART_JIT_CONFIG_PATH}; cat > ${TART_JIT_CONFIG_PATH}; chmod 600 ${TART_JIT_CONFIG_PATH}`,
  ]);
});


test("passes the Actions Runner root explicitly to the guest job agent", () => {
  expect(buildTartRunnerArguments("lease-vm")).toEqual([
    "exec",
    "lease-vm",
    "/usr/local/bin/mars-job-agent",
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
  const driver = new TartVmDriver(tart, "base", "mars", undefined, "0.1.0");
  await driver.createLease({ id: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", contractVersion: "0.1.0", imageDigest: "different-digest", resources: resources(20 * 1024 ** 3), nonce: "n".repeat(32), encodedJitConfig: "jit", workerCache });
  expect(received).toEqual(workerCache);
});
test("forwards Tart VM resource samples including guest disk usage", async () => {
  const tart = {
    clone: async () => {},
    setResources: async () => {},
    startWithBootstrap: async () => {},
    startRunner: () => ({ completion: Promise.resolve(0), logs: (async function* () {})() }),
    sample: async () => ({ cpuUsagePercent: 12.5, cpuTimeMs: 0, memoryWorkingSetBytes: 1024, memoryLimitBytes: 2048, diskUsageBytes: 4096 }),
    stop: async () => {},
    remove: async () => {},
  };
  const driver = new TartVmDriver(tart, "base", "mars", undefined, "0.1.0");
  const runtime = await driver.createLease({ id: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", contractVersion: "0.1.0", imageDigest: "base", resources: resources(20 * 1024 ** 3), nonce: "n".repeat(32), encodedJitConfig: "jit" });
  expect(await runtime.sample?.()).toEqual({ cpuUsagePercent: 12.5, cpuTimeMs: 0, memoryWorkingSetBytes: 1024, memoryLimitBytes: 2048, diskUsageBytes: 4096 });
});

test("serializes Tart provisioning while keeping completed VMs concurrent", async () => {
  const calls: string[] = [];
  const firstBootstrap = Promise.withResolvers<void>();
  const firstBootstrapStarted = Promise.withResolvers<void>();
  const tart = {
    clone: async (_base: string, vm: string) => { calls.push(`clone:${vm}`); },
    setResources: async () => {},
    startWithBootstrap: async (vm: string) => {
      calls.push(`bootstrap:${vm}`);
      if (vm === "mars-job-11111111") {
        firstBootstrapStarted.resolve();
        await firstBootstrap.promise;
      }
    },
    startRunner: () => ({ completion: new Promise<number>(() => {}), logs: (async function* () {})() }),
    stop: async () => {},
    remove: async () => {},
  };
  const driver = new TartVmDriver(tart, "base", "mars-job", undefined, "0.1.0");
  const lease = (id: string) => ({ id, jobId: crypto.randomUUID(), contractVersion: "0.1.0", imageDigest: "base", resources: resources(20 * 1024 ** 3), nonce: "n".repeat(32), encodedJitConfig: "jit" });
  const first = driver.createLease(lease("11111111-1111-4111-8111-111111111111"));
  const second = driver.createLease(lease("22222222-2222-4222-8222-222222222222"));
  await firstBootstrapStarted.promise;
  expect(calls).toEqual(["clone:mars-job-11111111", "bootstrap:mars-job-11111111"]);
  firstBootstrap.resolve();
  await Promise.all([first, second]);
  expect(calls).toEqual([
    "clone:mars-job-11111111",
    "bootstrap:mars-job-11111111",
    "clone:mars-job-22222222",
    "bootstrap:mars-job-22222222",
  ]);
});
test("rejects an incompatible worker contract version", async () => {
  const tart = {
    clone: async () => {},
    setResources: async () => {},
    startWithBootstrap: async () => {},
    startRunner: () => ({ completion: Promise.resolve(0), logs: (async function* () {})() }),
    stop: async () => {},
    remove: async () => {},
  };
  const driver = new TartVmDriver(tart, "base", "mars", undefined, "0.1.0");
  await expect(driver.createLease({ id: "33333333-3333-4333-8333-333333333333", jobId: "44444444-4444-4444-8444-444444444444", contractVersion: "1.0.0", imageDigest: "base", resources: resources(20 * 1024 ** 3), nonce: "n".repeat(32), encodedJitConfig: "jit" })).rejects.toThrow("worker contract 0.1.0 is not supported");
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
  const driver = new TartVmDriver(runtime, "base", "mars-job");
  const leaseId = "22222222-2222-4222-8222-222222222222";
  await driver.stopLease(leaseId);
  await driver.removeLease(leaseId);
  expect(calls).toEqual([
    ["stop", "mars-job-22222222"],
    ["remove", "mars-job-22222222"],
  ]);
});

test("treats an already deleted orphan VM as reaped", async () => {
  const runtime = {
    clone: async () => {},
    setResources: async () => {},
    startWithBootstrap: async () => {},
    startRunner: () => ({ completion: Promise.resolve(0), logs: (async function* () {})() }),
    stop: async () => {},
    remove: async () => { throw new Error('tart delete failed: the specified VM "mars-job-22222222" does not exist'); },
  };
  const driver = new TartVmDriver(runtime, "base", "mars-job");
  await expect(driver.removeLease("22222222-2222-4222-8222-222222222222")).resolves.toBeUndefined();
});
