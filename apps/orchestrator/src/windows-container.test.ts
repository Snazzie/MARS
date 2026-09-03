import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsContainerDriver, type DockerRunner } from "./windows-container.ts";
import type { WorkerCacheProxy } from "@mars/contracts";

const workerCache: WorkerCacheProxy = { proxyUrl: "http://127.0.0.1:39123", cacheBaseUrl: "https://127.0.0.1:39443", caCertificatePem: "worker-ca", expiresAt: new Date(Date.now() + 60_000).toISOString() };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
test("rejects a local image without a verified matching manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-manifest-"));
  roots.push(root);
  const manifestPath = join(root, "windows-job-image.json");
  await Bun.write(manifestPath, JSON.stringify({ schemaVersion: 1, image: "mars/windows-job:local", imageId: "sha256:old", runtimeProbe: { mediaFoundation: true, dns: true, tcp443: true } }));
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    if (args[0] === "image" && args[1] === "inspect" && args.includes("{{.Id}}")) return { code: 0, stdout: "sha256:new\n", stderr: "" };
    return { code: 0, stdout: "[]", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "mars/windows-job:local",
    prefix: "mars",
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
test("includes worker cache descriptor in Windows container bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-cache-"));
  roots.push(root);
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    if (args[0] === "image") return { code: 0, stdout: JSON.stringify(["repo@sha256:" + "a".repeat(64)]), stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 1_000_000_000, Memory: 1024 } }]), stderr: "" };
    return { code: 0, stdout: "0", stderr: "" };
  };
  const driver = new WindowsContainerDriver({ image: "repo@sha256:" + "a".repeat(64), prefix: "mars", bootstrapRoot: root, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 }, readyTimeoutMs: 100, jobTimeoutMs: 100 }, docker);
  const leaseId = "33333333-3333-4333-8333-333333333333";
  await driver.createLease({ id: leaseId, jobId: "job", imageDigest: "repo@sha256:" + "a".repeat(64), resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 }, nonce: "n".repeat(32), encodedJitConfig: "config", workerCache });
  expect(JSON.parse(await readFile(join(root, leaseId, "bootstrap.json"), "utf8")).workerCache).toEqual(workerCache);
});
test("passes configured DNS servers to Docker create", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-dns-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    calls.push(args);
    if (args[0] === "image") return { code: 0, stdout: JSON.stringify([config.image]), stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 1_000_000_000, Memory: 1024 } }]), stderr: "" };
    return { code: 0, stdout: "0", stderr: "" };
  };
  const config = {
    image: "repo@sha256:" + "a".repeat(64),
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    dnsServers: ["10.36.172.244", " 2001:4860:4860::8888 ", "not-a-dns-server", ""],
    jobTimeoutMs: 100,
  };
  const driver = new WindowsContainerDriver(config, docker);

  await driver.createLease({
    id: "55555555-5555-4555-8555-555555555555",
    jobId: "job",
    imageDigest: config.image,
    resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 },
    nonce: "n".repeat(32),
    encodedJitConfig: "config",
  });

  const createArgs = calls.find((args) => args[0] === "create")!;
  expect(createArgs).toContainEqual("--dns");
  expect(createArgs).toContainEqual("10.36.172.244");
  expect(createArgs).toContainEqual("2001:4860:4860::8888");
  expect(createArgs).not.toContain("not-a-dns-server");
  await driver.removeLease("55555555-5555-4555-8555-555555555555");
});

test("rejects a container when Docker applies different CPU or memory limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-resource-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    calls.push(args);
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 1_000_000_000, Memory: 1024 } }]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "mars/windows-job:local",
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
  }, docker);

  await expect(driver.createLease({
    id: "44444444-4444-4444-8444-444444444444",
    jobId: "job",
    imageDigest: "mars/windows-job:local",
    resources: { vcpu: 2, memoryBytes: 8 * 1024 ** 3, storageBytes: 10 * 1024 ** 3, concurrency: 1 },
    nonce: "n".repeat(32),
    encodedJitConfig: "config",
  })).rejects.toThrow("resource limits");
  expect(calls).toContainEqual(["rm", "-f", "mars-44444444-4444-4444-8444-444444444444"]);
});

test("fails completion when a containerized job stops making terminal progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-container-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    calls.push(args);
    if (args[0] === "wait") return Promise.withResolvers<Awaited<ReturnType<DockerRunner>>>().promise;
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 2_000_000_000, Memory: 8 * 1024 ** 3 } }]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "mars/windows-job:local",
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 10,
    allowLocalImage: true,
  }, docker);
  const lease = await driver.createLease({
    id: "11111111-1111-4111-8111-111111111111",
    jobId: "job",
    imageDigest: "mars/windows-job:local",
    resources: { vcpu: 2, memoryBytes: 8 * 1024 ** 3, storageBytes: 10 * 1024 ** 3, concurrency: 1 },
    nonce: "n".repeat(32),
    encodedJitConfig: "config",
  });
  const createArgs = calls.find((args) => args[0] === "create")!;
  expect(createArgs).not.toContain("--dns");
  expect(createArgs).toContain("--cpus");
  expect(createArgs).toContain("2");
  expect(createArgs).toContain("--memory");
  expect(createArgs).toContain(String(8 * 1024 ** 3));
  expect(createArgs).toContain("--log-driver");
  expect(createArgs).toContain("json-file");
  expect(createArgs).toContain("max-size=50m");
  expect(createArgs).toContain("max-file=3");
  expect(createArgs).toContain("size=10737418240");
  expect(lease.observed).toEqual({ vcpu: 2, memoryBytes: 8 * 1024 ** 3, storageBytes: 10 * 1024 ** 3 });

  await expect(lease.completion!).rejects.toThrow("container job timed out");
  await driver.removeLease("11111111-1111-4111-8111-111111111111");
});

test("removes a container when startup fails after creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-container-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    calls.push(args);
    if (args[0] === "start") return { code: 1, stdout: "", stderr: "startup failed" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "mars/windows-job:local",
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
  }, docker);

  await expect(driver.createLease({
    id: "22222222-2222-4222-8222-222222222222",
    jobId: "job",
    imageDigest: "mars/windows-job:local",
    resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 },
    nonce: "n".repeat(32),
    encodedJitConfig: "config",
  })).rejects.toThrow("docker start failed");
  expect(calls).toContainEqual(["rm", "-f", "mars-22222222-2222-4222-8222-222222222222"]);
});

test("removes a known lease container after a worker restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-container-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "mars/windows-job:local",
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
  }, docker);

  await driver.removeLease("33333333-3333-4333-8333-333333333333");
  expect(calls).toContainEqual(["rm", "-f", "mars-33333333-3333-4333-8333-333333333333"]);
});

test("copies runner and worker diagnostic logs from a stopped container", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-diag-"));
  roots.push(root);
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 1_000_000_000, Memory: 1024 } }]), stderr: "" };
    if (args[0] === "cp") {
      const destination = args.at(-1)!;
      await mkdir(destination, { recursive: true });
      await Bun.write(join(destination, "Runner_2026.log"), "job completed Authorization: Bearer secret-token\n");
      await Bun.write(join(destination, "Worker_2026.log"), "worker failure\n");
    }
    return { code: 0, stdout: args[0] === "wait" ? "0\n" : "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "mars/windows-job:local",
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
  }, docker);
  await driver.createLease({ id: "77777777-7777-4777-8777-777777777777", jobId: "job", imageDigest: "mars/windows-job:local", resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 }, nonce: "n".repeat(32), encodedJitConfig: "config" });
  const diagnostics = await driver.collectRawDiagnostics("77777777-7777-4777-8777-777777777777");
  expect(diagnostics).toContain("Runner_2026.log");
  expect(diagnostics).toContain("job completed Authorization: Bearer [REDACTED]");
  expect(diagnostics).toContain("Worker_2026.log");
  await driver.removeLease("77777777-7777-4777-8777-777777777777");
});

test("falls back to the configured memory limit when Docker stats reports an invalid limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-stats-"));
  roots.push(root);
  const configuredMemory = 10 * 1024 ** 3;
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 2_000_000_000, Memory: configuredMemory } }]), stderr: "" };
    if (args[0] === "stats") return { code: 0, stdout: JSON.stringify({ CPUPerc: "8.48%", MemUsage: "10.52GiB / 1B" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "mars/windows-job:local",
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: configuredMemory, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
  }, docker);
  const lease = await driver.createLease({
    id: "55555555-5555-4555-8555-555555555555",
    jobId: "job",
    imageDigest: "mars/windows-job:local",
    resources: { vcpu: 2, memoryBytes: configuredMemory, storageBytes: 10 * 1024 ** 3, concurrency: 1 },
    nonce: "n".repeat(32),
    encodedJitConfig: "config",
  });
  expect(await lease.sample!()).toMatchObject({ memoryLimitBytes: configuredMemory, memoryWorkingSetBytes: Math.round(10.52 * 1024 ** 3) });
  await driver.removeLease("55555555-5555-4555-8555-555555555555");
});

test("requests an idempotent graceful runner stop before forced cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-stop-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info") return { code: 0, stdout: "windows", stderr: "" };
    calls.push(args);
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ HostConfig: { Isolation: "hyperv", NanoCpus: 1_000_000_000, Memory: 1024 } }]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const driver = new WindowsContainerDriver({
    image: "mars/windows-job:local",
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1024, maxStorageBytesPerPod: 1024, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
    allowLocalImage: true,
  }, docker);
  await driver.createLease({ id: "66666666-6666-4666-8666-666666666666", jobId: "job", imageDigest: "mars/windows-job:local", resources: { vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 }, nonce: "n".repeat(32), encodedJitConfig: "config" });
  expect(await driver.requestGracefulStop("66666666-6666-4666-8666-666666666666", "out_of_memory", "memory limit exceeded")).toBe(true);
  expect(await driver.requestGracefulStop("66666666-6666-4666-8666-666666666666", "out_of_memory", "memory limit exceeded")).toBe(true);
  expect(calls.filter(args => args[0] === "exec")).toHaveLength(1);
  await driver.removeLease("66666666-6666-4666-8666-666666666666");
});
test("waits for Docker to become ready before validating the image", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-windows-docker-ready-"));
  roots.push(root);
  let infoAttempts = 0;
  const docker: DockerRunner = async (args) => {
    if (args[0] === "info" && ++infoAttempts === 1) return { code: 1, stdout: "", stderr: "cannot connect to docker_engine" };
    if (args[0] === "info") return { code: 0, stdout: "windows\n", stderr: "" };
    if (args[0] === "image") return { code: 0, stdout: JSON.stringify(["mars/windows-job@sha256:" + "a".repeat(64)]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const image = "mars/windows-job@sha256:" + "a".repeat(64);
  const driver = new WindowsContainerDriver({
    image,
    prefix: "mars",
    bootstrapRoot: root,
    limits: { maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1024, maxStorageBytesPerPod: 1024, maxConcurrentPods: 1 },
    readyTimeoutMs: 100,
    jobTimeoutMs: 100,
  }, docker);

  await driver.reserveCapacity({ vcpu: 1, memoryBytes: 1024, storageBytes: 1024, concurrency: 1 });
  expect(infoAttempts).toBe(2);
});

const collectorConfig = {
  image: "repo@sha256:" + "a".repeat(64),
  prefix: "mars",
  bootstrapRoot: "C:\\mars-test",
  limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 8 * 1024 ** 3, maxStorageBytesPerPod: 10 * 1024 ** 3, maxConcurrentPods: 4 },
  readyTimeoutMs: 100,
  jobTimeoutMs: 100,
};

test("enumerates managed containers and joins live stats with inspect metadata", async () => {
  const runningId = "a".repeat(64);
  const stoppedId = "b".repeat(64);
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "ps") return { code: 0, stdout: `${stoppedId.slice(0, 12)}\n${runningId.slice(0, 12)}\n`, stderr: "" };
    if (args[0] === "inspect") return {
      code: 0,
      stdout: JSON.stringify([
        { Id: stoppedId, Name: "/alpha", Config: { Labels: { "mars.lease-id": "22222222-2222-4222-8222-222222222222" } }, State: { Status: "exited" }, SizeRw: 4096 },
        { Id: runningId, Name: "/zeta", Config: { Labels: { "mars.lease-id": "11111111-1111-4111-8111-111111111111" } }, State: { Status: "running" }, SizeRw: 8192 },
      ]),
      stderr: "",
    };
    if (args[0] === "stats") return { code: 0, stdout: JSON.stringify({ ID: runningId.slice(0, 12), CPUPerc: "12.5%", MemUsage: "2MiB / 1GiB" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const statuses = await new WindowsContainerDriver(collectorConfig, docker).listContainerStatuses();
  expect(statuses.map(({ name }) => name)).toEqual(["alpha", "zeta"]);
  expect(statuses[0]).toMatchObject({ containerId: stoppedId, state: "exited", cpuUsagePercent: null, memoryWorkingSetBytes: null, memoryLimitBytes: null, diskUsageBytes: 4096 });
  expect(statuses[1]).toMatchObject({ containerId: runningId, state: "running", cpuUsagePercent: 12.5, memoryWorkingSetBytes: 2 * 1024 ** 2, memoryLimitBytes: 1024 ** 3, diskUsageBytes: 8192 });
  expect(new Set(statuses.map(({ sampledAt }) => sampledAt)).size).toBe(1);
  expect(calls.find((args) => args[0] === "stats")).toEqual(["stats", "--no-stream", "--format", "{{json .}}", runningId]);
});

test("retries inspect and omits only a container that disappeared", async () => {
  const firstId = "c".repeat(64);
  const secondId = "d".repeat(64);
  const disappearedId = "e".repeat(64);
  const docker: DockerRunner = async (args) => {
    if (args[0] === "ps") return { code: 0, stdout: `${firstId.slice(0, 12)}\n${secondId.slice(0, 12)}\n${disappearedId.slice(0, 12)}\n`, stderr: "" };
    if (args[0] === "inspect" && args.length > 3) return { code: 1, stdout: "", stderr: `Error: No such object: ${disappearedId.slice(0, 12)}` };
    if (args[0] === "inspect") {
      const id = args.at(-1)!;
      if (id === disappearedId.slice(0, 12)) return { code: 1, stdout: "", stderr: "Error: No such object" };
      const fullId = id === firstId.slice(0, 12) ? firstId : secondId;
      return { code: 0, stdout: JSON.stringify([{ Id: fullId, Name: `/${id}`, Config: { Labels: { "mars.lease-id": id === firstId.slice(0, 12) ? "33333333-3333-4333-8333-333333333333" : "44444444-4444-4444-8444-444444444444" } }, State: { Status: "exited" }, SizeRw: 1 }]), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const statuses = await new WindowsContainerDriver(collectorConfig, docker).listContainerStatuses();
  expect(statuses).toHaveLength(2);
  expect(statuses.map(({ containerId }) => containerId)).toEqual([firstId, secondId]);
});

test("propagates non-not-found inspect failures", async () => {
  const id = "f".repeat(64);
  let inspectCalls = 0;
  const docker: DockerRunner = async (args) => {
    if (args[0] === "ps") return { code: 0, stdout: `${id.slice(0, 12)}\n`, stderr: "" };
    if (args[0] === "inspect") {
      inspectCalls++;
      return { code: 1, stdout: "", stderr: "permission denied" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await expect(new WindowsContainerDriver(collectorConfig, docker).listContainerStatuses()).rejects.toThrow("docker inspect failed");
  expect(inspectCalls).toBe(1);
});

test("does not inspect or sample when no managed containers exist", async () => {
  const calls: string[][] = [];
  const docker: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "ps") return { code: 0, stdout: "\n", stderr: "" };
    throw new Error(`unexpected docker ${args[0]}`);
  };
  expect(await new WindowsContainerDriver(collectorConfig, docker).listContainerStatuses()).toEqual([]);
  expect(calls).toEqual([["ps", "-a", "--filter", "label=mars.managed=true", "--format", "{{.ID}}"]]);
});

test("retries stats and omits only a running container that disappeared", async () => {
  const firstId = "1".repeat(64);
  const disappearedId = "2".repeat(64);
  const docker: DockerRunner = async (args) => {
    if (args[0] === "ps") return { code: 0, stdout: `${firstId.slice(0, 12)}\n${disappearedId.slice(0, 12)}\n`, stderr: "" };
    if (args[0] === "inspect") return {
      code: 0,
      stdout: JSON.stringify([
        { Id: firstId, Name: "/first", Config: { Labels: { "mars.lease-id": "55555555-5555-4555-8555-555555555555" } }, State: { Status: "running" }, SizeRw: 10 },
        { Id: disappearedId, Name: "/gone", Config: { Labels: { "mars.lease-id": "66666666-6666-4666-8666-666666666666" } }, State: { Status: "running" }, SizeRw: 20 },
      ]),
      stderr: "",
    };
    if (args[0] === "stats" && args.length > 5) return { code: 1, stdout: "", stderr: "Error: No such object: gone" };
    if (args[0] === "stats" && args.at(-1) === disappearedId) return { code: 1, stdout: "", stderr: "Error: No such object" };
    if (args[0] === "stats") return { code: 0, stdout: JSON.stringify({ ID: firstId.slice(0, 12), CPUPerc: "1%", MemUsage: "1MiB / 1GiB" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const statuses = await new WindowsContainerDriver(collectorConfig, docker).listContainerStatuses();
  expect(statuses).toHaveLength(1);
  expect(statuses[0]).toMatchObject({ containerId: firstId, name: "first", cpuUsagePercent: 1 });
});

test("propagates non-not-found stats failures", async () => {
  const id = "3".repeat(64);
  let statsCalls = 0;
  const docker: DockerRunner = async (args) => {
    if (args[0] === "ps") return { code: 0, stdout: `${id.slice(0, 12)}\n`, stderr: "" };
    if (args[0] === "inspect") return {
      code: 0,
      stdout: JSON.stringify([{ Id: id, Name: "/running", Config: { Labels: { "mars.lease-id": "77777777-7777-4777-8777-777777777777" } }, State: { Status: "running" }, SizeRw: 1 }]),
      stderr: "",
    };
    if (args[0] === "stats") {
      statsCalls++;
      return { code: 1, stdout: "", stderr: "permission denied" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await expect(new WindowsContainerDriver(collectorConfig, docker).listContainerStatuses()).rejects.toThrow("docker stats failed");
  expect(statsCalls).toBe(1);
});

test("treats a zero Docker memory limit as unavailable", async () => {
  const id = "4".repeat(64);
  const docker: DockerRunner = async (args) => {
    if (args[0] === "ps") return { code: 0, stdout: `${id.slice(0, 12)}\n`, stderr: "" };
    if (args[0] === "inspect") return {
      code: 0,
      stdout: JSON.stringify([{ Id: id, Name: "/zero-limit", Config: { Labels: { "mars.lease-id": "88888888-8888-4888-8888-888888888888" } }, State: { Status: "running" }, SizeRw: 1 }]),
      stderr: "",
    };
    if (args[0] === "stats") return { code: 0, stdout: JSON.stringify({ ID: id.slice(0, 12), CPUPerc: "1%", MemUsage: "1MiB / 0B" }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await expect((await new WindowsContainerDriver(collectorConfig, docker).listContainerStatuses())[0]).toMatchObject({ memoryWorkingSetBytes: 1024 ** 2, memoryLimitBytes: null });
});
