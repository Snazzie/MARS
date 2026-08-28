import { createHash } from "node:crypto";
import { WorkerReleaseManifest, type WorkerReleasePlatform, type WindowsWorkerRelease } from "@mars/contracts";

export type DevelopmentWindowsRelease = Omit<WindowsWorkerRelease, "orchestratorSha256" | "serviceHostSha256"> & {
  orchestrator: string | URL;
  serviceHost: string | URL;
};

export type DevelopmentWorkerRelease = {
  windows: DevelopmentWindowsRelease;
};

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
  (Bun.env.NODE_ENV === "production" ? "/app/release-manifest.json" : new URL("../../../deploy/control-plane/release-manifest.json", import.meta.url));


let loaded: Promise<WorkerReleaseManifest> | undefined;

/** Load and validate the immutable release manifest once during control-plane startup. */
export function loadWorkerReleaseManifest(source?: string | URL, development?: DevelopmentWorkerRelease): Promise<WorkerReleaseManifest> {
  const resolvedSource = source ?? packagedManifest();
  const load = async (): Promise<WorkerReleaseManifest> => {
    const file = Bun.file(resolvedSource);
    if (!await file.exists()) throw new Error(`worker release manifest is unavailable: ${String(resolvedSource)}`);
    let raw: unknown;
    try {
      raw = await file.json();
    } catch (error) {
      throw new Error(`worker release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const manifest = WorkerReleaseManifest.parse(raw);
    return development ? await withDevelopmentWindowsRelease(manifest, development) : manifest;
  };
  // Explicit development sources are intentionally not cached: callers may
  // provide a freshly built local artifact set during a dev restart.
  if (development || source !== undefined) return load();
  loaded ??= load();
  return loaded;
}


export function workerReleasePlatform<T extends WorkerReleasePlatform>(manifest: WorkerReleaseManifest, platform: T): WorkerReleaseManifest["platforms"][T] {
  return manifest.platforms[platform];
}
