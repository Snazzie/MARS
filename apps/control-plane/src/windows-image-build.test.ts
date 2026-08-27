import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { createWorkerImageBuildPayload } from "./windows-image-build.ts";

test("binds the worker build command to the authoritative artifact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-image-payload-"));
  try {
    const files = {
      builderPath: "builder.ps1",
      verifierPath: "verifier.ps1",
      containerfilePath: "Containerfile",
      entrypointPath: "entrypoint.ps1",
      jobAgentPath: "agent.exe",
    } as const;
    for (const [key, name] of Object.entries(files)) await writeFile(join(root, name), `content:${key}`);
    const payload = await createWorkerImageBuildPayload({
      baseUrl: "https://control.test/path",
      buildId: randomUUID(),
      image: "mars/windows-job:local",
      build: {
        baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${"a".repeat(64)}`,
        runnerUrl: "https://downloads.test/runner.zip",
        runnerSha256: "b".repeat(64),
        gitUrl: "https://downloads.test/git.zip",
        gitSha256: "c".repeat(64),
        vcUrl: "https://downloads.test/vc.exe",
        vcSha256: "d".repeat(64),
        ...Object.fromEntries(Object.entries(files).map(([key, name]) => [key, join(root, name)])) as Record<keyof typeof files, string>,
      },
    });
    expect(payload.artifacts.entrypoint).toEqual({
      url: "https://control.test/api/workers/windows-container-entrypoint",
      sha256: createHash("sha256").update("content:entrypointPath").digest("hex"),
    });
    expect(payload.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.contentSha256).not.toBe(payload.artifacts.entrypoint.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
