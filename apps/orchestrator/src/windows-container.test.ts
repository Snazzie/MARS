import { describe, expect, test } from "bun:test";
import { WindowsContainerDriver } from "./windows-container.ts";

const lease = { id: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", imageDigest: "sha256:" + "a".repeat(64), nonce: "n".repeat(32), encodedJitConfig: "secret", resources: { vcpu: 2, memoryBytes: 1024, storageBytes: 2048, concurrency: 1 } };
const image = "mcr.microsoft.com/windows/servercore@sha256:" + "a".repeat(64);
const fakeDocker = (calls: string[][], outputs: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) => async (args: string[]) => { calls.push(args); const key = args[0] ?? ""; const value = outputs[key] ?? { code: 0, stdout: key === "info" ? "windows\n" : key === "wait" ? "0\n" : "" }; return { code: value.code, stdout: value.stdout ?? "", stderr: value.stderr ?? "" }; };

describe("WindowsContainerDriver", () => {
  test("requires an immutable image digest", () => {
    expect(() => new WindowsContainerDriver({ image: "servercore:latest", limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4096, maxStorageBytesPerPod: 4096, maxConcurrentPods: 2 } })).toThrow("pinned");
  });

  test("probes Windows Docker mode with mandatory Hyper-V isolation", async () => {
    const calls: string[][] = [];
    const driver = new WindowsContainerDriver({ image, limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4096, maxStorageBytesPerPod: 4096, maxConcurrentPods: 2 }, docker: fakeDocker(calls) });
    await driver.reserveCapacity(lease.resources);
    expect(calls[0]).toEqual(["info", "--format", "{{.OSType}}"]);
    expect(calls[1]).toEqual(["run", "--rm", "--isolation=hyperv", image, "cmd", "/c", "exit", "0"]);
  });

  test("creates labeled resource-limited container without placing secret in argv", async () => {
    const calls: string[][] = [];
    const driver = new WindowsContainerDriver({ image, limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4096, maxStorageBytesPerPod: 4096, maxConcurrentPods: 2 }, bootstrapRoot: "C:\\Temp\\whitesmith-test", docker: fakeDocker(calls) });
    const runtime = await driver.createLease(lease);
    const create = calls.find((args) => args[0] === "create")!;
    expect(create).toContain("--isolation=hyperv");
    expect(create).toContain("--label");
    expect(create).toContain("com.whitesmith.lease=" + lease.id);
    expect(create).toContain("--cpus");
    expect(create).toContain("2");
    expect(create.join(" ")).not.toContain("secret");
    expect(runtime.runtimeInstanceId).toContain("whitesmith-");
    await driver.removeLease(lease.id);
    expect(calls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
  });

  test("rejects a lease image digest mismatch", async () => {
    const driver = new WindowsContainerDriver({ image, limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4096, maxStorageBytesPerPod: 4096, maxConcurrentPods: 2 }, docker: fakeDocker([]) });
    await expect(driver.createLease({ ...lease, imageDigest: "sha256:" + "b".repeat(64) })).rejects.toThrow("does not match");
  });

  test("fails when Docker is in Linux-container mode", async () => {
    const driver = new WindowsContainerDriver({ image, limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4096, maxStorageBytesPerPod: 4096, maxConcurrentPods: 2 }, docker: fakeDocker([], { info: { code: 0, stdout: "linux\n" } }) });
    await expect(driver.reserveCapacity(lease.resources)).rejects.toThrow("Windows-container mode");
  });
});
