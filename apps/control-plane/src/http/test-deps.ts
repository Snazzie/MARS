import { SecretBox } from "../auth.ts";
import type { ControlPlaneHttpDeps } from "./types.ts";
import type { WorkerReleaseManifest } from "@mars/contracts";

const fakeDb = (() => []) as unknown as ControlPlaneHttpDeps["db"];
const testHash = "a".repeat(64);
const testReleaseManifest: WorkerReleaseManifest = {
  schemaVersion: 2,
  buildId: "test-build",
  contractVersion: "0.1.0",
  platforms: {
    "linux-x64": {
      orchestratorSha256: testHash,
      brokerImage: `ghcr.io/mars/broker@sha256:${testHash}`,
      goldenImageUrl: "https://release.test/worker.qcow2",
      goldenImageSha256: testHash,
      composeSha256: testHash,
      domainTemplateSha256: testHash,
    },
    "windows-x64": {
      orchestratorSha256: testHash,
      serviceHostSha256: testHash,
      vmTemplateUrl: "https://release.test/worker.vhdx",
      vmTemplateSha256: testHash,
      container: {
        baseImage: `mcr.microsoft.com/windows@sha256:${testHash}`,
        runner: { url: "https://release.test/runner.zip", sha256: testHash },
        git: { url: "https://release.test/git.zip", sha256: testHash },
        vcRuntime: { url: "https://release.test/vc.exe", sha256: testHash },
      },
    },
    "macos-arm64": {
      orchestratorSha256: testHash,
      tartImage: `ghcr.io/mars/macos@sha256:${testHash}`,
      tartImageDigest: testHash,
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
