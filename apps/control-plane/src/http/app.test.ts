import { describe, expect, test } from "bun:test";
import { createDevelopmentWindowsArtifacts } from "../index.ts";
import { createControlPlaneApp } from "./app.ts";
import { fakeHttpDeps } from "./test-deps.ts";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const app = createControlPlaneApp(fakeHttpDeps());

  test("assembles explicit local Windows development artifacts with checksums", () => {
    const hash = "a".repeat(64);
    expect(createDevelopmentWindowsArtifacts({
      NODE_ENV: "development",
      WORKER_ORCHESTRATOR_WINDOWS_X64: "C:\\mars\\mars-orchestrator.exe",
      MARS_WINDOWS_ORCHESTRATOR_SHA256: hash,
      WORKER_SERVICE_HOST_EXECUTABLE: "C:\\mars\\mars-service-host.exe",
      MARS_WINDOWS_SERVICE_HOST_SHA256: hash,
      MARS_WINDOWS_TEMPLATE_PATH: "C:\\mars\\worker-template.vhdx",
      MARS_WINDOWS_TEMPLATE_DIGEST: `sha256:${hash}`,
      MARS_WINDOWS_CONTAINER_BASE_IMAGE: `mcr.microsoft.com/windows@sha256:${hash}`,
      MARS_WINDOWS_CONTAINER_RUNNER_PATH: "C:\\mars\\runner.zip",
      MARS_WINDOWS_CONTAINER_RUNNER_URL: "http://localhost:3000/runner.zip",
      MARS_WINDOWS_CONTAINER_RUNNER_SHA256: hash,
      MARS_WINDOWS_CONTAINER_GIT_PATH: "C:\\mars\\git.zip",
      MARS_WINDOWS_CONTAINER_GIT_URL: "http://localhost:3000/git.zip",
      MARS_WINDOWS_CONTAINER_GIT_SHA256: hash,
      MARS_WINDOWS_CONTAINER_VC_PATH: "C:\\mars\\vc.exe",
      MARS_WINDOWS_CONTAINER_VC_URL: "http://localhost:3000/vc.exe",
      MARS_WINDOWS_CONTAINER_VC_SHA256: hash,
    })).toEqual({
      orchestrator: { path: "C:\\mars\\mars-orchestrator.exe", sha256: hash },
      serviceHost: { path: "C:\\mars\\mars-service-host.exe", sha256: hash },
      container: {
        baseImage: `mcr.microsoft.com/windows@sha256:${hash}`,
        runner: { path: "C:\\mars\\runner.zip", url: "http://localhost:3000/runner.zip", sha256: hash },
        git: { path: "C:\\mars\\git.zip", url: "http://localhost:3000/git.zip", sha256: hash },
        vcRuntime: { path: "C:\\mars\\vc.exe", url: "http://localhost:3000/vc.exe", sha256: hash },
      },
    });
  });
  test.each([
    "https://github.com/Snazzie/Mars/releases/latest/download/windows-worker.vhdx",
    "https://github.com/Snazzie/Mars/releases/download/v1/windows-worker.vhdx",
  ])("omits a development artifact configured with GitHub release URL %s", (url) => {
    const hash = "a".repeat(64);
    const artifacts = createDevelopmentWindowsArtifacts({
      NODE_ENV: "development",
      WORKER_ORCHESTRATOR_WINDOWS_X64: "C:\\mars\\mars-orchestrator.exe",
      MARS_WINDOWS_ORCHESTRATOR_SHA256: hash,
      WORKER_SERVICE_HOST_EXECUTABLE: "C:\\mars\\mars-service-host.exe",
      MARS_WINDOWS_SERVICE_HOST_SHA256: hash,
      MARS_WINDOWS_TEMPLATE_URL: url,
      MARS_WINDOWS_TEMPLATE_SHA256: hash,
      MARS_WINDOWS_CONTAINER_BASE_IMAGE: `mcr.microsoft.com/windows@sha256:${hash}`,
      MARS_WINDOWS_CONTAINER_RUNNER_URL: "http://localhost:3000/runner.zip",
      MARS_WINDOWS_CONTAINER_RUNNER_SHA256: hash,
      MARS_WINDOWS_CONTAINER_GIT_URL: "http://localhost:3000/git.zip",
      MARS_WINDOWS_CONTAINER_GIT_SHA256: hash,
      MARS_WINDOWS_CONTAINER_VC_URL: "http://localhost:3000/vc.exe",
      MARS_WINDOWS_CONTAINER_VC_SHA256: hash,
    });
    expect(artifacts?.orchestrator.sha256).toBe(hash);
    expect(artifacts?.serviceHost.sha256).toBe(hash);
  });

  test("leaves development artifacts optional without release metadata", () => {
    expect(createDevelopmentWindowsArtifacts({ NODE_ENV: "development" })).toBeUndefined();
    expect(createDevelopmentWindowsArtifacts({
      NODE_ENV: "production",
      WORKER_ORCHESTRATOR_WINDOWS_X64: "C:\\mars\\mars-orchestrator.exe",
      MARS_WINDOWS_ORCHESTRATOR_SHA256: "a".repeat(64),
    })).toBeUndefined();
  });
describe("control-plane HTTP boundary", () => {
  test("serves build and discovery health only below /api", async () => {
    const response = await app.request("/api/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      buildId: "test-build",
      startedAt: "2026-08-13T00:00:00.000Z",
      discovery: {
        lastAttemptAt: "2026-08-13T00:00:30.000Z",
        lastSuccessAt: "2026-08-13T00:00:31.000Z",
        stale: false,
        staleAfterMs: 60_000,
      },
    });
    expect((await app.request("/healthz")).status).toBe(404);
  });
  test("returns ordered approved worker connection origins to global admins", async () => {
    const member = { id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true };
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => member,
      workerConnectionOrigins: () => ["https://control.example", "https://adapter.example"],
    })).request("/api/workers/control-plane-urls");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["https://control.example", "https://adapter.example"]);
  });

  test("exposes the synchronized public origin and managed flag in onboarding status", async () => {
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ").toLowerCase();
      if (query.includes("from system_onboarding")) return [{ adminUserId: null, workerId: null, organizationId: null, completedAt: null, publicBaseUrl: "https://control.example.com", originConfigured: true, githubAppConfigured: false }];
      return [];
    }) as never;
    const response = await createControlPlaneApp(fakeHttpDeps({
      db,
      setup: { publicOrigin: () => "https://control.example.com", publicOriginManaged: () => true, configure: async origin => origin, authenticate: async () => ({ userId: "admin", firstAdmin: true }) },
    })).request("/api/onboarding/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ publicBaseUrl: "https://control.example.com", publicBaseUrlManaged: true, step: "setup" });
  });
  test("returns the authenticated operator for the dashboard session probe", async () => {
    const member = { id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true };
    const response = await createControlPlaneApp(fakeHttpDeps({ currentUser: async () => member })).request("/api/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(member);
  });
  test("reports stale discovery as unhealthy", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      health: () => ({
        buildId: "test-build",
        startedAt: "2026-08-13T00:00:00.000Z",
        discovery: {
          lastAttemptAt: "2026-08-13T00:01:00.000Z",
          lastSuccessAt: "2026-08-13T00:00:00.000Z",
          stale: true,
          staleAfterMs: 60_000,
        },
      }),
    })).request("/api/healthz");

    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
  });

  test("never serves the SPA for an unknown API route", async () => {
    const response = await app.request("/api/not-a-route");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
  test("protects bootstrap rotation behind global-admin authentication", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/workers/bootstrap/rotate", { method: "POST", headers: { "Idempotency-Key": "test" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).not.toBe("public");
  });
  test("registers bootstrap initialization behind global-admin authentication", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/workers/bootstrap/initialize", { method: "POST", headers: { "Idempotency-Key": "test" } });
    expect(response.status).toBe(401);
  });
  test("requires a configured worker connection origin for installers", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/workers/installer?audience=linux-x64");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_worker_origin", message: "Choose a configured worker connection origin" });
  });
  test("injects the selected adapter origin into the Linux installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-installers-"));
    try {
      await Bun.write(join(root, "install-worker.sh"), '#!/usr/bin/env bash\n: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"\n');
      await Bun.write(join(root, "linux-broker-compose.yaml"), "compose");
      await Bun.write(join(root, "worker-domain.xml"), "domain");
      const response = await createControlPlaneApp(fakeHttpDeps({
        baseUrl: "https://control.test",
        workerInstallerRoot: pathToFileURL(`${root}/`),
        workerConnectionOrigins: () => ["https://control.test", "https://worker.test"],
      })).request("/api/workers/installer?audience=linux-x64&connectOrigin=https%3A%2F%2Fworker.test");
      const installer = await response.text();

      expect(response.status).toBe(200);
      expect(installer).toContain("PUBLIC_BASE_URL='https://worker.test'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("rejects an unconfigured worker connection origin", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      workerConnectionOrigins: () => ["https://control.test"],
    })).request("/api/workers/installer?audience=linux-x64&connectOrigin=https%3A%2F%2Fevil.test");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid_worker_origin", message: "Choose a configured worker connection origin" });
  });
  test("injects the control-plane origin into the Linux installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-installers-"));
    try {
      await Bun.write(join(root, "install-worker.sh"), '#!/usr/bin/env bash\n: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}"\n');
      await Bun.write(join(root, "linux-broker-compose.yaml"), "compose");
      await Bun.write(join(root, "worker-domain.xml"), "domain");
      const response = await createControlPlaneApp(fakeHttpDeps({
        baseUrl: "http://localhost:3000",
        browserBaseUrl: "http://localhost:5173",
        workerInstallerRoot: pathToFileURL(`${root}/`),
      })).request("/api/workers/installer?audience=linux-x64&connectOrigin=http%3A%2F%2Flocalhost%3A3000");
      const installer = await response.text();

      expect(response.status).toBe(200);
      expect(installer).toStartWith("#!/usr/bin/env bash\n");
      expect(installer).toContain("PUBLIC_BASE_URL='http://localhost:3000'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("rejects a Windows installer when schema-3 container inputs are incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-windows-installers-"));
    try {
      await Bun.write(join(root, "install-worker.ps1"), "[CmdletBinding()]\r\nparam()\r\n");
      await Bun.write(join(root, "windows-orchestrator"), "orchestrator");
      await Bun.write(join(root, "service-host.exe"), "service-host");
      const deps = { baseUrl: "https://control.test", workerReleaseManifest: undefined, workerInstallerRoot: pathToFileURL(`${root}/`), windowsContainerBuild: undefined, windowsContainerArtifacts: undefined, workerOrchestratorExecutables: { "windows-x64": pathToFileURL(join(root, "windows-orchestrator")) }, workerServiceHostExecutable: pathToFileURL(join(root, "service-host.exe")) };
      const response = await createControlPlaneApp(fakeHttpDeps(deps)).request("/api/workers/installer?audience=windows-x64&runtime=container&connectOrigin=https%3A%2F%2Fcontrol.test");
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("artifact_unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("rejects incomplete local Windows schema-3 artifacts without release fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-local-windows-installers-"));
    try {
      await Bun.write(join(root, "install-worker.ps1"), "[CmdletBinding()]\r\nparam()\r\n");
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerInstallerRoot: pathToFileURL(`${root}/`),
        workerReleaseManifest: undefined,
        developmentWindowsArtifacts: {
          orchestrator: { path: join(root, "orchestrator.exe"), sha256: "b".repeat(64) },
          serviceHost: { path: join(root, "service-host.exe"), sha256: "b".repeat(64) },
        },
      })).request("/api/workers/installer?audience=windows-x64&connectOrigin=https%3A%2F%2Fcontrol-plane.test");
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("artifact_unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serves a local Windows upgrade installer without container artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-local-windows-upgrades-"));
    try {
      const orchestrator = join(root, "mars-orchestrator.exe");
      const serviceHost = join(root, "mars-service-host.exe");
      await Bun.write(join(root, "install-worker.ps1"), "[CmdletBinding()]\r\nparam()\r\n");
      await Bun.write(orchestrator, "local-orchestrator");
      await Bun.write(serviceHost, "local-service-host");
      const response = await createControlPlaneApp(fakeHttpDeps({
        baseUrl: "http://localhost:3000",
        workerReleaseManifest: undefined,
        workerInstallerRoot: pathToFileURL(`${root}/`),
        developmentWindowsArtifacts: {
          orchestrator: { path: orchestrator, sha256: "0".repeat(64) },
          serviceHost: { path: serviceHost, sha256: "0".repeat(64) },
        },
      })).request("/api/workers/installer?audience=windows-x64&runtime=container&upgrade=true&connectOrigin=http://localhost:3000");
      const installer = await response.text();

      expect(response.status).toBe(200);
      expect(installer).toContain("$WindowsArtifactMode = 'local'");
      expect(installer).toContain("$WindowsOrchestratorUrl = 'http://localhost:3000/api/workers/orchestrator?audience=windows-x64'");
      expect(installer).toContain(`$WindowsOrchestratorSha256 = '${createHash("sha256").update("local-orchestrator").digest("hex")}'`);
      expect(installer).toContain("$WindowsServiceHostUrl = 'http://localhost:3000/api/workers/service-host?audience=windows-x64'");
      expect(installer).toContain(`$WindowsServiceHostSha256 = '${createHash("sha256").update("local-service-host").digest("hex")}'`);
      expect(installer).toContain("$Upgrade = 'true'");
      expect(installer).not.toContain("WindowsContainer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("keeps requiring container artifacts for a fresh local Windows installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-local-windows-fresh-"));
    try {
      await Bun.write(join(root, "install-worker.ps1"), "[CmdletBinding()]\r\nparam()\r\n");
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerReleaseManifest: undefined,
        workerInstallerRoot: pathToFileURL(`${root}/`),
        developmentWindowsArtifacts: {
          orchestrator: { path: join(root, "orchestrator.exe"), sha256: "0".repeat(64) },
          serviceHost: { path: join(root, "service-host.exe"), sha256: "0".repeat(64) },
        },
      })).request("/api/workers/installer?audience=windows-x64&runtime=container&connectOrigin=https://control-plane.test");

      expect(response.status).toBe(503);
      expect((await response.json()).artifacts).toContain("development:container");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serves configured local Windows artifacts with declared hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-local-windows-artifacts-"));
    try {
      const paths = {
        orchestrator: join(root, "mars-orchestrator.exe"),
        serviceHost: join(root, "mars-service-host.exe"),
        runner: join(root, "runner.zip"),
        git: join(root, "git.zip"),
        vcRuntime: join(root, "vc-runtime.exe"),
      };
      const contents = { orchestrator: "local-orchestrator", serviceHost: "local-service-host", runner: "local-runner", git: "local-git", vcRuntime: "local-vc-runtime" };
      await Promise.all(Object.entries(paths).map(([name, path]) => Bun.write(path, contents[name as keyof typeof contents])));
      const responseCases = [
        ["/api/workers/orchestrator?audience=windows-x64", contents.orchestrator, "mars-orchestrator.exe"],
        ["/api/workers/service-host?audience=windows-x64", contents.serviceHost, "mars-service-host.exe"],
        ["/api/workers/windows-container-runner", contents.runner, "runner.zip"],
        ["/api/workers/windows-container-git", contents.git, "git.zip"],
        ["/api/workers/windows-container-vc-runtime", contents.vcRuntime, "vc-runtime.exe"],
      ] as const;
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerReleaseManifest: undefined,
        developmentWindowsArtifacts: {
          orchestrator: { path: paths.orchestrator, sha256: createHash("sha256").update(contents.orchestrator).digest("hex") },
          serviceHost: { path: paths.serviceHost, sha256: createHash("sha256").update(contents.serviceHost).digest("hex") },
          container: {
            baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${"c".repeat(64)}`,
            runner: { path: paths.runner, sha256: createHash("sha256").update(contents.runner).digest("hex") },
            git: { path: paths.git, sha256: createHash("sha256").update(contents.git).digest("hex") },
            vcRuntime: { path: paths.vcRuntime, sha256: createHash("sha256").update(contents.vcRuntime).digest("hex") },
          },
        },
      }));
      for (const [route, content, filename] of responseCases) {
        const artifact = await response.request(route);
        expect(artifact.status).toBe(200);
        expect(await artifact.text()).toBe(content);
        expect(artifact.headers.get("cache-control")).toBe("no-store");
        expect(artifact.headers.get("X-Content-SHA256")).toBe(createHash("sha256").update(content).digest("hex"));
        expect(artifact.headers.get("content-disposition")).toContain(`filename="${filename}"`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("proxies configured local Windows artifact URLs through control plane routes", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("proxied-runner", { headers: { "content-type": "application/zip" } }) });
    const hash = createHash("sha256").update("proxied-runner").digest("hex");
    try {
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerReleaseManifest: undefined,
        developmentWindowsArtifacts: {
          orchestrator: { url: `http://127.0.0.1:${upstream.port}/orchestrator.exe`, sha256: hash },
          serviceHost: { url: `http://127.0.0.1:${upstream.port}/service-host.exe`, sha256: hash },
          container: {
            baseImage: `mcr.microsoft.com/windows@sha256:${hash}`,
            runner: { url: `http://127.0.0.1:${upstream.port}/runner.zip`, sha256: hash },
            git: { url: `http://127.0.0.1:${upstream.port}/git.zip`, sha256: hash },
            vcRuntime: { url: `http://127.0.0.1:${upstream.port}/vc-runtime.exe`, sha256: hash },
          },
        },
      })).request("/api/workers/windows-container-runner");

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("proxied-runner");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("X-Content-SHA256")).toBe(hash);
      expect(response.headers.get("content-disposition")).toContain('filename="runner.zip"');
    } finally {
      upstream.stop();
    }
  });


  test("reports unavailable local Windows artifacts without release fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-missing-local-windows-artifacts-"));
    const hash = "d".repeat(64);
    try {
      const orchestrator = join(root, "mars-orchestrator.exe");
      await Bun.write(orchestrator, "release-must-not-be-served");
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerOrchestratorExecutables: { "windows-x64": pathToFileURL(orchestrator) },
        developmentWindowsArtifacts: {
          orchestrator: { path: join(root, "missing-orchestrator.exe"), sha256: hash },
          serviceHost: { path: join(root, "missing-service-host.exe"), sha256: hash },
          container: {
            baseImage: `mcr.microsoft.com/windows@sha256:${hash}`,
            runner: { path: join(root, "missing-runner.zip"), sha256: hash },
            git: { path: join(root, "missing-git.zip"), sha256: hash },
            vcRuntime: { path: join(root, "missing-vc-runtime.exe"), sha256: hash },
          },
        },
      })).request("/api/workers/orchestrator?audience=windows-x64");

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "artifact_unavailable",
        message: "Worker installer prerequisites are unavailable",
        artifacts: ["development:orchestrator"],
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects Windows VM installer requests in v1", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/workers/installer?audience=windows-x64&runtime=vm&connectOrigin=https%3A%2F%2Fcontrol-plane.test");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "unsupported_runtime", message: "Only the container runtime is supported in worker v1" });
  });
  test("injects split Tart runtime identity into the macOS installer", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-macos-installers-"));
    try {
      await Bun.write(join(root, "macos-orchestrator"), "orchestrator");
      await Bun.write(join(root, "install-worker-macos.sh"), "#!/bin/zsh\nprint ready\n");
      const response = await createControlPlaneApp(fakeHttpDeps({
        baseUrl: "http://localhost:3000",
        workerInstallerRoot: pathToFileURL(`${root}/`),
        workerOrchestratorExecutable: pathToFileURL(join(root, "macos-orchestrator")),
      })).request("/api/workers/installer?audience=macos-arm64&connectOrigin=http%3A%2F%2Flocalhost%3A3000");
      const installer = await response.text();
      expect(response.status).toBe(200);
      expect(installer).toContain(`TART_IMAGE='ghcr.io/cirruslabs/macos-sonoma-base@sha256:${"a".repeat(64)}'`);
      expect(installer).toContain(`MARS_ORCHESTRATOR_SHA256='${"a".repeat(64)}'`);
      expect(installer).toContain(`TART_IMAGE_DIGEST='${"a".repeat(64)}'`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serves the configured macOS orchestrator executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-orchestrator-"));
    try {
      const executable = join(root, "mars-orchestrator");
      await Bun.write(executable, "macos-arm64-binary");
      const hash = createHash("sha256").update("macos-arm64-binary").digest("hex");
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerOrchestratorExecutable: pathToFileURL(executable),
        workerReleaseManifest: {
          schemaVersion: 3,
          buildId: "macos-test",
          contractVersion: "0.1.0",
          platforms: {
            "linux-x64": null,
            "windows-x64": null,
            "macos-arm64": {
              installer: { url: "https://release.test/macos-installer.sh", sha256: hash },
              orchestrator: { url: "https://release.test/macos-orchestrator", sha256: hash },
              jobAgent: { url: "https://release.test/macos-job-agent", sha256: hash },
              imagePreparationScript: { url: "https://release.test/prepare-macos-job-image.sh", sha256: hash },
              tartSourceImage: `ghcr.io/cirruslabs/macos-sonoma-base@sha256:${"a".repeat(64)}`,
            },
          },
        },
      })).request("/api/workers/orchestrator?audience=macos-arm64");

      expect(response.status).toBe(503);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("serves the configured Windows service host executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-service-host-"));
    try {
      const executable = join(root, "mars-service-host.exe");
      await Bun.write(executable, "windows-service-host-binary");
      const response = await createControlPlaneApp(fakeHttpDeps({
        workerServiceHostExecutable: pathToFileURL(executable),
      })).request("/api/workers/service-host?audience=windows-x64");
      expect(response.status).toBe(503);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("reports a missing Windows service host artifact", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      workerServiceHostExecutable: pathToFileURL(join(tmpdir(), crypto.randomUUID(), "missing.exe")),
    })).request("/api/workers/service-host?audience=windows-x64");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test("sets Content-Length for large Windows job-agent downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-windows-job-agent-"));
    try {
      const payload = "windows-container-job-agent-fixture";
      const jobAgentPath = join(root, "mars-job-agent.exe");
      await Bun.write(jobAgentPath, payload);
      const response = await createControlPlaneApp(fakeHttpDeps({
        windowsContainerArtifacts: {
          builderPath: jobAgentPath,
          verifierPath: jobAgentPath,
          containerfilePath: jobAgentPath,
          entrypointPath: jobAgentPath,
          jobAgentPath,
        },
      })).request("/api/workers/windows-container-job-agent");

      expect(response.status).toBe(503);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("redirects browser OAuth starts to onboarding when setup origin is unavailable", async () => {
    const defaults = fakeHttpDeps();
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      setup: { ...defaults.setup, publicOrigin: () => null },
    })).request("/api/auth/github", { headers: { Accept: "text/html" } });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/onboarding");
  });
  test("redirects browser OAuth starts to onboarding when OAuth credentials are unavailable", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      githubApp: undefined,
    })).request("/api/auth/github", { headers: { Accept: "text/html" } });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/onboarding");
  });

  test("keeps setup-required JSON for API OAuth starts", async () => {
    const defaults = fakeHttpDeps();
    const depsList = [
      fakeHttpDeps({ setup: { ...defaults.setup, publicOrigin: () => null } }),
      fakeHttpDeps({ githubApp: undefined }),
    ];
    for (const deps of depsList) {
      const response = await createControlPlaneApp(deps).request("/api/auth/github", {
        headers: { Accept: "application/json" },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "setup_required", message: "Complete first-run setup" });
    }
  });





  test("preserves the dashboard return path when refreshing GitHub organizations", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({ baseUrl: "http://localhost:3000" })).request("/api/auth/github?returnTo=%2Frepositories");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("oauth_return_to=%2Frepositories");
  });
  test("does not persist unsafe OAuth return paths", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({ baseUrl: "http://localhost:3000" })).request("/api/auth/github?returnTo=%2F%5Cevil.com");
    expect(response.headers.get("set-cookie")).not.toContain("oauth_return_to=");
  });
  test("uses the public callback and browser origin for OAuth returns", async () => {
    const secretBox = fakeHttpDeps().secretBox;
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("update github_setup_states")) return [{ encrypted_pkce_verifier: secretBox.encrypt("verifier") }];
      if (query.includes("insert into users")) return [{ id: "user-1", is_global_admin: true }];
      if (query.includes("insert into organizations")) return [{ id: "personal-org" }];
      if (query.includes("SELECT completed_at FROM system_onboarding")) return [{ completed_at: null }];
      return [];
    }) as unknown as ReturnType<typeof fakeHttpDeps>["db"];
    Object.assign(sql, { begin: async (callback: (transaction: typeof sql) => Promise<unknown>) => callback(sql) });
    const deps = fakeHttpDeps({
      db: sql,
      baseUrl: "http://localhost:3000",
      browserBaseUrl: "http://localhost:5173",
    });
    const oauthStart = await createControlPlaneApp(deps).request("/api/auth/github");
    expect(new URL(oauthStart.headers.get("location") ?? "").searchParams.get("redirect_uri"))
      .toBe("http://localhost:3000/api/auth/github/callback");

    const previousFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) return Response.json({ access_token: "github-token" });
      if (url.includes("/user/orgs")) return Response.json([]);
      if (url.endsWith("/user")) return Response.json({ id: 7, login: "bootstrap" });
      return new Response(null, { status: 404 });
    }, { preconnect: previousFetch.preconnect });
    try {
      const callback = await createControlPlaneApp(deps).request("/api/auth/github/callback?state=state&code=code", {
        headers: { Cookie: "oauth_state=state" },
      });
      expect(callback.headers.get("location")).toBe("http://localhost:5173/onboarding");
      expect(callback.headers.get("set-cookie")).toContain("mars_session=");

      const repositoryCallback = await createControlPlaneApp(deps).request("/api/auth/github/callback?state=state&code=code", {
        headers: { Cookie: "oauth_state=state; oauth_return_to=%2Frepositories" },
      });
      expect(repositoryCallback.headers.get("location")).toBe("http://localhost:5173/repositories");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });


  test("serves run list and detail deep links", async () => {
    expect((await app.request("/runs")).status).toBe(200);
    expect((await app.request("/runs/123")).status).toBe(200);
  });

  test("serves all dashboard and onboarding client routes", async () => {
    for (const path of ["/settings", "/workers", "/pools", "/repositories", "/runs", "/onboarding"]) {
      expect((await app.request(path)).status).toBe(200);
    }
  });
});
  test("requires authentication for GitHub App manifest launch", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/github/app/manifest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(401);
  });

  test("launches GitHub App manifest for a global admin", async () => {
    const calls: Array<{ userId: string; organizationId: string; idempotencyKey: string }> = [];
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 7, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        createManifestLaunch: async (userId: string, organizationId: string, idempotencyKey: string) => {
          calls.push({ userId, organizationId, idempotencyKey });
          return { action: "https://github.com/settings/apps/new?state=test", manifest: "{\"name\":\"mars\"}" };
        },
      } as never,
    })).request("/api/github/app/manifest", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "manifest-test" },
      body: JSON.stringify({ organizationId: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "https://github.com/settings/apps/new?state=test", manifest: "{\"name\":\"mars\"}" });
    expect(calls).toEqual([{ userId: "admin", organizationId: "11111111-1111-4111-8111-111111111111", idempotencyKey: "manifest-test" }]);
  });
  test("rejects malformed setup origins before launching a manifest", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      setup: {
        ...fakeHttpDeps().setup,
        configure: async () => { throw new Error("PUBLIC_BASE_URL must be an absolute HTTP(S) origin"); },
      },
      githubApp: { createManifestLaunch: async () => ({ action: "unused", manifest: "{}" }) } as never,
    })).request("/api/setup/github-app", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "setup-test" },
      body: JSON.stringify({ publicBaseUrl: "ftp://unsafe.example" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_origin" });
  });

  test("maps a completed setup race to setup_state_expired", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      setup: {
        ...fakeHttpDeps().setup,
        configure: async () => { throw new Error("setup_state_expired"); },
      },
      githubApp: { createManifestLaunch: async () => ({ action: "unused", manifest: "{}" }) } as never,
    })).request("/api/setup/github-app", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "setup-race" },
      body: JSON.stringify({ publicBaseUrl: "https://control-plane.test" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "setup_state_expired" });
  });

  test("maps an environment-managed origin mismatch to a bad request", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      setup: {
        ...fakeHttpDeps().setup,
        configure: async () => { throw new Error("configured_origin_mismatch"); },
      },
      githubApp: { createManifestLaunch: async () => ({ action: "unused", manifest: "{}" }) } as never,
    })).request("/api/setup/github-app", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "setup-mismatch" },
      body: JSON.stringify({ publicBaseUrl: "https://other.example" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "configured_origin_mismatch" });
  });

  test("requires an idempotency key for GitHub App installation launch", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps()).request("/api/github/app/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(401);
  });
  test("starts an unbound GitHub installation from onboarding", async () => {
    let requestedUser = "";
    let requestedKey = "";
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        beginUnboundInstallation: async (userId: string, key: string) => {
          requestedUser = userId;
          requestedKey = key;
          return { location: "https://github.com/apps/mars/installations/new", installCookie: "state-cookie" };
        },
      } as never,
    })).request("/api/onboarding/github/install", {
      method: "POST",
      headers: { "Idempotency-Key": "unbound-install" },
    });
    expect(response.status).toBe(200);
    expect(requestedUser).toBe("admin");
    expect(requestedKey).toBe("unbound-install");
    expect(await response.json()).toEqual({ location: "https://github.com/apps/mars/installations/new" });
    expect(response.headers.get("set-cookie")).toContain("github_install_state=state-cookie");
  });

  test("protects unbound GitHub installation launch", async () => {
    const missingAuth = await createControlPlaneApp(fakeHttpDeps()).request("/api/onboarding/github/install", { method: "POST", headers: { "Idempotency-Key": "key" } });
    expect(missingAuth.status).toBe(401);
    const forbidden = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "member", githubUserId: 2, login: "member", isGlobalAdmin: false }),
    })).request("/api/onboarding/github/install", { method: "POST", headers: { "Idempotency-Key": "key" } });
    expect(forbidden.status).toBe(403);
    const missingKey = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    })).request("/api/onboarding/github/install", { method: "POST" });
    expect(missingKey.status).toBe(400);

    const unavailable = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: undefined,
    })).request("/api/onboarding/github/install", { method: "POST", headers: { "Idempotency-Key": "key" } });
    expect(unavailable.status).toBe(503);
  });
  test("preserves the install cookie when a bound callback rejects the GitHub account", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => { throw new Error("wrong_organization"); } } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=bound-state" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "wrong_organization" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });


  test("rejects GitHub setup callbacks for missing or replayed install state", async () => {
    const first = await createControlPlaneApp(fakeHttpDeps()).request(
      "/api/github/app/setup?installation_id=42&setup_action=install",
    );
    const replay = await createControlPlaneApp(fakeHttpDeps()).request(
      "/api/github/app/setup?installation_id=42&setup_action=install",
      { headers: { cookie: "github_install_state=consumed" } },
    );
    expect(first.status).toBe(401);
    expect(replay.status).toBe(401);
  });
  test("maps replayed GitHub setup callbacks to a conflict response", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => { throw new Error("setup_state_expired"); } } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=expired" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "setup_state_expired" });
  });
  test("returns completed GitHub setup to the browser onboarding origin", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => true } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=onboarding" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/onboarding");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  test("returns repository selection failures to resumable onboarding", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => { throw new Error("repository_selection_required"); } } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=selected" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/onboarding?github=repository-selection-required");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  test("returns dashboard after a non-onboarding organization install", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({
      browserBaseUrl: "http://localhost:5173",
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: { completeInstallation: async () => false } as never,
    })).request("/api/github/app/setup?installation_id=42&setup_action=install", {
      headers: { Cookie: "github_install_state=organization-install" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:5173/");
  });
test("repository GitHub removal route requires an existing installation", async () => {
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/repositories/repo-1/github/settings");
  expect(response.status).toBe(404);
});

test("organization GitHub uninstall route requires an existing installation", async () => {
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/github/settings");
  expect(response.status).toBe(404);
});
test("returns the organization GitHub settings URL", async () => {
  const db = ((strings: TemplateStringsArray) => strings.join("?").includes("dashboard_installations") ? [{ login: "acme", githubInstallationId: 42 }] : []) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/github/settings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ location: "https://github.com/organizations/acme/settings/installations/42" });
});

test("returns the repository GitHub settings URL", async () => {
  const db = ((strings: TemplateStringsArray) => strings.join("?").includes("dashboard_repositories") ? [{ login: "acme", githubInstallationId: 42 }] : []) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/repositories/repo-1/github/settings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ location: "https://github.com/organizations/acme/settings/installations/42" });
});

test("returns the user-account GitHub settings URL", async () => {
  const db = ((strings: TemplateStringsArray) => strings.join("?").includes("dashboard_installations")
    ? [{ login: "Snazzie", githubInstallationId: 153311365, githubAccountType: "User" }]
    : []) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/github/settings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ location: "https://github.com/settings/installations/153311365" });
});

test("does not return GitHub settings for unavailable repositories", async () => {
  const db = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (!query.includes("dashboard_repositories")) return [];
    return query.includes("r.available=true") && query.includes("i.state <> 'suspended'")
      ? []
      : [{ login: "acme", githubInstallationId: 42, available: false, state: "suspended" }];
  }) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request("/api/organizations/org-1/repositories/repo-1/github/settings");
  expect(response.status).toBe(404);
});
test("uninstalls an organization through the authenticated GitHub route", async () => {
  let organization = "";
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    githubApp: { uninstallOrganization: async (organizationId: string) => { organization = organizationId; } } as never,
  })).request("/api/organizations/org-2/github/uninstall", {
    method: "POST",
    headers: { "Idempotency-Key": "uninstall-1" },
  });
  expect(response.status).toBe(200);
  expect(organization).toBe("org-2");
  expect(await response.json()).toEqual({ ok: true });
});


  test("webhook validation uses the configured app secret and never accepts a static fallback", async () => {
    const response = await createControlPlaneApp(fakeHttpDeps({ githubWebhookSecret: "database-secret" })).request(
      "/api/github/webhooks",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "installation",
          "x-hub-signature-256": "sha256=not-valid",
          "x-github-delivery": "delivery-1",
        },
        body: JSON.stringify({ action: "suspend", installation: { id: 7 } }),
      },
    );
    expect(response.status).toBe(401);
  });

  test("repository approval endpoints are retired", async () => {
    const retired = createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    }));
    for (const action of ["approve", "reject"]) {
      const response = await retired.request(`/api/organizations/org-1/repositories/repo-1/${action}`, {
        method: "POST",
        headers: { "Idempotency-Key": `repository-${action}` },
      });
      expect(response.status).toBe(404);
    }
  });

  test("repository workflow listing uses scoped availability and stable missing-repository errors", async () => {
    let listed: unknown;
    const success = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        listRepositoryRunnerWorkflows: async (input: unknown) => {
          listed = input;
          return { defaultBranch: "main", files: [] };
        },
      } as never,
    })).request("/api/organizations/org-1/repositories/repo-1/runner-workflows");
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual([]);
    expect(listed).toEqual({ organizationId: "org-1", repositoryId: "repo-1" });

    const unavailable = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        listRepositoryRunnerWorkflows: async () => { throw new Error("github_repository_unavailable"); },
      } as never,
    })).request("/api/organizations/org-1/repositories/repo-1/runner-workflows");
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toMatchObject({ code: "repository_unavailable" });

    const missingPermissions = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        listRepositoryRunnerWorkflows: async () => { throw new Error("github_403"); },
      } as never,
    })).request("/api/organizations/org-1/repositories/repo-1/runner-workflows");
    expect(missingPermissions.status).toBe(409);
    expect(await missingPermissions.json()).toMatchObject({
      code: "github_app_permissions_missing",
      message: "GitHub App needs Contents and Pull requests write permissions. Update and approve the app permissions, then refresh.",
    });
  });

test("rejects partial focused workflow selections before mutation idempotency", async () => {
  const app = createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    githubApp: {
      previewRepositoryRunnerPr: async () => { throw new Error("must not call GitHub"); },
      createRepositoryRunnerPr: async () => { throw new Error("must not call GitHub"); },
    } as never,
  }));
  const preview = await app.request("/api/organizations/org-1/repositories/repo-1/runner-workflows/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selectedPath: ".github/workflows/ci.yml", labels: ["4VCPU"] }),
  });
  expect(preview.status).toBe(422);
  expect(await preview.json()).toMatchObject({ code: "workflow_invalid" });
  const pr = await app.request("/api/organizations/org-1/repositories/repo-1/runner-workflows/pr", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "partial-focused" },
    body: JSON.stringify({ selectedPath: ".github/workflows/ci.yml", expectedHeadSha: "abcdef1", labels: ["4VCPU"] }),
  });
  expect(pr.status).toBe(422);
  expect(await pr.json()).toMatchObject({ code: "workflow_invalid" });
});

test("returns scoped timing label recommendations and unavailable history", async () => {
  const recommendation = {
    currentLabels: ["mars-windows-x64", "4VCPU", "8G"],
    successfulRunCount: "8",
    coveredRunCount: "8",
    p95CpuPeakPercent: "201",
    p95MemoryPeakBytes: "5368709120",
  };
  const makeDb = (row: unknown) => Object.assign((() => []) as unknown as (...args: never[]) => unknown, {
    unsafe: async () => [row],
  }) as never;
  const query = "?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z&repositoryId=11111111-1111-4111-8111-111111111111&workflowName=CI&jobName=build";
  const available = await createControlPlaneApp(fakeHttpDeps({
    db: makeDb(recommendation),
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request(`/api/organizations/org-1/job-timings/label-recommendation${query}`);
  expect(available.status).toBe(200);
  expect(await available.json()).toMatchObject({
    status: "available",
    currentWindowsLabel: "mars-windows-x64",
    recommendedVcpu: 3,
    recommendedMemoryGiB: 7,
  });

  const unavailable = await createControlPlaneApp(fakeHttpDeps({
    db: makeDb({ successfulRunCount: "2", coveredRunCount: "2" }),
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
  })).request(`/api/organizations/org-1/job-timings/label-recommendation${query}`);
  expect(unavailable.status).toBe(200);
  expect(await unavailable.json()).toMatchObject({ status: "unavailable", reason: "insufficient_history" });
});

test("resolves YAML workflow metadata for timing recommendations", async () => {
  const db = Object.assign((() => []) as unknown as (...args: never[]) => unknown, {
    unsafe: async () => [{
      currentLabels: ["mars-windows-x64", "8VCPU", "16G"],
      successfulRunCount: "8",
      coveredRunCount: "8",
      p95CpuPeakPercent: "201",
      p95MemoryPeakBytes: "5368709120",
    }],
  }) as never;
  const response = await createControlPlaneApp(fakeHttpDeps({
    db,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    githubApp: {
      resolveWorkflowJob: async () => ({
        path: ".github/workflows/ci.yml",
        jobId: "build",
        currentRunsOn: ["self-hosted", "mars-windows-x64", "custom", "8VCPU", "16G"],
      }),
    } as never,
  })).request("/api/organizations/org-1/job-timings/label-recommendation?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z&repositoryId=11111111-1111-4111-8111-111111111111&workflowName=CI&jobName=build");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    workflowPath: ".github/workflows/ci.yml",
    workflowJobId: "build",
    currentLabels: ["self-hosted", "mars-windows-x64", "custom", "8VCPU", "16G"],
  });
});


test("rejects focused label conflicts as workflow-invalid requests", async () => {
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    githubApp: {
      previewRepositoryRunnerPr: async () => { throw new Error("Focused workflow labels contain foreign or conflicting labels"); },
    } as never,
  })).request("/api/organizations/org-1/repositories/repo-1/runner-workflows/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      selectedPath: ".github/workflows/ci.yml",
      selectedJobId: "build",
      labels: ["mars-windows-x64", "4VCPU", "8G", "foreign"],
    }),
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "workflow_invalid" });
});
  test("refreshes repositories from an existing GitHub installation", async () => {
    let refreshedOrganization = "";
    const response = await createControlPlaneApp(fakeHttpDeps({
      currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
      githubApp: {
        refreshInstallationRepositories: async (organizationId: string) => { refreshedOrganization = organizationId; },
      } as never,
    })).request("/api/organizations/org-1/github/refresh", {
      method: "POST",
      headers: { "Idempotency-Key": "github-refresh-1" },
    });

    expect(response.status).toBe(200);
    expect(refreshedOrganization).toBe("org-1");
    expect(await response.json()).toEqual({ ok: true });
  });
test("starts GitHub installation for a non-onboarding organization", async () => {
  let requestedOrganization = "";
  const response = await createControlPlaneApp(fakeHttpDeps({
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    githubApp: {
      beginOrganizationInstallation: async (_userId: string, organizationId: string) => {
        requestedOrganization = organizationId;
        return { location: "https://github.com/apps/mars/installations/new" };
      },
    } as never,
  })).request("/api/organizations/org-2/github/install", {
    method: "POST",
    headers: { "Idempotency-Key": "org-2-install", "content-type": "application/json" },
  });

  expect(response.status).toBe(200);
  expect(requestedOrganization).toBe("org-2");
  expect(await response.json()).toEqual({ location: "https://github.com/apps/mars/installations/new" });
});
test("generates complete platform installers from the immutable release manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-release-installers-"));
  const hash = "a".repeat(64);
  try {
    for (const file of ["install-worker.sh", "install-worker.ps1", "install-worker-macos.sh", "linux-broker-compose.yaml", "worker-domain.xml"]) {
      await Bun.write(join(root, file), file.endsWith(".ps1") ? "'__PUBLIC_BASE_URL__' '__WINDOWS_RUNTIME__' '__WINDOWS_CONTAINER_BASE_IMAGE__' '__WINDOWS_CONTAINER_RUNNER_URL__' '__WINDOWS_CONTAINER_RUNNER_SHA256__' '__WINDOWS_TEMPLATE_PATH__' '__WINDOWS_TEMPLATE_DIGEST__'" : "#!/bin/sh\n$PUBLIC_BASE_URL");
    }
    await Bun.write(join(root, "macos-orchestrator"), "packaged-macos-orchestrator");
    const manifest = {
      schemaVersion: 3 as const,
      buildId: "build-1",
      contractVersion: "0.1.0",
      platforms: {
        "linux-x64": {
          installer: { url: "https://release.test/linux-installer.sh", sha256: hash },
          orchestrator: { url: "https://release.test/linux-orchestrator", sha256: hash },
          jobAgent: { url: "https://release.test/linux-job-agent", sha256: hash },
          brokerImage: `ghcr.io/snazzie/mars/linux-broker@sha256:${hash}`,
          goldenImage: { url: "https://release.test/worker.qcow2", sha256: hash },
          compose: { url: "https://release.test/compose.yaml", sha256: hash },
          domainTemplate: { url: "https://release.test/domain.xml", sha256: hash },
        },
        "windows-x64": {
          installer: { url: "https://release.test/windows-installer.ps1", sha256: hash },
          orchestrator: { url: "https://release.test/windows-orchestrator", sha256: hash },
          serviceHost: { url: "https://release.test/windows-service-host", sha256: hash },
          jobAgent: { url: "https://release.test/windows-job-agent", sha256: hash },
          container: {
            baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
            runner: { url: "https://release.test/runner.zip", sha256: hash },
            git: { url: "https://release.test/git.zip", sha256: hash },
            vcRuntime: { url: "https://release.test/vc.exe", sha256: hash },
            buildScript: { url: "https://release.test/build.ps1", sha256: hash },
            verifyScript: { url: "https://release.test/verify.ps1", sha256: hash },
            containerfile: { url: "https://release.test/Containerfile", sha256: hash },
            entrypoint: { url: "https://release.test/entrypoint.ps1", sha256: hash },
          },
        },
        "macos-arm64": {
          installer: { url: "https://release.test/macos-installer.sh", sha256: hash },
          orchestrator: { url: "https://release.test/macos-orchestrator", sha256: hash },
          jobAgent: { url: "https://release.test/macos-job-agent", sha256: hash },
          imagePreparationScript: { url: "https://release.test/prepare-macos-job-image.sh", sha256: hash },
          tartSourceImage: `ghcr.io/cirruslabs/macos-sonoma-base@sha256:${hash}`,
        },
      },
    };
    const releaseApp = createControlPlaneApp(fakeHttpDeps({
      workerInstallerRoot: pathToFileURL(`${root}/`),
      workerReleaseManifest: manifest,
      workerConnectionOrigins: () => ["https://adapter.test"],
      workerOrchestratorExecutables: { "linux-x64": pathToFileURL(join(root, "linux-orchestrator")), "windows-x64": pathToFileURL(join(root, "windows-orchestrator")), "macos-arm64": pathToFileURL(join(root, "macos-orchestrator")) },
    }));
    const response = await releaseApp.request("/api/workers/installer?audience=linux-x64&connectOrigin=https%3A%2F%2Fadapter.test");
    expect(response.status).toBe(200);
    const installer = await response.text();
    expect(installer).toContain("MARS_ARTIFACT_MODE='production'");
    expect(installer).toContain("MARS_GOLDEN_IMAGE='https://adapter.test/api/workers/linux-golden-image'");
    expect(installer).toContain("MARS_COMPOSE_FILE='https://adapter.test/api/workers/linux-broker-compose'");
    expect(installer).toContain("MARS_DOMAIN_TEMPLATE='https://adapter.test/api/workers/linux-domain-template'");
    expect(installer).not.toContain("https://release.test/worker.qcow2");
    expect(installer).not.toContain("__");

    const macosResponse = await releaseApp.request("/api/workers/installer?audience=macos-arm64&connectOrigin=https%3A%2F%2Fadapter.test");
    const macosInstaller = await macosResponse.text();
    expect(macosResponse.status).toBe(200);
    expect(macosInstaller).toContain("MARS_ARTIFACT_MODE='production'");
    expect(macosInstaller).toContain("PUBLIC_BASE_URL='https://adapter.test'");
    expect(macosInstaller).toContain(`MARS_ORCHESTRATOR_SHA256='${hash}'`);
    expect(macosInstaller).toContain(`TART_IMAGE='ghcr.io/cirruslabs/macos-sonoma-base@sha256:${hash}'`);
    expect(macosInstaller).toContain(`TART_IMAGE_DIGEST='${hash}'`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("development worker artifact hardening", () => {
  test("startup cleanup removes stale orphan snapshots without touching fresh snapshots", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "mars-worker-artifact-"));
    const stale = await mkdtemp(join(tmpdir(), "mars-worker-artifact-"));
    const live = await mkdtemp(join(tmpdir(), `mars-worker-artifact-${process.pid}-`));
    try {
      await Bun.write(join(fresh, "artifact"), "active");
      await Bun.write(join(stale, "artifact"), "orphan");
      await Bun.write(join(live, "artifact"), "live");
      const staleTime = new Date(Date.now() - 4 * 60 * 60_000);
      await utimes(stale, staleTime, staleTime);
      await utimes(live, staleTime, staleTime);

      // Cache-busted import exercises module startup after fixtures exist.
      const { orphanCleanup: startupCleanup } = await import(`./worker-routes.ts?orphan-cleanup=${crypto.randomUUID()}`);
      await startupCleanup;
      const entries = await readdir(tmpdir());

      expect(entries).toContain(basename(fresh));
      expect(entries).not.toContain(basename(stale));
      expect(entries).toContain(basename(live));
    } finally {
      await Promise.all([fresh, stale, live].map(path => rm(path, { recursive: true, force: true })));
    }
  });

  test("rejects a container installer from only current local worker binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-current-worker-binaries-"));
    const orchestrator = join(root, "mars-orchestrator.exe");
    const serviceHost = join(root, "mars-service-host.exe");
    try {
      await Bun.write(join(root, "install-worker.ps1"), "[CmdletBinding()]\r\nparam()\r\n");
      await Bun.write(orchestrator, "rebuilt-orchestrator");
      await Bun.write(serviceHost, "rebuilt-service-host");
      const orchestratorHash = createHash("sha256").update("rebuilt-orchestrator").digest("hex");
      const serviceHostHash = createHash("sha256").update("rebuilt-service-host").digest("hex");
      const hardenedApp = createControlPlaneApp(fakeHttpDeps({
        workerInstallerRoot: pathToFileURL(`${root}/`), workerReleaseManifest: undefined,
        workerConnectionOrigins: () => ["https://control.test"],
        developmentWindowsArtifacts: { orchestrator: { path: orchestrator, sha256: orchestratorHash }, serviceHost: { path: serviceHost, sha256: serviceHostHash } },
      }));
      const installerResponse = await hardenedApp.request("/api/workers/installer?audience=windows-x64&runtime=container&connectOrigin=https%3A%2F%2Fcontrol.test");
      expect(installerResponse.status).toBe(503);
      expect((await installerResponse.json()).code).toBe("artifact_unavailable");
      const artifactResponse = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
      expect(artifactResponse.status).toBe(200);
      expect(artifactResponse.headers.get("X-Content-SHA256")).toBe(orchestratorHash);
      expect(await artifactResponse.text()).toBe("rebuilt-orchestrator");
    } finally { await rm(root, { recursive: true, force: true }); }
  });


  test("blocks a public artifact redirect to a private destination before fetching it", async () => {
    const calls: string[] = [];
    const fetcher = Object.assign(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } });
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: "a".repeat(64) },
        serviceHost: { url: "https://public.test/service-host", sha256: "b".repeat(64) },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async hostname => hostname === "public.test" ? ["93.184.216.34"] : ["127.0.0.1"],
      },
    }));

    const response = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(response.status).toBe(503);
    expect(calls).toEqual(["https://93.184.216.34/orchestrator"]);
    expect(await response.json()).toMatchObject({ code: "artifact_unavailable" });
  });

  test("allows an explicitly local artifact source to follow local redirects", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/redirect"
          ? new Response(null, { status: 302, headers: { location: "/artifact" } })
          : new Response("local-artifact");
      },
    });
    try {
      const hardenedApp = createControlPlaneApp(fakeHttpDeps({
        workerReleaseManifest: undefined,
        developmentWindowsArtifacts: {
          orchestrator: { url: `http://127.0.0.1:${upstream.port}/redirect`, sha256: createHash("sha256").update("local-artifact").digest("hex") },
          serviceHost: { url: `http://127.0.0.1:${upstream.port}/service-host`, sha256: createHash("sha256").update("local-artifact").digest("hex") },
        },
      }));

      const response = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("local-artifact");
    } finally {
      upstream.stop();
    }
  });

  test("bounds artifact redirect chains", async () => {
    let calls = 0;
    const fetcher = Object.assign(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: `/redirect-${calls}` } });
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/start", sha256: "a".repeat(64) },
        serviceHost: { url: "https://public.test/service-host", sha256: "b".repeat(64) },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        maxRedirects: 2,
      },
    }));

    const response = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(response.status).toBe(503);
    expect(calls).toBe(3);
  });

  test("enforces upstream header and total timeouts and byte ceilings", async () => {
    const makeApp = (fetcher: typeof fetch, overrides: Record<string, unknown>) => createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: "a".repeat(64) },
        serviceHost: { url: "https://public.test/service-host", sha256: "b".repeat(64) },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        ...overrides,
      },
    }));
    let headerAborted = false;
    const slowHeaders = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => { headerAborted = true; }, { once: true });
      await Bun.sleep(40);
      return new Response("late");
    }, { preconnect: globalThis.fetch.preconnect });
    const headerResponse = await makeApp(slowHeaders, { headerTimeoutMs: 5, totalTimeoutMs: 100 }).request("/api/workers/orchestrator?audience=windows-x64");
    expect(headerResponse.status).toBe(503);
    expect(headerAborted).toBe(true);

    let bodyCancelled = false;
    const stalledBody = Object.assign(async () => new Response(new ReadableStream({
      cancel() {
        bodyCancelled = true;
      },
    })), { preconnect: globalThis.fetch.preconnect });
    const totalResponse = await makeApp(stalledBody, { headerTimeoutMs: 50, totalTimeoutMs: 10 }).request("/api/workers/orchestrator?audience=windows-x64");
    expect(totalResponse.status).toBe(503);
    expect(bodyCancelled).toBe(true);

    const oversized = Object.assign(async () => new Response("12345"), { preconnect: globalThis.fetch.preconnect });
    const oversizedResponse = await makeApp(oversized, { maxBytes: { binary: 4 } }).request("/api/workers/orchestrator?audience=windows-x64");
    expect(oversizedResponse.status).toBe(503);
  });

  test("keeps a digest fill alive when its miss owner aborts", async () => {
    const body = "shared-artifact";
    const hash = createHash("sha256").update(body).digest("hex");
    const bytes = new TextEncoder().encode(body);
    let calls = 0;
    let bodyCancelled = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const fetcher = Object.assign(async () => {
      calls += 1;
      let sentFirst = false;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sentFirst) {
            sentFirst = true;
            controller.enqueue(bytes.subarray(0, 4));
            markStarted();
            return;
          }
          await gate;
          if (bodyCancelled) return;
          controller.enqueue(bytes.subarray(4));
          controller.close();
        },
        cancel() {
          bodyCancelled = true;
        },
      }), { headers: { "content-length": String(bytes.byteLength) } });
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: hash },
        serviceHost: { url: "https://public.test/service-host", sha256: hash },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        headerTimeoutMs: 500,
        totalTimeoutMs: 1_000,
        maxConcurrent: 1,
        maxQueued: 1,
      },
    }));

    const controller = new AbortController();
    const owner = hardenedApp.request(new Request("https://control.test/api/workers/orchestrator?audience=windows-x64", { signal: controller.signal }));
    await started;
    const follower = hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    controller.abort();
    expect((await owner).status).toBe(503);
    release();

    const followed = await follower;
    expect(followed.status).toBe(200);
    expect(await followed.text()).toBe(body);
    expect(bodyCancelled).toBe(false);
    expect(calls).toBe(1);

    const cached = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe(body);
    expect(calls).toBe(1);
  });

  test("keeps a cold-fill permit after its owner aborts", async () => {
    const firstBody = "artifact-a";
    const secondBody = "artifact-b";
    const firstHash = createHash("sha256").update(firstBody).digest("hex");
    const secondHash = createHash("sha256").update(secondBody).digest("hex");
    const firstBytes = new TextEncoder().encode(firstBody);
    let activeUpstreams = 0;
    let maximumActiveUpstreams = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const fetcher = Object.assign(async (input: string | URL | Request) => {
      activeUpstreams += 1;
      maximumActiveUpstreams = Math.max(maximumActiveUpstreams, activeUpstreams);
      if (new URL(String(input)).pathname.includes("service-host")) {
        activeUpstreams -= 1;
        return new Response(secondBody);
      }
      let sentFirst = false;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sentFirst) {
            sentFirst = true;
            controller.enqueue(firstBytes.subarray(0, 1));
            markFirstStarted();
            return;
          }
          await firstGate;
          activeUpstreams -= 1;
          controller.enqueue(firstBytes.subarray(1));
          controller.close();
        },
        cancel() {
          activeUpstreams -= 1;
        },
      }));
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: firstHash },
        serviceHost: { url: "https://public.test/service-host", sha256: secondHash },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        maxConcurrent: 1,
        maxQueued: 0,
        totalTimeoutMs: 1_000,
      },
    }));

    const ownerController = new AbortController();
    const owner = hardenedApp.request(new Request("https://control.test/api/workers/orchestrator?audience=windows-x64", { signal: ownerController.signal }));
    await firstStarted;
    ownerController.abort();
    expect((await owner).status).toBe(503);

    const distinct = await hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    const distinctStatus = distinct.status;
    await distinct.arrayBuffer();
    const follower = hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    releaseFirst();
    const followed = await follower;
    expect(followed.status).toBe(200);
    expect(await followed.text()).toBe(firstBody);
    expect(distinctStatus).toBe(503);
    expect(maximumActiveUpstreams).toBe(1);
  });

  test("bounds and removes callers waiting on one digest flight", async () => {
    const body = "bounded-flight";
    const hash = createHash("sha256").update(body).digest("hex");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const fetcher = Object.assign(async () => {
      markStarted();
      await gate;
      return new Response(body);
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: hash },
        serviceHost: { url: "https://public.test/service-host", sha256: hash },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        maxConcurrent: 1,
        maxQueued: 1,
        maxFlightWaiters: 2,
        totalTimeoutMs: 1_000,
      },
    }));

    const owner = hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    await started;
    const followerController = new AbortController();
    const follower = hardenedApp.request(new Request("https://control.test/api/workers/service-host?audience=windows-x64", { signal: followerController.signal }));
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    const overflow = hardenedApp.request("/api/workers/service-host?audience=windows-x64");

    followerController.abort();
    expect((await follower).status).toBe(503);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const controller = new AbortController();
      const pending = hardenedApp.request(new Request("https://control.test/api/workers/service-host?audience=windows-x64", { signal: controller.signal }));
      await Promise.resolve();
      controller.abort();
      expect((await pending).status).toBe(503);
    }

    const finalFollower = hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    release();
    const ownerResponse = await owner;
    expect(ownerResponse.status).toBe(200);
    await ownerResponse.arrayBuffer();
    const overflowResponse = await overflow;
    const overflowStatus = overflowResponse.status;
    await overflowResponse.arrayBuffer();
    const followerResponse = await finalFollower;
    expect(followerResponse.status).toBe(200);
    expect(await followerResponse.text()).toBe(body);
    expect(overflowStatus).toBe(503);
    const cached = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe(body);
  });

  test("keeps cached downstream responses admission-limited", async () => {
    const body = "cached-admission";
    const hash = createHash("sha256").update(body).digest("hex");
    const fetcher = Object.assign(async () => new Response(body), { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: hash },
        serviceHost: { url: "https://public.test/service-host", sha256: hash },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        maxConcurrent: 1,
        maxQueued: 0,
      },
    }));

    const fill = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(fill.status).toBe(200);
    await fill.arrayBuffer();
    const held = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(held.status).toBe(200);
    const rejected = await hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    expect(rejected.status).toBe(503);
    await held.arrayBuffer();
    const admitted = await hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    expect(admitted.status).toBe(200);
    expect(await admitted.text()).toBe(body);
  });

  test.each(["failure", "timeout"] as const)("releases a cold-flight permit after %s", async mode => {
    const recoveredBody = `recovered-after-${mode}`;
    const failedHash = createHash("sha256").update("never-produced").digest("hex");
    const recoveredHash = createHash("sha256").update(recoveredBody).digest("hex");
    const fetcher = Object.assign(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.includes("service-host")) return new Response(recoveredBody);
      if (mode === "failure") throw new Error("upstream failed");
      return new Response(new ReadableStream({ cancel() {} }));
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: failedHash },
        serviceHost: { url: "https://public.test/service-host", sha256: recoveredHash },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        maxConcurrent: 1,
        maxQueued: 0,
        headerTimeoutMs: 100,
        // This case deliberately exercises the platform timeout that owns the flight permit.
        totalTimeoutMs: 5,
      },
    }));

    const failed = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(failed.status).toBe(503);
    const recovered = await hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe(recoveredBody);
  });

  test("single-flights URL artifacts by digest and serves repeated cache hits", async () => {
    const body = "single-flight-artifact";
    const hash = createHash("sha256").update(body).digest("hex");
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const fetcher = Object.assign(async () => {
      calls += 1;
      firstStarted();
      await gate;
      return new Response(body, { headers: { "content-length": String(body.length) } });
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: hash },
        serviceHost: { url: "https://public.test/service-host", sha256: hash },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
      },
    }));

    const first = hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    await started;
    const second = hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(calls).toBe(1);
    release();
    const concurrent = await Promise.all([first, second]);
    expect(await Promise.all(concurrent.map(response => response.text()))).toEqual([body, body]);

    const cached = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe(body);
    expect(calls).toBe(1);
  });

  test("rejects a distinct digest before the aggregate cache budget is exceeded", async () => {
    const firstBody = "123456";
    const secondBody = "abcdef";
    const firstHash = createHash("sha256").update(firstBody).digest("hex");
    const secondHash = createHash("sha256").update(secondBody).digest("hex");
    const fetcher = Object.assign(async (input: string | URL | Request) => {
      const body = new URL(String(input)).pathname.includes("service-host") ? secondBody : firstBody;
      return new Response(body, { headers: { "content-length": String(body.length) } });
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: firstHash },
        serviceHost: { url: "https://public.test/service-host", sha256: secondHash },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        maxCacheBytes: 10,
      },
    }));

    const admitted = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(admitted.status).toBe(200);
    expect(await admitted.text()).toBe(firstBody);
    const rejected = await hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ code: "artifact_unavailable" });
  });

  test("rejects a URL-backed artifact whose bytes do not match the configured digest", async () => {
    const fetcher = Object.assign(async () => new Response("tampered-artifact"), { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: createHash("sha256").update("expected-artifact").digest("hex") },
        serviceHost: { url: "https://public.test/service-host", sha256: "b".repeat(64) },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
      },
    }));

    const response = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "artifact_unavailable" });
  });

  test("connects to the approved DNS address while preserving Host and TLS SNI", async () => {
    const body = "dns-pinned-artifact";
    const observed: { url?: string; host?: string | null; serverName?: string } = {};
    const fetcher = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      observed.url = String(input);
      observed.host = new Headers(init?.headers).get("host");
      observed.serverName = (init as RequestInit & { tls?: { serverName?: string } } | undefined)?.tls?.serverName;
      return new Response(body);
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test:8443/download?build=1", sha256: createHash("sha256").update(body).digest("hex") },
        serviceHost: { url: "https://public.test/service-host", sha256: "b".repeat(64) },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
      },
    }));

    const response = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(observed).toEqual({
      url: "https://93.184.216.34:8443/download?build=1",
      host: "public.test:8443",
      serverName: "public.test",
    });
  });

  test("aborts DNS resolution at the per-hop timeout", async () => {
    let dnsAborted = false;
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://slow-dns.test/orchestrator", sha256: "a".repeat(64) },
        serviceHost: { url: "https://slow-dns.test/service-host", sha256: "b".repeat(64) },
      },
      developmentArtifactProxy: {
        resolveHostname: (_hostname: string, signal: AbortSignal) => new Promise<readonly string[]>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            dnsAborted = true;
            reject(signal.reason);
          }, { once: true });
        }),
        headerTimeoutMs: 5,
        totalTimeoutMs: 100,
      },
    }));

    const response = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(response.status).toBe(503);
    expect(dnsAborted).toBe(true);
  });

  test("does not extend a local URL exception across a cross-origin private redirect", async () => {
    const calls: string[] = [];
    const fetcher = Object.assign(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
    }, { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "http://localhost/start", sha256: "a".repeat(64) },
        serviceHost: { url: "http://localhost/service-host", sha256: "b".repeat(64) },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["127.0.0.1"],
      },
    }));

    const response = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  test("rejects admission when the bounded artifact queue is full", async () => {
    const bodies = {
      orchestrator: "queued-orchestrator",
      serviceHost: "queued-service-host",
    };
    const completions: Array<() => void> = [];
    const starts: Array<() => void> = [];
    const fetcher = Object.assign((input: string | URL | Request) => new Promise<Response>(resolve => {
      starts.shift()?.();
      const path = new URL(String(input)).pathname;
      const body = path.includes("service-host") ? bodies.serviceHost : bodies.orchestrator;
      completions.push(() => resolve(new Response(body)));
    }), { preconnect: globalThis.fetch.preconnect });
    const hardenedApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: undefined,
      developmentWindowsArtifacts: {
        orchestrator: { url: "https://public.test/orchestrator", sha256: createHash("sha256").update(bodies.orchestrator).digest("hex") },
        serviceHost: { url: "https://public.test/service-host", sha256: createHash("sha256").update(bodies.serviceHost).digest("hex") },
      },
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
        maxConcurrent: 1,
        maxQueued: 1,
        totalTimeoutMs: 1_000,
      },
    }));

    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve; });
    starts.push(markFirstStarted, markSecondStarted);
    const first = hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
    await firstStarted;
    const second = hardenedApp.request("/api/workers/service-host?audience=windows-x64");
    const overflow = await hardenedApp.request("/api/workers/templates/windows-x64/artifact");
    expect(overflow.status).toBe(503);
    completions.shift()?.();
    await secondStarted;
    completions.shift()?.();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    await firstResponse.arrayBuffer();
    const secondResponse = await second;
    expect(secondResponse.status).toBe(200);
    await secondResponse.arrayBuffer();
  });

  test("holds admission for local snapshots until their response body is consumed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-local-admission-"));
    const artifact = join(root, "artifact.exe");
    try {
      await Bun.write(artifact, "local-snapshot");
      const hardenedApp = createControlPlaneApp(fakeHttpDeps({
        workerReleaseManifest: undefined,
        developmentWindowsArtifacts: {
          orchestrator: { path: artifact, sha256: createHash("sha256").update("local-snapshot").digest("hex") },
          serviceHost: { path: artifact, sha256: createHash("sha256").update("local-snapshot").digest("hex") },
        },
        developmentArtifactProxy: {
          maxConcurrent: 1,
          maxQueued: 0,
        },
      }));

      const first = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
      expect(first.status).toBe(200);
      const rejected = await hardenedApp.request("/api/workers/service-host?audience=windows-x64");
      expect(rejected.status).toBe(503);
      expect(await first.text()).toBe("local-snapshot");
      const admitted = await hardenedApp.request("/api/workers/service-host?audience=windows-x64");
      expect(admitted.status).toBe(200);
      await admitted.arrayBuffer();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serves current local artifact bytes without creating temporary copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-local-zero-copy-"));
    const artifact = join(root, "artifact.exe");
    const stagedDirectories = async () => (await readdir(tmpdir(), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith("mars-worker-artifact-")).length;
    try {
      const body = "local-zero-copy";
      await Bun.write(artifact, body);
      const hash = createHash("sha256").update(body).digest("hex");
      const before = await stagedDirectories();
      const hardenedApp = createControlPlaneApp(fakeHttpDeps({
        workerReleaseManifest: undefined,
        developmentWindowsArtifacts: {
          orchestrator: { path: artifact, sha256: hash },
          serviceHost: { path: artifact, sha256: hash },
        },
      }));

      const first = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Content-SHA256")).toBe(hash);
      expect(await stagedDirectories()).toBe(before);
      expect(await first.text()).toBe(body);

      const repeated = await hardenedApp.request("/api/workers/orchestrator?audience=windows-x64");
      expect(repeated.status).toBe(200);
      expect(await stagedDirectories()).toBe(before);
      expect(await repeated.text()).toBe(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Linux and macOS platform artifact sources", () => {
  test("refreshes local Linux hashes at request time and injects only control-plane URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-local-linux-artifacts-"));
    const golden = join(root, "worker.qcow2");
    const compose = join(root, "linux-broker-compose.yaml");
    const domain = join(root, "worker-domain.xml");
    try {
      await Bun.write(join(root, "install-worker.sh"), "#!/bin/sh\nprintf ready\n");
      await Bun.write(golden, "old-golden");
      await Bun.write(compose, "old-compose");
      await Bun.write(domain, "old-domain");
      const localApp = createControlPlaneApp(fakeHttpDeps({
        workerInstallerRoot: pathToFileURL(`${root}/`),
        workerReleaseManifest: undefined,
        workerConnectionOrigins: () => ["https://worker.test"],
        developmentLinuxArtifacts: {
          brokerImage: "mars/linux-broker:dev",
          goldenImage: { path: golden, sha256: createHash("sha256").update("current-golden").digest("hex") },
          compose: { path: compose, sha256: createHash("sha256").update("current-compose").digest("hex") },
          domainTemplate: { path: domain, sha256: createHash("sha256").update("current-domain").digest("hex") },
        },
      }));
      await Bun.write(golden, "current-golden");
      await Bun.write(compose, "current-compose");
      await Bun.write(domain, "current-domain");
      const goldenHash = createHash("sha256").update("current-golden").digest("hex");
      const composeHash = createHash("sha256").update("current-compose").digest("hex");
      const domainHash = createHash("sha256").update("current-domain").digest("hex");

      const installerResponse = await localApp.request("/api/workers/installer?audience=linux-x64&runtime=container&connectOrigin=https%3A%2F%2Fworker.test");
      const installer = await installerResponse.text();
      expect(installerResponse.status).toBe(200);
      expect(installer).toContain("MARS_ARTIFACT_MODE='local'");
      expect(installer).toContain("MARS_BROKER_IMAGE='mars/linux-broker:dev'");
      expect(installer).toContain("MARS_GOLDEN_IMAGE='https://worker.test/api/workers/linux-golden-image'");
      expect(installer).toContain(`MARS_GOLDEN_DIGEST='sha256:${goldenHash}'`);
      expect(installer).toContain("MARS_COMPOSE_FILE='https://worker.test/api/workers/linux-broker-compose'");
      expect(installer).toContain(`MARS_COMPOSE_SHA256='${composeHash}'`);
      expect(installer).toContain("MARS_DOMAIN_TEMPLATE='https://worker.test/api/workers/linux-domain-template'");
      expect(installer).toContain(`MARS_DOMAIN_TEMPLATE_SHA256='${domainHash}'`);
      expect(installer).not.toContain("release.test");
      expect(installer).not.toContain("github.com");

      const artifactResponse = await localApp.request("/api/workers/linux-golden-image");
      expect(artifactResponse.status).toBe(200);
      expect(artifactResponse.headers.get("X-Content-SHA256")).toBe(goldenHash);
      expect(await artifactResponse.text()).toBe("current-golden");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects incomplete local macOS configuration while refreshing individual artifact hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-local-macos-artifacts-"));
    const orchestrator = join(root, "mars-orchestrator");
    try {
      await Bun.write(join(root, "install-worker-macos.sh"), "#!/bin/zsh\nprint ready\n");
      await Bun.write(join(root, "install-worker.sh"), "#!/bin/sh\nprintf ready\n");
      await Bun.write(orchestrator, "old-orchestrator");
      const localApp = createControlPlaneApp(fakeHttpDeps({
        workerInstallerRoot: pathToFileURL(`${root}/`),
        workerReleaseManifest: undefined,
        workerConnectionOrigins: () => ["http://localhost:3000"],
        developmentMacosArtifacts: {
          orchestrator: { path: orchestrator, sha256: createHash("sha256").update("old-orchestrator").digest("hex") },
          tartImage: "mars-macos-dev",
          tartImageDigest: "d".repeat(64),
        },
      }));
      await Bun.write(orchestrator, "current-orchestrator");
      const orchestratorHash = createHash("sha256").update("current-orchestrator").digest("hex");
      const macosResponse = await localApp.request("/api/workers/installer?audience=macos-arm64&runtime=container&connectOrigin=http%3A%2F%2Flocalhost%3A3000");
      expect(macosResponse.status).toBe(503);
      expect((await macosResponse.json()).code).toBe("artifact_unavailable");
      expect((await localApp.request("/api/workers/installer?audience=linux-x64&runtime=container&connectOrigin=http%3A%2F%2Flocalhost%3A3000")).status).toBe(503);
      const artifactResponse = await localApp.request("/api/workers/orchestrator?audience=macos-arm64");
      expect(artifactResponse.status).toBe(200);
      expect(artifactResponse.headers.get("X-Content-SHA256")).toBe(orchestratorHash);
      expect(await artifactResponse.text()).toBe("current-orchestrator");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("proxies the immutable production Linux golden image through the hardened boundary", async () => {
    const body = "production-golden-image";
    const hash = createHash("sha256").update(body).digest("hex");
    const requested: string[] = [];
    const fetcher = Object.assign(async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(body, { headers: { "content-type": "application/octet-stream" } });
    }, { preconnect: globalThis.fetch.preconnect });
    const manifest = {
      schemaVersion: 3 as const,
      buildId: "production-build",
      contractVersion: "0.1.0",
      platforms: {
        "linux-x64": {
          installer: { url: "https://release.test/linux-installer.sh", sha256: "a".repeat(64) },
          orchestrator: { url: "https://release.test/linux-orchestrator", sha256: "a".repeat(64) },
          jobAgent: { url: "https://release.test/linux-job-agent", sha256: "a".repeat(64) },
          brokerImage: `ghcr.io/snazzie/mars/linux-broker@sha256:${"b".repeat(64)}`,
          goldenImage: { url: "https://release.test/linux-golden.qcow2", sha256: hash },
          compose: { url: "https://release.test/compose.yaml", sha256: "c".repeat(64) },
          domainTemplate: { url: "https://release.test/domain.xml", sha256: "d".repeat(64) },
        },
        "windows-x64": null,
        "macos-arm64": null,
      },
    };
    const productionApp = createControlPlaneApp(fakeHttpDeps({
      workerReleaseManifest: manifest,
      developmentLinuxArtifacts: undefined,
      developmentMacosArtifacts: undefined,
      developmentArtifactProxy: {
        fetch: fetcher,
        resolveHostname: async () => ["93.184.216.34"],
      },
    }));

    const response = await productionApp.request("/api/workers/linux-golden-image");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-SHA256")).toBe(hash);
    expect(await response.text()).toBe(body);
    expect(requested).toEqual(["https://93.184.216.34/linux-golden.qcow2"]);
  });
});
