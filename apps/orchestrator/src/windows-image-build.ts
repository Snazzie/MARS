import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkerBuildImagePayload, workerBuildImageContentDescriptor } from "@mars/contracts";
import { tmpdir } from "node:os";
import { isExpectedWindowsEntrypoint } from "./windows-container.ts";

type ArtifactPaths = {
  builder: string;
  verifier: string;
  containerfile: string;
  entrypoint: string;
  jobAgent: string;
};

const filenames: Record<keyof ArtifactPaths, string> = {
  builder: "build-local.ps1",
  verifier: "verify-runtime.ps1",
  containerfile: "Containerfile",
  entrypoint: "entrypoint.ps1",
  jobAgent: "mars-job-agent.exe",
};

export async function downloadWindowsImageBuildArtifacts(
  payload: WorkerBuildImagePayload,
  root: string,
  fetcher: (input: RequestInfo | URL) => Promise<Response> = fetch,
): Promise<ArtifactPaths> {
  const receivedContentSha256 = createHash("sha256").update(workerBuildImageContentDescriptor(payload)).digest("hex");
  if (receivedContentSha256 !== payload.contentSha256) {
    throw new Error(`image build payload SHA-256 mismatch: expected ${payload.contentSha256}, got ${receivedContentSha256}`);
  }
  const paths = {} as ArtifactPaths;
  for (const name of Object.keys(filenames) as Array<keyof ArtifactPaths>) {
    const artifact = payload.artifacts[name];
    const response = await fetcher(artifact.url);
    if (!response.ok) throw new Error(`${name} download failed with HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== artifact.sha256) throw new Error(`${name} SHA-256 mismatch: expected ${artifact.sha256}, got ${actual}`);
    const path = join(root, filenames[name]);
    await writeFile(path, bytes);
    paths[name] = path;
  }
  return paths;
}

type ImageManifest = {
  schemaVersion?: number; baseImage?: string; image?: string; imageId?: string;
  runnerSha256?: string; gitSha256?: string; vcRuntimeSha256?: string;
  builderSha256?: string; verifierSha256?: string; containerfileSha256?: string; entrypointSha256?: string; jobAgentSha256?: string;
  runtimeProbe?: { mediaFoundation?: boolean; runnerCacheRegistration?: boolean; dns?: boolean; tcp443?: boolean };
};

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

async function inspectedImage(payload: WorkerBuildImagePayload, manifestPath: string): Promise<string> {
  const manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, "")) as ImageManifest;
  if (manifest.schemaVersion !== 1 || manifest.image !== payload.image || manifest.baseImage !== payload.baseImage
    || manifest.runnerSha256 !== payload.runner.sha256 || manifest.gitSha256 !== payload.git.sha256
    || manifest.vcRuntimeSha256 !== payload.vcRuntime.sha256
    || manifest.builderSha256 !== payload.artifacts.builder.sha256 || manifest.verifierSha256 !== payload.artifacts.verifier.sha256
    || manifest.containerfileSha256 !== payload.artifacts.containerfile.sha256 || manifest.entrypointSha256 !== payload.artifacts.entrypoint.sha256
    || manifest.jobAgentSha256 !== payload.artifacts.jobAgent.sha256
    || !manifest.runtimeProbe?.mediaFoundation || !manifest.runtimeProbe.runnerCacheRegistration || !manifest.runtimeProbe.dns || !manifest.runtimeProbe.tcp443) {
    throw new Error("Windows image manifest does not match the verified image");
  }
  const inspected = await run(["docker.exe", "image", "inspect", "--format", "{{json .}}", payload.image]);
  if (inspected.code !== 0) throw new Error(inspected.stderr.trim().slice(0, 1000) || "docker image inspect failed");
  const image = JSON.parse(inspected.stdout.trim()) as { Config?: { Entrypoint?: unknown }; Id?: string };
  if (!image.Id || image.Id !== manifest.imageId || !isExpectedWindowsEntrypoint(image.Config?.Entrypoint)) throw new Error("Windows image entrypoint or ID is invalid");
  return image.Id;
}

export async function prepareWindowsContainerImage(payload: WorkerBuildImagePayload, manifestPath: string, onStage?: (stage: string) => void): Promise<{ imageId: string }> {
  const parsed = WorkerBuildImagePayload.parse(payload);
  if (createHash("sha256").update(workerBuildImageContentDescriptor(parsed)).digest("hex") !== parsed.contentSha256) throw new Error("image build payload SHA-256 mismatch");
  try {
    onStage?.("inspect_image");
    return { imageId: await inspectedImage(parsed, manifestPath) };
  } catch {
    // Missing or stale image: rebuild from verified inputs before declaring it ready.
  }
  const root = await mkdtemp(join(tmpdir(), "mars-image-build-"));
  try {
    onStage?.("download_artifacts");
    const paths = await downloadWindowsImageBuildArtifacts(parsed, root);
    onStage?.("build_and_probe");
    const built = await run([
      "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.builder,
      "-BaseImage", parsed.baseImage,
      "-RunnerUrl", parsed.runner.url, "-RunnerSha256", parsed.runner.sha256,
      "-GitUrl", parsed.git.url, "-GitSha256", parsed.git.sha256,
      "-VcRuntimeUrl", parsed.vcRuntime.url, "-VcRuntimeSha256", parsed.vcRuntime.sha256,
      "-JobAgent", paths.jobAgent, "-Image", parsed.image, "-ManifestPath", manifestPath,
      "-VerifierPath", paths.verifier, "-ContainerfilePath", paths.containerfile, "-EntrypointPath", paths.entrypoint,
    ]);
    if (built.code !== 0) throw new Error((built.stderr || built.stdout).trim().slice(0, 1000) || `image builder exited ${built.code}`);
    onStage?.("verify_manifest");
    return { imageId: await inspectedImage(parsed, manifestPath) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
