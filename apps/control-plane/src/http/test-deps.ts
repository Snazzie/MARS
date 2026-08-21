import { SecretBox } from "../auth.ts";
import type { ControlPlaneHttpDeps } from "./types.ts";

const fakeDb = (() => []) as unknown as ControlPlaneHttpDeps["db"];
const fakeSetup: ControlPlaneHttpDeps["setup"] = {
  publicOrigin: () => "https://control-plane.test",
  configure: async (_code, origin) => origin,
  authorize: async () => true,
  claimAdmin: async () => "admin",
};

export function fakeHttpDeps(overrides: Partial<ControlPlaneHttpDeps> = {}): ControlPlaneHttpDeps {
  return {
    db: fakeDb,
    setup: fakeSetup,
    browserOrigin: () => "https://control-plane.test",
    secretBox: new SecretBox(Buffer.alloc(32, 7).toString("base64")),
    defaultJobImages: {},
    currentUser: async () => null,
    requestId: () => "request-test-0001",
    requestSource: () => "test",
    webRoot: new URL("file:///tmp/whitesmith-web/"),
    workerInstallerRoot: new URL("file:///tmp/whitesmith-installers/"),
    workerOrchestratorExecutable: new URL("file:///tmp/whitesmith-orchestrator"),
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
