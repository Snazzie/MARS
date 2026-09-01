import { WorkerReleaseManifest, type WorkerReleasePlatform } from "@mars/contracts";
import { createHash } from "node:crypto";
import { basename } from "node:path";

export type DevelopmentWindowsRelease = Record<string, unknown>;
export type DevelopmentWorkerRelease = { windows: DevelopmentWindowsRelease };
export type WorkerReleaseLoadOptions = {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  controlPlaneVersion?: string;
};

/** The release train owns this URL; mutable GitHub release aliases are forbidden. */
export const DEFAULT_WORKER_RELEASE_MANIFEST_URL = "";
/** Development fallback only; production must provide the baked contract version. */
export const DEFAULT_WORKER_CONTRACT_VERSION = "";
const immutableVersion = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const immutableManifestPath = new RegExp(`^/Snazzie/MARS/releases/download/(worker-v${immutableVersion})/worker-release-manifest\\.json$`, "i");
const immutableReleaseOrigin = "https://github.com";

const configuredManifestUrl = (): string => Bun.env.MARS_WORKER_RELEASE_MANIFEST_URL?.trim() ?? "";
const configuredContractVersion = (): string => Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() ?? "";

export function parseContractVersion(value: string): { major: number; minor: number; patch: number } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`invalid contract version: ${JSON.stringify(value)} (expected major.minor.patch)`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`invalid contract version: ${JSON.stringify(value)} (numeric components are too large)`);
  return { major, minor, patch };
}

export function isWorkerContractCompatible(controlPlaneVersion: string, workerVersion: string): boolean {
  try {
    const controlPlane = parseContractVersion(controlPlaneVersion);
    const worker = parseContractVersion(workerVersion);
    return worker.major === controlPlane.major && worker.minor <= controlPlane.minor;
  } catch {
    return false;
  }
}

const remoteUrl = (source: string | URL): URL | undefined => {
  let candidate: URL;
  try { candidate = source instanceof URL ? source : new URL(source); } catch { return undefined; }
  return candidate.protocol === "http:" || candidate.protocol === "https:" ? candidate : undefined;
};

const immutableWorkerTag = (url: URL): string | undefined => {
  if (url.origin !== immutableReleaseOrigin || url.username || url.password || url.search || url.hash) return undefined;
  return immutableManifestPath.exec(url.pathname)?.[1];
};

const hashedAssetEntries = (value: unknown, path: string): Array<[string, string]> => {
  if (!value || typeof value !== "object") return [];
  if ("url" in value && "sha256" in value && typeof value.url === "string" && typeof value.sha256 === "string") {
    return [[path, value.url]];
  }
  return Object.entries(value).flatMap(([key, child]) => hashedAssetEntries(child, `${path}.${key}`));
};

const validateImmutableAssetUrls = (manifest: WorkerReleaseManifest, workerTag: string): void => {
  const prefix = `/Snazzie/MARS/releases/download/${workerTag}/`;
  for (const [platform, release] of Object.entries(manifest.platforms)) {
    if (!release) continue;
    for (const [field, assetUrl] of hashedAssetEntries(release, `${platform}`)) {
      let candidate: URL;
      try { candidate = new URL(assetUrl); } catch { throw new Error(`worker release asset URL for ${field} is invalid: ${assetUrl}`); }
      const filename = candidate.pathname.toLowerCase().startsWith(prefix.toLowerCase()) ? candidate.pathname.slice(prefix.length) : "";
      if (
        candidate.origin !== immutableReleaseOrigin
        || candidate.username
        || candidate.password
        || candidate.search
        || candidate.hash
        || !filename
        || filename.includes("/")
      ) {
        throw new Error(`worker release asset URL for ${field} is outside immutable ${workerTag} release: ${assetUrl}`);
      }
    }
  }
};

const developmentAsset = async (value: unknown): Promise<{ url: string; sha256: string } | undefined> => {
  if (typeof value === "string" || value instanceof URL) value = { path: value };
  if (!value || typeof value !== "object") return undefined;
  const artifact = value as { path?: string | URL; url?: string; sha256?: string };
  if (artifact.url && artifact.sha256) return { url: artifact.url, sha256: artifact.sha256 };
  if (!artifact.path) return undefined;
  const file = Bun.file(artifact.path);
  if (!await file.exists()) return undefined;
  const sha256 = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
  return { url: `https://local.invalid/${encodeURIComponent(basename(String(artifact.path)))}`, sha256 };
};

const withDevelopmentWindowsRelease = async (manifest: WorkerReleaseManifest, development: DevelopmentWorkerRelease): Promise<WorkerReleaseManifest> => {
  if (manifest.platforms["windows-x64"] !== null) return manifest;
  const source = development.windows as Record<string, unknown>;
  const orchestrator = await developmentAsset(source.orchestrator);
  const serviceHost = await developmentAsset(source.serviceHost);
  if (!orchestrator || !serviceHost) return manifest;
  const containerSource = source.container as Record<string, unknown> | undefined;
  const windows = {
    installer: await developmentAsset(source.installer),
    orchestrator,
    serviceHost,
    jobAgent: await developmentAsset(source.jobAgent),
    container: containerSource ? {
      ...containerSource,
      runner: await developmentAsset(containerSource.runner),
      git: await developmentAsset(containerSource.git),
      vcRuntime: await developmentAsset(containerSource.vcRuntime),
      buildScript: await developmentAsset(containerSource.buildScript),
      verifyScript: await developmentAsset(containerSource.verifyScript),
      containerfile: await developmentAsset(containerSource.containerfile),
      entrypoint: await developmentAsset(containerSource.entrypoint),
    } : undefined,
  };
  try { return WorkerReleaseManifest.parse({ ...manifest, platforms: { ...manifest.platforms, "windows-x64": windows } }); }
  catch { return manifest; }
};

let loaded: Promise<WorkerReleaseManifest> | undefined;

/** Load and validate one immutable worker release manifest. */
export function loadWorkerReleaseManifest(
  source?: string | URL,
  _development?: DevelopmentWorkerRelease,
  options: WorkerReleaseLoadOptions = {},
): Promise<WorkerReleaseManifest> {
  const production = Bun.env.NODE_ENV === "production";
  const configured = source ?? (production ? configuredManifestUrl() : undefined);
  const resolvedSource = configured ?? new URL("../../../deploy/control-plane/release-manifest.json", import.meta.url);
  const url = remoteUrl(resolvedSource);
  const fetcher = options.fetch ?? fetch;
  const controlPlaneVersion = options.controlPlaneVersion ?? configuredContractVersion();
  const enforceCompatibility = production || options.controlPlaneVersion !== undefined || url !== undefined;
  const load = async (): Promise<WorkerReleaseManifest> => {
    const workerTag = url ? immutableWorkerTag(url) : undefined;
    if (production) {
      if (!configuredManifestUrl() && source === undefined) throw new Error("MARS_WORKER_RELEASE_MANIFEST_URL is required");
      if (!configuredContractVersion() && options.controlPlaneVersion === undefined) throw new Error("MARS_WORKER_CONTRACT_VERSION is required");
      if (!workerTag) {
        throw new Error(`worker release manifest URL must be the immutable worker-v<version> HTTPS release path: ${String(resolvedSource)}`);
      }
    } else if (url && !workerTag) {
      throw new Error(`worker release manifest URL must be the immutable worker-v<version> HTTPS release path: ${String(resolvedSource)}`);
    }
    let raw: unknown;
    if (url) {
      if (url.protocol !== "https:") throw new Error(`worker release manifest URL must use HTTPS: ${url.href}`);
      let response: Response;
      try { response = await fetcher(url); } catch (error) { throw new Error(`worker release manifest network request failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (!response.ok) throw new Error(`worker release manifest request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      try { raw = await response.json(); } catch (error) { throw new Error(`worker release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    } else {
      const file = Bun.file(resolvedSource);
      if (!await file.exists()) throw new Error(`worker release manifest is unavailable: ${String(resolvedSource)}`);
      try { raw = await file.json(); } catch (error) { throw new Error(`worker release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    }
    let manifest: WorkerReleaseManifest;
    try { manifest = WorkerReleaseManifest.parse(raw); } catch (error) { throw new Error(`worker release manifest schema validation failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (workerTag) validateImmutableAssetUrls(manifest, workerTag);
    if (enforceCompatibility) {
      const compatibilityVersion = controlPlaneVersion || manifest.contractVersion;
      try { parseContractVersion(compatibilityVersion); parseContractVersion(manifest.contractVersion); }
      catch (error) { throw new Error(`worker release manifest has an invalid contract version: ${error instanceof Error ? error.message : String(error)}`); }
      if (!isWorkerContractCompatible(compatibilityVersion, manifest.contractVersion)) throw new Error(`worker release contract ${manifest.contractVersion} is incompatible with control-plane contract ${compatibilityVersion}`);
      if (manifest.platforms["linux-x64"] === null) throw new Error("worker release manifest does not provide a linux-x64 release");
    }
    return _development ? await withDevelopmentWindowsRelease(manifest, _development) : manifest;
  };
  if (production && source === undefined && _development === undefined) { loaded ??= load(); return loaded; }
  return load();
}

export function workerReleasePlatform<T extends WorkerReleasePlatform>(manifest: WorkerReleaseManifest, platform: T): WorkerReleaseManifest["platforms"][T] {
  return manifest.platforms[platform];
}
