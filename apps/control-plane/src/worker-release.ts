import { createHash } from "node:crypto";
import { WorkerReleaseManifest, type WorkerReleasePlatform, type WindowsWorkerRelease } from "@mars/contracts";

export type DevelopmentWindowsRelease = Omit<WindowsWorkerRelease, "orchestratorSha256" | "serviceHostSha256"> & {
  orchestrator: string | URL;
  serviceHost: string | URL;
};

export type DevelopmentWorkerRelease = {
  windows: DevelopmentWindowsRelease;
};

export type WorkerReleaseLoadOptions = {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  controlPlaneVersion?: string;
};

export const DEFAULT_WORKER_RELEASE_MANIFEST_URL = "https://github.com/Snazzie/Mars/releases/latest/download/worker-release-manifest.json";
export const DEFAULT_WORKER_CONTRACT_VERSION = "0.1.0";

const artifactSha256 = async (path: string | URL): Promise<string | undefined> => {
  const file = Bun.file(path);
  if (!await file.exists()) return undefined;
  return createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
};

const withDevelopmentWindowsRelease = async (manifest: WorkerReleaseManifest, development: DevelopmentWorkerRelease): Promise<WorkerReleaseManifest> => {
  if (manifest.platforms["windows-x64"] !== null) return manifest;
  const { orchestrator, serviceHost, ...metadata } = development.windows;
  const orchestratorSha256 = await artifactSha256(orchestrator);
  const serviceHostSha256 = await artifactSha256(serviceHost);
  if (!orchestratorSha256 || !serviceHostSha256) return manifest;
  try {
    return WorkerReleaseManifest.parse({
      ...manifest,
      platforms: {
        ...manifest.platforms,
        "windows-x64": { ...metadata, orchestratorSha256, serviceHostSha256 },
      },
    });
  } catch {
    // Development metadata is optional. Keep the platform unavailable when
    // local configuration is incomplete rather than weakening manifest checks.
    return manifest;
  }
};

const packagedManifest = (): string | URL =>
  Bun.env.WORKER_RELEASE_MANIFEST?.trim() ||
  new URL("../../../deploy/control-plane/release-manifest.json", import.meta.url);

const configuredManifestUrl = (): string =>
  Bun.env.MARS_WORKER_RELEASE_MANIFEST_URL?.trim() || DEFAULT_WORKER_RELEASE_MANIFEST_URL;

const configuredContractVersion = (): string =>
  Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() || DEFAULT_WORKER_CONTRACT_VERSION;

export function parseContractVersion(value: string): { major: number; minor: number; patch: number } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`invalid contract version: ${JSON.stringify(value)} (expected major.minor.patch)`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`invalid contract version: ${JSON.stringify(value)} (numeric components are too large)`);
  }
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
  try {
    candidate = source instanceof URL ? source : new URL(source);
  } catch {
    return undefined;
  }
  return candidate.protocol === "http:" || candidate.protocol === "https:" ? candidate : undefined;
};

let loaded: Promise<WorkerReleaseManifest> | undefined;

/** Load and validate a compatible release manifest once during production startup. */
export function loadWorkerReleaseManifest(
  source?: string | URL,
  development?: DevelopmentWorkerRelease,
  options: WorkerReleaseLoadOptions = {},
): Promise<WorkerReleaseManifest> {
  const production = Bun.env.NODE_ENV === "production";
  const resolvedSource = source ?? (production ? configuredManifestUrl() : packagedManifest());
  const url = remoteUrl(resolvedSource);
  const fetcher = options.fetch ?? fetch;
  const controlPlaneVersion = options.controlPlaneVersion ?? configuredContractVersion();
  const enforceCompatibility = production || options.controlPlaneVersion !== undefined || url !== undefined;
  const load = async (): Promise<WorkerReleaseManifest> => {
    let raw: unknown;
    if (url) {
      if (url.protocol !== "https:") {
        throw new Error(`worker release manifest URL must use HTTPS: ${url.href}`);
      }
      let response: Response;
      try {
        response = await fetcher(url);
      } catch (error) {
        throw new Error(`worker release manifest network request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) {
        throw new Error(`worker release manifest request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      }
      try {
        raw = await response.json();
      } catch (error) {
        throw new Error(`worker release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      const file = Bun.file(resolvedSource);
      if (!await file.exists()) throw new Error(`worker release manifest is unavailable: ${String(resolvedSource)}`);
      try {
        raw = await file.json();
      } catch (error) {
        throw new Error(`worker release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let manifest: WorkerReleaseManifest;
    try {
      manifest = WorkerReleaseManifest.parse(raw);
    } catch (error) {
      throw new Error(`worker release manifest schema validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (enforceCompatibility) {
      try {
        parseContractVersion(controlPlaneVersion);
        parseContractVersion(manifest.contractVersion);
      } catch (error) {
        throw new Error(`worker release manifest has an invalid contract version: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isWorkerContractCompatible(controlPlaneVersion, manifest.contractVersion)) {
        throw new Error(`worker release contract ${manifest.contractVersion} is incompatible with control-plane contract ${controlPlaneVersion}`);
      }
      if (manifest.platforms["linux-x64"] === null) {
        throw new Error("worker release manifest does not provide a linux-x64 release");
      }
    }
    return development ? await withDevelopmentWindowsRelease(manifest, development) : manifest;
  };
  // Only the implicit production source is cached. Explicit sources and
  // development manifests may change during a restart or test.
  if (production && source === undefined && development === undefined) {
    loaded ??= load();
    return loaded;
  }
  return load();
}

export function workerReleasePlatform<T extends WorkerReleasePlatform>(manifest: WorkerReleaseManifest, platform: T): WorkerReleaseManifest["platforms"][T] {
  return manifest.platforms[platform];
}
