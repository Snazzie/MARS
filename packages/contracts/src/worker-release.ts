import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 value required");
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const ociDigest = z.string().regex(
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[0-9]+)?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?@sha256:[0-9a-f]{64}$/,
  "digest-pinned OCI reference required",
);

export const hashedAsset = z.object({ url: httpsUrl, sha256 }).strict();
export type HashedAsset = z.infer<typeof hashedAsset>;

export const WorkerReleasePlatform = z.enum(["linux-x64", "windows-x64", "macos-arm64"]);
export type WorkerReleasePlatform = z.infer<typeof WorkerReleasePlatform>;

export const LinuxWorkerRelease = z.object({
  installer: hashedAsset,
  orchestrator: hashedAsset,
  jobAgent: hashedAsset,
  brokerImage: ociDigest,
  goldenImage: hashedAsset,
  compose: hashedAsset,
  domainTemplate: hashedAsset,
}).strict();
export type LinuxWorkerRelease = z.infer<typeof LinuxWorkerRelease>;

export const WindowsWorkerRelease = z.object({
  installer: hashedAsset,
  orchestrator: hashedAsset,
  serviceHost: hashedAsset,
  jobAgent: hashedAsset,
  container: z.object({
    baseImage: ociDigest,
    runner: hashedAsset,
    git: hashedAsset,
    vcRuntime: hashedAsset,
    buildScript: hashedAsset,
    verifyScript: hashedAsset,
    containerfile: hashedAsset,
    entrypoint: hashedAsset,
  }).strict(),
}).strict();
export type WindowsWorkerRelease = z.infer<typeof WindowsWorkerRelease>;

export const MacosWorkerRelease = z.object({
  installer: hashedAsset,
  orchestrator: hashedAsset,
  jobAgent: hashedAsset,
  imagePreparationScript: hashedAsset,
  tartSourceImage: ociDigest,
}).strict();
export type MacosWorkerRelease = z.infer<typeof MacosWorkerRelease>;

export const WorkerReleaseManifest = z.object({
  schemaVersion: z.literal(3),
  buildId: z.string().min(1),
  contractVersion: z.string().min(1),
  platforms: z.object({
    "linux-x64": LinuxWorkerRelease.nullable(),
    "windows-x64": WindowsWorkerRelease.nullable(),
    "macos-arm64": MacosWorkerRelease.nullable(),
  }).strict(),
}).strict();
export type WorkerReleaseManifest = z.infer<typeof WorkerReleaseManifest>;

export { sha256 as WorkerReleaseSha256, httpsUrl as WorkerReleaseHttpsUrl, ociDigest as WorkerReleaseOciDigest };
export { hashedAsset as WorkerReleaseHashedAsset };
