import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsContainerDriver, type DockerRunner } from "./windows-container.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
test("rejects a local image without a verified matching manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-windows-manifest-"));
  roots.push(root);
  const manifestPath = join(root, "windows-job-image.json");
  await Bun.write(manifestPath, JSON.stringify({ schemaVersion: 1, image: "whitesmith/windows-job:local", imageId: "sha256:old", runtimeProbe: { mediaFoundation: true, dns: true, tcp443: true } }));
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    if (args[0] === "image" && args[1] === "inspect" && args.includes("{{.Id}}")) return { code: 0, stdout: "sha256:new\n", stderr: "" };
    return { code: 0, stdout: "[]", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "whitesmith/windows-job:local",
    prefix: "whitesmith",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
    imageManifestPath: manifestPath,
    requireLocalImageManifest: true,
  }, docker);
  await expect(driver.reserveCapacity({ vcpu: 1, memoryBytes: 1, storageBytes: 1, concurrency: 1 })).rejects.toThrow("image ID mismatch");
});

test("rejects a container when Docker applies different CPU or memory limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-windows-resource-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 1_000_000_000, Memory: 1024 } }]), stderr: "" };
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
    id: "44444444-4444-4444-8444-444444444444",
    jobId: "job",
    imageDigest: "whitesmith/windows-job:local",
    resources: { vcpu: 2, memoryBytes: 8 * 1024 ** 3, storageBytes: 10 * 1024 ** 3, concurrency: 1 },
    nonce: "n".repeat(32),
    encodedJitConfig: "config",
  })).rejects.toThrow("resource limits");
  expect(calls).toContainEqual(["rm", "-f", "whitesmith-44444444-4444-4444-8444-444444444444"]);
});

test("fails completion when a containerized job stops making terminal progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-windows-container-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "wait") return Promise.withResolvers<Awaited<ReturnType<DockerRunner>>>().promise;
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 2_000_000_000, Memory: 8 * 1024 ** 3 } }]), stderr: "" };
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
  const createArgs = calls.find((args) => args[0] === "create")!;
  expect(createArgs).toContain("--cpus");
  expect(createArgs).toContain("2");
  expect(createArgs).toContain("--memory");
  expect(createArgs).toContain(String(8 * 1024 ** 3));
  expect(createArgs).toContain("size=10737418240");
  expect(lease.observed).toEqual({ vcpu: 2, memoryBytes: 8 * 1024 ** 3, storageBytes: 10 * 1024 ** 3 });

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
