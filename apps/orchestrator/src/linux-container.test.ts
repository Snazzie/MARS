import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxContainerDriver, type LinuxContainerConfig } from "./linux-container.ts";
import type { DockerRunner } from "./windows-container.ts";

const image = `ghcr.io/snazzie/mars/linux-arm64-job@sha256:${"a".repeat(64)}`;
const limits = { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 32 * 1024 ** 3, maxConcurrentPods: 4 };
const lease = { id: "11111111-1111-4111-8111-111111111111", jobId: "job", contractVersion: "0.2.0", imageDigest: image, resources: { vcpu: 2, memoryBytes: 1024, storageBytes: 2048, concurrency: 1 }, nonce: "n".repeat(32), encodedJitConfig: "encoded" };
function fakeDocker(calls: string[][], architecture = "arm64"): DockerRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ OSType: "linux", Architecture: architecture }), stderr: "" };
    if (args[0] === "image") return { code: 0, stdout: JSON.stringify({ RepoDigests: [image], Os: "linux", Architecture: "arm64", Config: { Entrypoint: ["/usr/local/bin/entrypoint.sh"] } }), stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Id: "container-id", Config: { Image: image, Labels: { "mars.managed": "true", "mars.platform": "linux-arm64", "mars.lease-id": lease.id } }, HostConfig: { NanoCpus: 2_000_000_000, Memory: 1024 }, State: { Status: "running" } }]), stderr: "" };
    if (args[0] === "wait") return { code: 0, stdout: "0", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}
function config(overrides: Partial<LinuxContainerConfig> = {}): LinuxContainerConfig { return { image, prefix: "mars", network: "mars-linux-arm64", limits, ...overrides }; }

test("rejects an ARM64 configuration when the Docker engine reports AMD64", async () => {
  const driver = new LinuxContainerDriver(config(), fakeDocker([] , "amd64"));
  await expect(driver.reserveCapacity(lease.resources)).rejects.toThrow();
  const invalidImageDriver = new LinuxContainerDriver(config({ image: "ghcr.io/mars/job:latest" }));
  expect(() => invalidImageDriver.validatePool(lease.resources)).toThrow();
});

test("creates a labeled ARM container with exact limits and bootstrap handoff", async () => {
  const calls: string[][] = [];
  const driver = new LinuxContainerDriver(config(), fakeDocker(calls));
  const runtime = await driver.createLease(lease);
  expect(runtime.observed).toEqual({ vcpu: 2, memoryBytes: 1024, storageBytes: 2048 });
  expect(calls.find((args) => args[0] === "create")).toEqual(expect.arrayContaining(["--platform", "linux/arm64", "--network", "mars-linux-arm64", "--cpus", "2", "--memory", "1024", "--label", "mars.platform=linux-arm64", "--label", `mars.lease-id=${lease.id}`, image]));
  expect(calls.find((args) => args[0] === "cp")).toEqual(expect.arrayContaining([expect.stringContaining(join(tmpdir(), "mars-linux-arm64")), expect.stringContaining(":/var/lib/mars/bootstrap/bootstrap.json")]));
  await expect(access(join(tmpdir(), "mars-linux-arm64", lease.id, "bootstrap.json"))).rejects.toThrow();
  await driver.removeLease(lease.id);
});
test("creates an x64 Linux container with isolated ownership and validates x64 image and engine", async () => {
  const calls: string[][] = [];
  const x64Image = `ghcr.io/snazzie/mars/linux-x64-job@sha256:${"b".repeat(64)}`;
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }), stderr: "" };
    if (args[0] === "image") return { code: 0, stdout: JSON.stringify({ RepoDigests: [x64Image], Os: "linux", Architecture: "amd64", Config: { Entrypoint: ["/usr/local/bin/entrypoint.sh"] } }), stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Id: "x64-container", Config: { Image: x64Image, Labels: { "mars.managed": "true", "mars.platform": "linux-x64", "mars.lease-id": lease.id } }, HostConfig: { NanoCpus: 2_000_000_000, Memory: 1024 }, State: { Status: "running" } }]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const x64Lease = { ...lease, imageDigest: x64Image };
  const driver = new LinuxContainerDriver(config({ image: x64Image, network: "mars-linux-x64", architecture: "amd64", platform: "linux/amd64" }), runner);
  await driver.createLease(x64Lease);
  const create = calls.find((args) => args[0] === "create")!;
  expect(create).toEqual(expect.arrayContaining(["--platform", "linux/amd64", "--label", "mars.platform=linux-x64", "--network", "mars-linux-x64", x64Image]));
  await driver.removeLease(lease.id);
});
