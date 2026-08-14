import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { HyperVDriver, powerShellCommand, type HyperVRuntime } from "./hyperv.ts";
const limits = { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 20 * 1024 ** 3, maxConcurrentPods: 2 };
const lease = { id: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", imageDigest: "sha256:" + "a".repeat(64), resources: { vcpu: 1, memoryBytes: 1024 ** 3, storageBytes: 4 * 1024 ** 3, concurrency: 1 }, nonce: "n".repeat(32), encodedJitConfig: "encrypted-bootstrap" };
function fake(calls: string[]): HyperVRuntime { const record = (value: string): (() => Promise<void>) => async () => { calls.push(value); }; return { verifyHost: record("verify"), createDifferencingDisk: async (p, c) => { calls.push(`diff:${p}:${c}`); }, createVm: async ({ name }) => { calls.push(`vm:${name}`); }, copyBootstrap: async (name, source, target) => { calls.push(`copy:${name}:${source}:${target}`); }, start: async name => { calls.push(`start:${name}`); }, waitForGuestReady: async name => { calls.push(`ready:${name}`); }, waitForStop: async name => { calls.push(`stopwait:${name}`); }, stop: async name => { calls.push(`stop:${name}`); }, remove: async name => { calls.push(`remove:${name}`); }, removeDisk: async path => { calls.push(`disk-remove:${path}`); }, reconcileOrphans: async prefix => { calls.push(`orphans:${prefix}`); } }; }
describe("HyperVDriver", () => {
  test("creates a differencing Gen 2 lease and waits for guest completion", async () => { const calls: string[] = []; const driver = new HyperVDriver(fake(calls), "C:\\templates\\windows.vhdx", lease.imageDigest, "whitesmith", limits, "C:\\temp"); await driver.reserveCapacity(lease.resources); const runtime = await driver.createLease(lease); expect(runtime.runtimeInstanceId).toContain("whitesmith-"); expect(calls[0]).toBe("verify"); expect(calls.some(call => call.startsWith("diff:"))).toBe(true); expect(calls.some(call => call.startsWith("ready:"))).toBe(true); await runtime.completion; expect(calls.some(call => call.startsWith("stopwait:"))).toBe(true); await driver.removeLease(lease.id); });
  test("rejects a lease whose image digest is not the sealed template", async () => { const driver = new HyperVDriver(fake([]), "template.vhdx", lease.imageDigest, "whitesmith", limits); await expect(driver.createLease({ ...lease, imageDigest: "sha256:" + "b".repeat(64) })).rejects.toThrow("does not match"); });
});
test("copies bootstrap to the guest service path", async () => { const calls: string[] = []; const driver = new HyperVDriver(fake(calls), "C:\\templates\\windows.vhdx", lease.imageDigest, "whitesmith", limits, "C:\\temp"); await driver.createLease(lease); expect(calls.some(call => call.endsWith(":C:\\ProgramData\\Whitesmith\\bootstrap.json"))).toBe(true); });
test("writes the guest service bootstrap envelope", async () => {
  const copied: string[] = [];
  const runtime = fake([]);
  runtime.copyBootstrap = async (_name, source) => { copied.push(await readFile(source, "utf8")); };
  const driver = new HyperVDriver(runtime, "C:\\templates\\windows.vhdx", lease.imageDigest, "whitesmith", limits, "C:\\temp");
  await driver.createLease(lease);
  expect(JSON.parse(copied[0])).toEqual({ version: 1, leaseId: lease.id, nonce: lease.nonce, encodedJitConfig: lease.encodedJitConfig });
});
test("wraps Hyper-V scripts so native command arguments populate PowerShell args", () => {
  expect(powerShellCommand("Write-Output $args[0]")).toBe("& { Write-Output $args[0] }");
});
