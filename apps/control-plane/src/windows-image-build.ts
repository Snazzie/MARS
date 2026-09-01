import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WorkerBuildImagePayload, workerBuildImageContentDescriptor } from "@mars/contracts";
import type { ControlPlaneHttpDeps } from "./http/types.ts";

type WindowsContainerBuild = NonNullable<ControlPlaneHttpDeps["windowsContainerBuild"]>;

async function fileSha256(path: string): Promise<string> {
  let normalizedPath = path;
  try {
    const parsed = new URL(path);
    if (parsed.protocol === "file:") normalizedPath = fileURLToPath(parsed);
  } catch {
    // Preserve raw Windows drive-letter and UNC filesystem paths.
  }
  return createHash("sha256").update(Buffer.from(await Bun.file(normalizedPath).arrayBuffer())).digest("hex");
}

export async function createWorkerImageBuildPayload(input: {
  baseUrl: string;
  buildId: string;
  image: "mars/windows-job:local";
  build: WindowsContainerBuild;
}): Promise<WorkerBuildImagePayload> {
  const origin = new URL(input.baseUrl).origin;
  const artifact = async (path: string, route: string) => ({ url: new URL(route, origin).toString(), sha256: await fileSha256(path) });
  const content = {
    image: input.image,
    baseImage: input.build.baseImage,
    runner: { url: input.build.runnerUrl, sha256: input.build.runnerSha256 },
    git: { url: input.build.gitUrl, sha256: input.build.gitSha256 },
    vcRuntime: { url: input.build.vcUrl, sha256: input.build.vcSha256 },
    artifacts: {
      builder: await artifact(input.build.builderPath, "/api/workers/windows-container-builder"),
      verifier: await artifact(input.build.verifierPath, "/api/workers/windows-container-verifier"),
      containerfile: await artifact(input.build.containerfilePath, "/api/workers/windows-containerfile"),
      entrypoint: await artifact(input.build.entrypointPath, "/api/workers/windows-container-entrypoint"),
      jobAgent: await artifact(input.build.jobAgentPath, "/api/workers/windows-container-job-agent"),
    },
  };
  const contentSha256 = createHash("sha256").update(workerBuildImageContentDescriptor(content)).digest("hex");
  return WorkerBuildImagePayload.parse({ ...content, buildId: input.buildId, contentSha256 });
}
