import { SecretBox } from "../auth.ts";
import type { ControlPlaneHttpDeps } from "./types.ts";
import type { WorkerReleaseManifest } from "@mars/contracts";

const fakeDb = (() => []) as unknown as ControlPlaneHttpDeps["db"];
const testHash = "a".repeat(64);
const testAsset = (name: string) => ({ url: `https://release.test/${name}`, sha256: testHash });
const testReleaseManifest: WorkerReleaseManifest = {
  schemaVersion: 3,
  buildId: "test-build",
  contractVersion: "0.1.0",
  platforms: {
    "linux-x64": {
      installer: testAsset("linux-installer.sh"),
      orchestrator: testAsset("linux-orchestrator"),
      jobAgent: testAsset("linux-job-agent"),
      brokerImage: `ghcr.io/snazzie/mars/linux-broker@sha256:${testHash}`,
      goldenImage: testAsset("worker.qcow2"),
      compose: testAsset("compose.yaml"),
      domainTemplate: testAsset("domain.xml"),
    },
    "windows-x64": {
      installer: testAsset("windows-installer.ps1"),
      orchestrator: testAsset("windows-orchestrator.exe"),
      serviceHost: testAsset("windows-service-host.exe"),
      jobAgent: testAsset("windows-job-agent.exe"),
      container: {
        baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${testHash}`,
        runner: testAsset("runner.zip"),
        git: testAsset("git.zip"),
        vcRuntime: testAsset("vc.exe"),
        buildScript: testAsset("build.ps1"),
        verifyScript: testAsset("verify.ps1"),
        containerfile: testAsset("Containerfile"),
        entrypoint: testAsset("entrypoint.ps1"),
      },
    },
    "macos-arm64": {
      installer: testAsset("macos-installer.sh"),
      orchestrator: testAsset("macos-orchestrator"),
      jobAgent: testAsset("macos-job-agent"),
      imagePreparationScript: testAsset("prepare-macos-job-image.sh"),
      tartSourceImage: `ghcr.io/cirruslabs/macos-sonoma-base@sha256:${testHash}`,
    },
  },
};
const fakeSetup: ControlPlaneHttpDeps["setup"] = {
  publicOrigin: () => "https://control-plane.test",
  publicOriginManaged: () => false,
  configure: async origin => origin,
  authenticate: async () => ({ userId: "admin", firstAdmin: true }),
};

type TestOverrides = Partial<ControlPlaneHttpDeps> & Partial<{ baseUrl: string; browserBaseUrl: string; githubWebhookSecret: string }>;
export function fakeHttpDeps(overrides: TestOverrides = {}): ControlPlaneHttpDeps {
  const legacy = overrides as Partial<{ baseUrl: string; browserBaseUrl: string }>;
  const publicOrigin = legacy.baseUrl ?? "https://control-plane.test";
  const browserOrigin = legacy.browserBaseUrl ?? publicOrigin;
  return {
    db: fakeDb,
    setup: { ...fakeSetup, publicOrigin: () => publicOrigin },
    workerConnectionOrigins: () => [publicOrigin],
    browserOrigin: () => browserOrigin,
    secretBox: new SecretBox(Buffer.alloc(32, 7).toString("base64")),
    githubApp: { getOAuthCredentials: async () => ({ clientId: "client-id", clientSecret: "client-secret" }), getWebhookSecret: async () => null } as never,
    defaultJobImages: {},
    workerReleaseManifest: testReleaseManifest,
    currentUser: async () => null,
    requestId: () => "request-test-0001",
    requestSource: () => "test",
    webRoot: new URL("file:///tmp/mars-web/"),
    workerInstallerRoot: new URL("file:///tmp/mars-installers/"),
    workerOrchestratorExecutable: new URL("file:///tmp/mars-orchestrator"),
    onWorkerAdopted: () => undefined,
    health: () => ({
      buildId: "test-build",
      startedAt: "2026-08-13T00:00:00.000Z",
      discovery: {
        lastAttemptAt: "2026-08-13T00:00:30.000Z",
        lastSuccessAt: "2026-08-13T00:00:31.000Z",
        stale: false,
        staleAfterMs: 60_000,
      },
    }),
    ...overrides,
  };
}
