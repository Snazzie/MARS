import { CURRENT_WORKER_CONTRACT_VERSION, WorkerReleaseManifest, WorkerReleaseVersion, compareWorkerReleaseVersions, isWorkerContractCompatible, parseWorkerContractVersion, type WorkerReleasePlatform } from "@mars/contracts";
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

export const parseContractVersion = parseWorkerContractVersion;
export { isWorkerContractCompatible };

const remoteUrl = (source: string | URL): URL | undefined => {
  let candidate: URL;
  try { candidate = source instanceof URL ? source : new URL(source); } catch { return undefined; }
  return candidate.protocol === "http:" || candidate.protocol === "https:" ? candidate : undefined;
};

const immutableWorkerTag = (url: URL): string | undefined => {
  if (url.origin !== immutableReleaseOrigin || url.username || url.password || url.search || url.hash) return undefined;
  return immutableManifestPath.exec(url.pathname)?.[1];
};

export type WorkerReleaseAsset = { field: string; url: string; sha256: string };
const hashedAssetEntries = (value: unknown, path: string): WorkerReleaseAsset[] => {
  if (!value || typeof value !== "object") return [];
  if ("url" in value && "sha256" in value && typeof value.url === "string" && typeof value.sha256 === "string") {
    return [{ field: path, url: value.url, sha256: value.sha256 }];
  }
  return Object.entries(value).flatMap(([key, child]) => hashedAssetEntries(child, `${path}.${key}`));
};

export function enumerateWorkerReleaseAssets(manifest: WorkerReleaseManifest): WorkerReleaseAsset[] {
  return Object.entries(manifest.platforms).flatMap(([platform, release]) => release ? hashedAssetEntries(release, platform) : []);
}

const validateImmutableAssetUrls = (manifest: WorkerReleaseManifest, workerTag: string): void => {
  const prefix = `/Snazzie/MARS/releases/download/${workerTag}/`;
  for (const { field, url: assetUrl } of enumerateWorkerReleaseAssets(manifest)) {
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
    return _development ? await withDevelopmentWindowsRelease(manifest, _development) : manifest;
  };
  if (production && source === undefined && _development === undefined) { loaded ??= load(); return loaded; }
  return load();
}

export type WorkerReleaseTarget = { releaseVersion: WorkerReleaseVersion; manifestUrl: string; manifest: WorkerReleaseManifest };
export class WorkerReleaseCatalogUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "WorkerReleaseCatalogUnavailable"; }
}
type ReleaseCatalogOptions = {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  cacheTtlMs?: number;
  manifestLoader?: typeof loadWorkerReleaseManifest;
  controlPlaneContractVersion?: string;
};
type GithubRelease = { draft?: boolean; prerelease?: boolean; tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
const releaseTag = /^worker-(\d+\.\d+\.\d+)$/;
const releaseManifestUrl = (version: string): string => `https://github.com/Snazzie/MARS/releases/download/worker-v${version}/worker-release-manifest.json`;
const releaseVersionFromTag = (tag: string): WorkerReleaseVersion | undefined => {
  const value = tag.match(/^worker-v(.+)$/)?.[1];
  return value && WorkerReleaseVersion.safeParse(value).success ? value : undefined;
};

export class WorkerReleaseCatalog {
  private readonly fetcher: NonNullable<ReleaseCatalogOptions["fetch"]>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly loader: typeof loadWorkerReleaseManifest;
  private readonly controlPlaneContractVersion: string;
  private releasesCache?: { expiresAt: number; releases: GithubRelease[] };
  private releasesFlight?: Promise<GithubRelease[]>;
  private readonly targetCache = new Map<string, { expiresAt: number; target: WorkerReleaseTarget }>();
  private readonly targetFlights = new Map<string, Promise<WorkerReleaseTarget>>();
  constructor(options: ReleaseCatalogOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.controlPlaneContractVersion = options.controlPlaneContractVersion ?? (configuredContractVersion() || (Bun.env.NODE_ENV === "production" ? "" : CURRENT_WORKER_CONTRACT_VERSION));
    this.loader = options.manifestLoader ?? loadWorkerReleaseManifest;
    parseWorkerContractVersion(this.controlPlaneContractVersion);
  }
  private async releases(): Promise<GithubRelease[]> {
    const cached = this.releasesCache;
    if (cached && cached.expiresAt > this.now()) return cached.releases;
    if (this.releasesFlight) return this.releasesFlight;
    this.releasesFlight = this.fetchReleasePages().then(releases => {
      this.releasesCache = { releases, expiresAt: this.now() + this.ttlMs };
      return releases;
    }).finally(() => { this.releasesFlight = undefined; });
    return this.releasesFlight;
  }
  private async fetchReleasePages(): Promise<GithubRelease[]> {
    const releases: GithubRelease[] = [];
    let url = new URL("https://api.github.com/repos/Snazzie/MARS/releases?per_page=100");
    try {
      for (;;) {
        const response = await this.fetcher(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "mars-control-plane" } });
        if (!response.ok) throw new Error(`GitHub releases request failed with HTTP ${response.status}`);
        const page = await response.json() as unknown;
        if (!Array.isArray(page)) throw new Error("GitHub releases response is invalid");
        releases.push(...page as GithubRelease[]);
        const next = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/i)?.[1];
        if (!next) return releases;
        url = new URL(next);
      }
    } catch (error) {
      throw new WorkerReleaseCatalogUnavailable(`worker release catalog unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  private async target(version: WorkerReleaseVersion, manifestUrl = releaseManifestUrl(version)): Promise<WorkerReleaseTarget> {
    const cached = this.targetCache.get(version);
    if (cached && cached.expiresAt > this.now()) return cached.target;
    const flight = this.targetFlights.get(version);
    if (flight) return flight;
    const pending = this.loader(manifestUrl, undefined, { fetch: this.fetcher }).then(manifest => {
      const target = { releaseVersion: version, manifestUrl, manifest };
      this.targetCache.set(version, { target, expiresAt: this.now() + this.ttlMs });
      return target;
    }).finally(() => this.targetFlights.delete(version));
    this.targetFlights.set(version, pending);
    return pending;
  }
  async defaultRelease(): Promise<WorkerReleaseTarget> {
    const url = configuredManifestUrl() || DEFAULT_WORKER_RELEASE_MANIFEST_URL;
    if (!url) throw new WorkerReleaseCatalogUnavailable("default worker release manifest is not configured");
    const version = immutableWorkerTag(new URL(url))?.replace(/^worker-v/, "");
    if (!version || !WorkerReleaseVersion.safeParse(version).success) throw new WorkerReleaseCatalogUnavailable("default worker release manifest URL has no valid release tag");
    return this.target(version, url);
  }
  async release(version: string): Promise<WorkerReleaseTarget> {
    const parsed = WorkerReleaseVersion.parse(version);
    return this.target(parsed);
  }
  async findNextCompatible(currentReleaseVersion: string, platform: WorkerReleasePlatform): Promise<WorkerReleaseTarget | null> {
    const current = WorkerReleaseVersion.parse(currentReleaseVersion);
    const candidates = (await this.releases())
      .map(release => ({ release, version: release.tag_name ? releaseVersionFromTag(release.tag_name) : undefined }))
      .filter((entry): entry is { release: GithubRelease; version: WorkerReleaseVersion } => Boolean(entry.version) && entry.release.draft === false && entry.release.prerelease === false)
      .filter(entry => compareWorkerReleaseVersions(entry.version, current) > 0)
      .sort((left, right) => compareWorkerReleaseVersions(left.version, right.version));
    for (const candidate of candidates) {
      try {
        const target = await this.target(candidate.version);
        if (target.manifest.platforms[platform] && isWorkerContractCompatible(this.controlPlaneContractVersion, target.manifest.contractVersion)) return target;
      } catch {
        continue;
      }
    }
    return null;
  }
}

export function workerReleasePlatform<T extends WorkerReleasePlatform>(manifest: WorkerReleaseManifest, platform: T): WorkerReleaseManifest["platforms"][T] {
  return manifest.platforms[platform];
}
