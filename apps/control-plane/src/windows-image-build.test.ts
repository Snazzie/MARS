import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { createWorkerImageBuildPayload } from "./windows-image-build.ts";
import { createDevelopmentWindowsContainerBuild } from "./index.ts";

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

test("parses a local development image build with proxied dependencies and preserved hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-local-image-payload-"));
  try {
    const files = ["builder.ps1", "verifier.ps1", "Containerfile", "entrypoint.ps1", "agent.exe"];
    for (const name of files) await writeFile(join(root, name), name);
    const hash = "a".repeat(64);
    const build = createDevelopmentWindowsContainerBuild({
      publicOrigin: "https://control.test",
      artifacts: {
        container: {
          baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${"b".repeat(64)}`,
          runner: { path: join(root, "runner.zip"), sha256: hash },
          git: { path: join(root, "git.zip"), sha256: hash },
          vcRuntime: { path: join(root, "vc-runtime.exe"), sha256: hash },
        },
      },
      buildArtifacts: {
        builderPath: pathToFileURL(join(root, "builder.ps1")).toString(),
        verifierPath: pathToFileURL(join(root, "verifier.ps1")).toString(),
        containerfilePath: pathToFileURL(join(root, "Containerfile")).toString(),
        entrypointPath: pathToFileURL(join(root, "entrypoint.ps1")).toString(),
        jobAgentPath: pathToFileURL(join(root, "agent.exe")).toString(),
      },
    });
    expect(build).toMatchObject({
      builderPath: join(root, "builder.ps1"),
      verifierPath: join(root, "verifier.ps1"),
      containerfilePath: join(root, "Containerfile"),
      entrypointPath: join(root, "entrypoint.ps1"),
      jobAgentPath: join(root, "agent.exe"),
    });
    expect(build).toBeDefined();
    const payload = await createWorkerImageBuildPayload({
      baseUrl: "https://control.test",
      buildId: randomUUID(),
      image: "mars/windows-job:local",
      build: build!,
    });
    expect(payload.runner).toEqual({ url: "https://control.test/api/workers/windows-container-runner", sha256: hash });
    expect(payload.git).toEqual({ url: "https://control.test/api/workers/windows-container-git", sha256: hash });
    expect(payload.vcRuntime).toEqual({ url: "https://control.test/api/workers/windows-container-vc-runtime", sha256: hash });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
