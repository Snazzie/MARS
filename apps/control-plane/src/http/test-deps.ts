import { SecretBox } from "../auth.ts";
import type { ControlPlaneHttpDeps } from "./types.ts";

const fakeDb = (() => []) as unknown as ControlPlaneHttpDeps["db"];
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
