import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 value required");
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const ociDigest = z.string().regex(
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[0-9]+)?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?@sha256:[0-9a-f]{64}$/,
  "digest-pinned OCI reference required",
);
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parseSemVer = (value: string, label: string): { major: number; minor: number; patch: number } => {
  const match = semverPattern.exec(value);
  if (!match) throw new Error(`invalid ${label}: ${JSON.stringify(value)} (expected major.minor.patch)`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`invalid ${label}: ${JSON.stringify(value)} (numeric components are too large)`);
  return { major: major!, minor: minor!, patch: patch! };
};
export const WorkerReleaseVersion = z.string().regex(semverPattern, "major.minor.patch worker release version required");
export type WorkerReleaseVersion = z.infer<typeof WorkerReleaseVersion>;
export function parseWorkerReleaseVersion(value: string): { major: number; minor: number; patch: number } {
  return parseSemVer(value, "release version");
}
export function compareWorkerReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseWorkerReleaseVersion(left);
  const b = parseWorkerReleaseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}
export const WorkerContractVersion = z.string().regex(semverPattern, "major.minor.patch worker contract version required");
export type WorkerContractVersion = z.infer<typeof WorkerContractVersion>;
export const CURRENT_WORKER_CONTRACT_VERSION = WorkerContractVersion.parse("0.3.0");

export function parseWorkerContractVersion(value: string): { major: number; minor: number; patch: number } {
  return parseSemVer(value, "contract version");
}

export function isWorkerContractCompatible(controlPlaneVersion: string, workerVersion: string): boolean {
  try {
    const controlPlane = parseWorkerContractVersion(controlPlaneVersion);
    const worker = parseWorkerContractVersion(workerVersion);
    return worker.major === controlPlane.major && worker.minor <= controlPlane.minor;
  } catch {
    return false;
  }
}

export const hashedAsset = z.object({ url: httpsUrl, sha256 }).strict();
export type HashedAsset = z.infer<typeof hashedAsset>;

export const WorkerReleasePlatform = z.enum(["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"]);
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

export const LinuxArm64WorkerRelease = z.object({
  installer: hashedAsset,
  compose: hashedAsset,
  brokerImage: ociDigest,
  jobImage: ociDigest,
}).strict();
export type LinuxArm64WorkerRelease = z.infer<typeof LinuxArm64WorkerRelease>;

export const WindowsWorkerReleaseV5 = z.object({
  installer: hashedAsset,
  orchestrator: hashedAsset,
  serviceHost: hashedAsset,
  jobAgent: hashedAsset,
  trayScript: hashedAsset.optional(),
  vm: z.object({
    checkpoint: hashedAsset,
  }).strict().optional(),
  container: z.object({
    baseImage: ociDigest,
    runner: hashedAsset,
    git: hashedAsset,
    vcRuntime: hashedAsset,
    buildScript: hashedAsset,
    verifyScript: hashedAsset,
    containerfile: hashedAsset,
    entrypoint: hashedAsset,
  }).strict().optional(),
}).strict();
export type WindowsWorkerReleaseV5 = z.infer<typeof WindowsWorkerReleaseV5>;

export const WindowsWorkerReleaseV6 = z.object({
  installer: hashedAsset,
  orchestrator: hashedAsset,
  serviceHost: hashedAsset,
  jobAgent: hashedAsset,
  runner: hashedAsset,
  git: hashedAsset,
  vcRuntime: hashedAsset,
  trayScript: hashedAsset.optional(),
  vm: z.object({
    checkpoint: hashedAsset.optional(),
    provisioner: hashedAsset,
  }).strict().optional(),
  container: z.object({
    baseImage: ociDigest,
    buildScript: hashedAsset,
    verifyScript: hashedAsset,
    containerfile: hashedAsset,
    entrypoint: hashedAsset,
  }).strict().optional(),
}).strict();
export type WindowsWorkerReleaseV6 = z.infer<typeof WindowsWorkerReleaseV6>;
export const WindowsWorkerRelease = z.union([WindowsWorkerReleaseV5, WindowsWorkerReleaseV6]);
export type WindowsWorkerRelease = z.infer<typeof WindowsWorkerRelease>;
export const MacosWorkerRelease = z.object({
  installer: hashedAsset,
  orchestrator: hashedAsset,
  macosJobAgent: hashedAsset,
  linuxArm64JobAgent: hashedAsset,
  linuxArm64Runner: hashedAsset,
  statusItem: hashedAsset.optional(),
  imagePreparationScript: hashedAsset,
  tartMacosSourceImage: ociDigest,
  tartLinuxArm64SourceImage: ociDigest,
}).strict();
export type MacosWorkerRelease = z.infer<typeof MacosWorkerRelease>;

const workerReleasePlatformsV5 = z.object({
  "linux-x64": LinuxWorkerRelease.nullable(),
  "linux-arm64": LinuxArm64WorkerRelease.nullable(),
  "windows-x64": WindowsWorkerReleaseV5.nullable(),
  "macos-arm64": MacosWorkerRelease.nullable(),
}).strict();

const workerReleasePlatformsV6 = z.object({
  "linux-x64": LinuxWorkerRelease.nullable(),
  "linux-arm64": LinuxArm64WorkerRelease.nullable(),
  "windows-x64": WindowsWorkerReleaseV6.nullable(),
  "macos-arm64": MacosWorkerRelease.nullable(),
}).strict();

export const WorkerReleaseManifestV5 = z.object({
  schemaVersion: z.literal(5),
  buildId: z.string().min(1),
  contractVersion: WorkerContractVersion,
  platforms: workerReleasePlatformsV5,
}).strict();
export type WorkerReleaseManifestV5 = z.infer<typeof WorkerReleaseManifestV5>;

export const WorkerReleaseManifestV6 = z.object({
  schemaVersion: z.literal(6),
  buildId: z.string().min(1),
  contractVersion: WorkerContractVersion,
  platforms: workerReleasePlatformsV6,
}).strict();
export type WorkerReleaseManifestV6 = z.infer<typeof WorkerReleaseManifestV6>;

export const WorkerReleaseManifest = z.discriminatedUnion("schemaVersion", [
  WorkerReleaseManifestV5,
  WorkerReleaseManifestV6,
]);
export type WorkerReleaseManifest = z.infer<typeof WorkerReleaseManifest>;

export type NormalizedWindowsWorkerRelease = {
  release: WindowsWorkerRelease;
  installerContract: 5 | 6;
  runner: HashedAsset;
  git: HashedAsset;
  vcRuntime: HashedAsset;
  checkpoint?: HashedAsset;
  provisioner?: HashedAsset;
};

export function normalizeWindowsWorkerRelease(manifest: WorkerReleaseManifest): NormalizedWindowsWorkerRelease | undefined {
  if (manifest.schemaVersion === 5) {
    const release: WindowsWorkerReleaseV5 | null = manifest.platforms["windows-x64"];
    if (!release?.container) return undefined;
    return {
      release,
      installerContract: 5,
      runner: release.container.runner,
      git: release.container.git,
      vcRuntime: release.container.vcRuntime,
      checkpoint: release.vm?.checkpoint,
    };
  }
  const release: WindowsWorkerReleaseV6 | null = manifest.platforms["windows-x64"];
  if (!release) return undefined;
  return {
    release,
    installerContract: 6,
    runner: release.runner,
    git: release.git,
    vcRuntime: release.vcRuntime,
    checkpoint: release.vm?.checkpoint,
    provisioner: release.vm?.provisioner,
  };
}

export { sha256 as WorkerReleaseSha256, httpsUrl as WorkerReleaseHttpsUrl, ociDigest as WorkerReleaseOciDigest };
export { hashedAsset as WorkerReleaseHashedAsset };
