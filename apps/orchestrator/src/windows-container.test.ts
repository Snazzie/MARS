import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsContainerDriver, type DockerRunner } from "./windows-container.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("fails completion when a containerized job stops making terminal progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-windows-container-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "wait") return Promise.withResolvers<Awaited<ReturnType<DockerRunner>>>().promise;
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv" } }]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "whitesmith/windows-job:local",
    prefix: "whitesmith",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 10,
    allowLocalImage: true,
  }, docker);
  const lease = await driver.createLease({
    id: "11111111-1111-4111-8111-111111111111",
    jobId: "job",
    imageDigest: "whitesmith/windows-job:local",
    resources: { vcpu: 2, memoryBytes: 8 * 1024 ** 3, storageBytes: 10 * 1024 ** 3, concurrency: 1 },
    nonce: "n".repeat(32),
    encodedJitConfig: "config",
  });
  expect(calls.find((args) => args[0] === "create")).toContain("size=10737418240");

  await expect(lease.completion!).rejects.toThrow("container job timed out");
  await driver.removeLease("11111111-1111-4111-8111-111111111111");
});

test("removes a container when startup fails after creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-windows-container-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "start") return { code: 1, stdout: "", stderr: "startup failed" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "whitesmith/windows-job:local",
    prefix: "whitesmith",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
  }, docker);

  await expect(driver.createLease({
    id: "22222222-2222-4222-8222-222222222222",
    jobId: "job",
    imageDigest: "whitesmith/windows-job:local",
    resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 },
    nonce: "n".repeat(32),
    encodedJitConfig: "config",
  })).rejects.toThrow("docker start failed");
  expect(calls).toContainEqual(["rm", "-f", "whitesmith-22222222-2222-4222-8222-222222222222"]);
});

test("removes a known lease container after a worker restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-windows-container-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "whitesmith/windows-job:local",
    prefix: "whitesmith",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
  }, docker);

  await driver.removeLease("33333333-3333-4333-8333-333333333333");
  expect(calls).toContainEqual(["rm", "-f", "whitesmith-33333333-3333-4333-8333-333333333333"]);
});
