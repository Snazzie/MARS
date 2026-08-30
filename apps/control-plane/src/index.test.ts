import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, configureErrorFileLogging, formatJobReconciliationReport, resolveWebhookOrigin, createDevelopmentWindowsContainerBuild, resolveDevelopmentWindowsArtifacts } from "./index.ts";

test("requires an explicit webhook origin at startup", () => {
  const previous = Bun.env.GITHUB_WEBHOOK_URL;
  delete Bun.env.GITHUB_WEBHOOK_URL;
  try {
    expect(() => resolveWebhookOrigin()).toThrow("GITHUB_WEBHOOK_URL is required");
  } finally {
    if (previous === undefined) delete Bun.env.GITHUB_WEBHOOK_URL;
    else Bun.env.GITHUB_WEBHOOK_URL = previous;
  }
});

test.each([
  "http://hooks.example.test",
  "https://localhost",
  "https://127.0.0.1",
  "https://192.168.1.20",
])("rejects non-public webhook origin %s", value => {
  expect(() => resolveWebhookOrigin(value)).toThrow(/GITHUB_WEBHOOK_URL/);
});

test("initializes the database only after ensuring it exists", async () => {
  const calls: string[] = [];
  const db = {} as never;
  const result = await initializeDatabase("postgres://user:password@db.example/mars", {
    ensureDatabase: async url => { calls.push(`ensure:${url}`); },
    createDb: url => { calls.push(`create:${url}`); return db; },
    migrateDatabase: async received => { calls.push(`migrate:${received === db}`); },
  });

  expect(result).toBe(db);
  expect(calls).toEqual([
    "ensure:postgres://user:password@db.example/mars",

    "create:postgres://user:password@db.example/mars",
    "migrate:true",
  ]);
});

test("writes console errors to the configured control-plane log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-control-plane-log-"));
  const originalError = console.error;
  try {
    const logPath = configureErrorFileLogging(directory);
    console.error("pending worker failed", new Error("capacity missing"));
    const content = await readFile(logPath, "utf8");
    expect(content).toContain("pending worker failed");
    expect(content).toContain("capacity missing");
  } finally {
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps deferred-only reconciliation quiet", () => {
  expect(formatJobReconciliationReport({ reserved: 0, deferred: 4, skipped: 0, failed: 0 })).toBeUndefined();
});

test("reports successful reservations and unexpected failures", () => {
  expect(formatJobReconciliationReport({ reserved: 2, deferred: 1, skipped: 3, failed: 0 })).toBe("Job reconciliation tick: reserved=2 deferred=1 failed=0 skipped=3");
  expect(formatJobReconciliationReport({ reserved: 0, deferred: 0, skipped: 1, failed: 1 })).toBe("Job reconciliation tick: reserved=0 deferred=0 failed=1 skipped=1");
});


test("builds development Windows image inputs from local artifacts behind control-plane routes", () => {
  const hash = "a".repeat(64);
  const build = createDevelopmentWindowsContainerBuild({
    publicOrigin: "https://control.example/path",
    artifacts: {
      container: {
        baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${"b".repeat(64)}`,
        runner: { path: "C:\\mars\\runner.zip", sha256: hash },
        git: { path: "C:\\mars\\git.zip", sha256: hash },
        vcRuntime: { path: "C:\\mars\\vc-runtime.exe", sha256: hash },
      },
    },
    buildArtifacts: {
      builderPath: "C:\\mars\\builder.ps1",
      verifierPath: "C:\\mars\\verifier.ps1",
      containerfilePath: "C:\\mars\\Containerfile",
      entrypointPath: "C:\\mars\\entrypoint.ps1",
      jobAgentPath: "C:\\mars\\job-agent.exe",
    },
  });

  expect(build).toMatchObject({
    baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${"b".repeat(64)}`,
    runnerUrl: "https://control.example/api/workers/windows-container-runner",
    runnerSha256: hash,
    gitUrl: "https://control.example/api/workers/windows-container-git",
    gitSha256: hash,
    vcUrl: "https://control.example/api/workers/windows-container-vc-runtime",
    vcSha256: hash,
  });
});

test("defaults development worker artifacts to local files and derives their SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-development-artifacts-"));
  const hash = "a".repeat(64);
  const template = join(root, "template.vhdx");
  const runner = join(root, "runner.zip");
  const git = join(root, "git.zip");
  const vcRuntime = join(root, "vc-runtime.exe");
  await Promise.all([template, runner, git, vcRuntime].map((path, index) => Bun.write(path, `artifact-${index}`)));
  try {
    const artifacts = await resolveDevelopmentWindowsArtifacts({
      NODE_ENV: "development",
      MARS_WINDOWS_TEMPLATE_PATH: template,
      MARS_WINDOWS_TEMPLATE_SHA256: hash,
      MARS_WINDOWS_CONTAINER_BASE_IMAGE: "mcr.microsoft.com/windows/server:ltsc2025",
      MARS_WINDOWS_CONTAINER_RUNNER_PATH: runner,
      MARS_WINDOWS_CONTAINER_RUNNER_SHA256: hash,
      MARS_WINDOWS_CONTAINER_GIT_PATH: git,
      MARS_WINDOWS_CONTAINER_GIT_SHA256: hash,
      MARS_WINDOWS_CONTAINER_VC_PATH: vcRuntime,
      MARS_WINDOWS_CONTAINER_VC_SHA256: hash,
    });
    const expectedOrchestratorHash = createHash("sha256").update(Buffer.from(await Bun.file(artifacts!.orchestrator.path!).arrayBuffer())).digest("hex");
    const expectedServiceHostHash = createHash("sha256").update(Buffer.from(await Bun.file(artifacts!.serviceHost.path!).arrayBuffer())).digest("hex");
    expect(artifacts?.orchestrator.sha256).toBe(expectedOrchestratorHash);
    expect(artifacts?.serviceHost.sha256).toBe(expectedServiceHostHash);
    expect(artifacts?.orchestrator.path).toBe(join(import.meta.dir, "../../orchestrator/dist/mars-orchestrator.exe"));
    expect(artifacts?.serviceHost.path).toBe(join(import.meta.dir, "../../windows-service-host/target/release/mars-service-host.exe"));
    expect(artifacts?.orchestrator.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifacts?.serviceHost.sha256).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves development worker binaries without optional template or image-build artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-development-binaries-"));
  const orchestrator = join(root, "mars-orchestrator.exe");
  const serviceHost = join(root, "mars-service-host.exe");
  try {
    await Bun.write(orchestrator, "orchestrator");
    await Bun.write(serviceHost, "service-host");

    const artifacts = await resolveDevelopmentWindowsArtifacts({
      NODE_ENV: "development",
      MARS_WINDOWS_ORCHESTRATOR_PATH: orchestrator,
      MARS_WINDOWS_SERVICE_HOST_PATH: serviceHost,
    });

    expect(artifacts).toEqual({
      orchestrator: {
        path: orchestrator,
        sha256: createHash("sha256").update("orchestrator").digest("hex"),
      },
      serviceHost: {
        path: serviceHost,
        sha256: createHash("sha256").update("service-host").digest("hex"),
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a configured artifact URL when its preferred local path is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-development-url-fallback-"));
  const hash = "a".repeat(64);
  const serviceHost = join(root, "mars-service-host.exe");
  try {
    await Bun.write(serviceHost, "service-host");

    const artifacts = await resolveDevelopmentWindowsArtifacts({
      NODE_ENV: "development",
      MARS_WINDOWS_ORCHESTRATOR_PATH: join(root, "missing-orchestrator.exe"),
      MARS_WINDOWS_ORCHESTRATOR_URL: "https://artifacts.test/mars-orchestrator.exe",
      MARS_WINDOWS_ORCHESTRATOR_SHA256: hash,
      MARS_WINDOWS_SERVICE_HOST_PATH: serviceHost,
    });

    expect(artifacts?.orchestrator).toEqual({
      url: "https://artifacts.test/mars-orchestrator.exe",
      sha256: hash,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not resolve a missing local worker artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-development-artifacts-"));
  const hash = "a".repeat(64);
  const template = join(root, "template.vhdx");
  const runner = join(root, "runner.zip");
  const git = join(root, "git.zip");
  const vcRuntime = join(root, "vc-runtime.exe");
  await Promise.all([template, runner, git, vcRuntime].map((path, index) => Bun.write(path, `artifact-${index}`)));
  try {
    const artifacts = await resolveDevelopmentWindowsArtifacts({
      NODE_ENV: "development",
      MARS_WINDOWS_ORCHESTRATOR_PATH: join(root, "missing-orchestrator.exe"),
      MARS_WINDOWS_ORCHESTRATOR_SHA256: hash,
      MARS_WINDOWS_SERVICE_HOST_PATH: join(root, "missing-service-host.exe"),
      MARS_WINDOWS_SERVICE_HOST_SHA256: hash,
      MARS_WINDOWS_TEMPLATE_PATH: template,
      MARS_WINDOWS_TEMPLATE_SHA256: hash,
      MARS_WINDOWS_CONTAINER_BASE_IMAGE: "mcr.microsoft.com/windows/server:ltsc2025",
      MARS_WINDOWS_CONTAINER_RUNNER_PATH: runner,
      MARS_WINDOWS_CONTAINER_RUNNER_SHA256: hash,
      MARS_WINDOWS_CONTAINER_GIT_PATH: git,
      MARS_WINDOWS_CONTAINER_GIT_SHA256: hash,
      MARS_WINDOWS_CONTAINER_VC_PATH: vcRuntime,
      MARS_WINDOWS_CONTAINER_VC_SHA256: hash,
    });
    expect(artifacts).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});