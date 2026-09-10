import { createHash } from "node:crypto";
import {
  enumerateWorkerReleaseAssets,
  loadWorkerReleaseManifest,
  type WorkerReleaseAsset,
} from "../apps/control-plane/src/worker-release.ts";
import type { WorkerReleaseManifest } from "../packages/contracts/src/worker-release.ts";

export type VerifiedWorkerRelease = {
  workerTag: string;
  workerVersion: string;
  manifestUrl: string;
  contractVersion: string;
  workerBuildId: string;
  brokerImage: string;
  brokerDigest: string;
};

type VerifyOptions = {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const workerManifestPattern = /^https:\/\/github\.com\/Snazzie\/MARS\/releases\/download\/(worker-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/worker-release-manifest\.json$/i;
const digestPattern = /@(?<digest>sha256:[0-9a-f]{64})$/;

function releaseVersion(manifestUrl: string): { workerTag: string; workerVersion: string } {
  const match = workerManifestPattern.exec(manifestUrl);
  if (!match) throw new Error("worker manifest URL must be the immutable Snazzie/MARS worker-v<semver> release path");
  return { workerTag: match[1], workerVersion: match[1].slice("worker-v".length) };
}

async function hashAsset(asset: WorkerReleaseAsset, fetcher: VerifyOptions["fetch"]): Promise<void> {
  let url: URL;
  try { url = new URL(asset.url); } catch { throw new Error(`${asset.field}: invalid asset URL`); }
  if (url.username || url.password) throw new Error(`${asset.field}: asset URL must not contain credentials`);
  const response = await (fetcher ?? fetch)(url);
  if (!response.ok) throw new Error(`${asset.field}: asset request failed with HTTP ${response.status}`);
  if (!response.body) throw new Error(`${asset.field}: asset response has no body`);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const actual = hash.digest("hex");
  if (actual !== asset.sha256.toLowerCase()) throw new Error(`${asset.field}: SHA-256 mismatch`);
}

export async function verifyPublishedWorkerRelease(
  manifestUrl: string,
  controlPlaneContractVersion: string,
  options: VerifyOptions = {},
): Promise<VerifiedWorkerRelease> {
  const { workerTag, workerVersion } = releaseVersion(manifestUrl);
  const manifest: WorkerReleaseManifest = await loadWorkerReleaseManifest(manifestUrl, undefined, {
    fetch: options.fetch,
    controlPlaneVersion: controlPlaneContractVersion,
  });
  if (manifest.contractVersion !== controlPlaneContractVersion) {
    throw new Error(`worker release contract ${manifest.contractVersion} is incompatible with published control-plane contract ${controlPlaneContractVersion}`);
  }
  const assets = enumerateWorkerReleaseAssets(manifest);
  for (const asset of assets) await hashAsset(asset, options.fetch);
  const linux = manifest.platforms["linux-x64"];
  if (!linux) throw new Error("worker release manifest does not provide a linux-x64 release");
  const digest = digestPattern.exec(linux.brokerImage)?.groups?.digest;
  if (!digest) throw new Error("linux broker image is not digest pinned");
  return {
    workerTag,
    workerVersion,
    manifestUrl,
    contractVersion: manifest.contractVersion,
    workerBuildId: manifest.buildId,
    brokerImage: linux.brokerImage,
    brokerDigest: digest,
  };
}

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  try {
    const result = await verifyPublishedWorkerRelease(argument("--manifest-url"), argument("--contract-version"));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
