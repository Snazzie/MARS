import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workerBuildImageContentDescriptor, type WorkerBuildImagePayload } from "@whitesmith/contracts";

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
  jobAgent: "whitesmith-job-agent.exe",
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
