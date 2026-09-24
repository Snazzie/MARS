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

test("requires native Linux ARM64 Docker and digest-pinned image", async () => {
  const driver = new LinuxContainerDriver(config(), fakeDocker([] , "amd64"));
  await expect(driver.reserveCapacity(lease.resources)).rejects.toThrow("ARM64 Docker engine");
  expect(() => new LinuxContainerDriver(config({ image: "ghcr.io/mars/job:latest" })).validatePool(lease.resources)).toThrow("digest pinned");
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
