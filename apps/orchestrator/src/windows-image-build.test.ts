import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { WorkerBuildImagePayload, workerBuildImageContentDescriptor } from "@mars/contracts";
import { downloadWindowsImageBuildArtifacts } from "./windows-image-build.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function payload() {
  const artifact = (name: string) => ({ url: `https://artifacts.test/${name}`, sha256: sha(`content:${name}`) });
  const content = {
    image: "mars/windows-job:local" as const,
    baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${"a".repeat(64)}`,
    runner: { url: "https://downloads.test/runner.zip", sha256: "b".repeat(64) },
    git: { url: "https://downloads.test/git.zip", sha256: "c".repeat(64) },
    vcRuntime: { url: "https://downloads.test/vc.exe", sha256: "d".repeat(64) },
    artifacts: {
      builder: artifact("builder"), verifier: artifact("verifier"), containerfile: artifact("containerfile"),
      entrypoint: artifact("entrypoint"), jobAgent: artifact("jobAgent"),
    },
  };
  return WorkerBuildImagePayload.parse({ ...content, buildId: randomUUID(), contentSha256: sha(workerBuildImageContentDescriptor(content)) });
}

test("writes exactly the release artifacts described by the received payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-worker-image-"));
  try {
    const received = payload();
    const paths = await downloadWindowsImageBuildArtifacts(received, root, async (input) => {
      const name = new URL(String(input)).pathname.slice(1);
      return new Response(`content:${name}`);
    });
    expect(await readFile(paths.entrypoint, "utf8")).toBe("content:entrypoint");
    expect(await readFile(paths.jobAgent, "utf8")).toBe("content:jobAgent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an artifact whose received bytes do not match the command digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-worker-image-"));
  try {
    await expect(downloadWindowsImageBuildArtifacts(payload(), root, async () => new Response("corrupt"))).rejects.toThrow("builder SHA-256 mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
