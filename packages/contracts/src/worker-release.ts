import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 value required");
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const ociDigest = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[0-9]+)?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*@sha256:[0-9a-f]{64}$/, "digest-pinned OCI reference required");
const hashedAsset = z.object({ url: httpsUrl, sha256 }).strict();

export const WorkerReleasePlatform = z.enum(["linux-x64", "windows-x64", "macos-arm64"]);
export type WorkerReleasePlatform = z.infer<typeof WorkerReleasePlatform>;

export const LinuxWorkerRelease = z.object({
  orchestratorSha256: sha256,
  brokerImage: ociDigest,
  goldenImageUrl: httpsUrl,
  goldenImageSha256: sha256,
  goldenCosignBundleUrl: httpsUrl,
  composeSha256: sha256,
  domainTemplateSha256: sha256,
}).strict();
export type LinuxWorkerRelease = z.infer<typeof LinuxWorkerRelease>;

export const WindowsWorkerRelease = z.object({
  orchestratorSha256: sha256,
  serviceHostSha256: sha256,
  vmTemplateUrl: httpsUrl,
  vmTemplateSha256: sha256,
  container: z.object({
    baseImage: ociDigest,
    runner: hashedAsset,
    git: hashedAsset,
    vcRuntime: hashedAsset,
  }).strict(),
}).strict();
export type WindowsWorkerRelease = z.infer<typeof WindowsWorkerRelease>;

export const MacosWorkerRelease = z.object({
  orchestratorSha256: sha256,
  tartImage: ociDigest,
  tartImageDigest: sha256,
}).strict();
export type MacosWorkerRelease = z.infer<typeof MacosWorkerRelease>;

export const WorkerReleaseManifest = z.object({
  schemaVersion: z.literal(2),
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
