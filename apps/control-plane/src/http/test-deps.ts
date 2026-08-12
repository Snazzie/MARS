import type { ControlPlaneHttpDeps } from "./types.ts";

const fakeDb = (() => []) as unknown as ControlPlaneHttpDeps["db"];

export function fakeHttpDeps(overrides: Partial<ControlPlaneHttpDeps> = {}): ControlPlaneHttpDeps {
  return {
    db: fakeDb,
    baseUrl: "https://control-plane.test",
    githubClientId: "github-client",
    githubClientSecret: "github-secret",
    bootstrapGithubLogin: "bootstrap",
    githubWebhookSecret: "webhook-secret",
    currentUser: async () => null,
    requestId: () => "request-test-0001",
    requestSource: () => "test",
    webRoot: new URL("file:///tmp/whitesmith-web/"),
    workerInstallerRoot: new URL("file:///tmp/whitesmith-installers/"),
    onWorkerAdopted: () => undefined,
    ...overrides,
  };
}
