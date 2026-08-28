import { WorkerReleaseManifest, type WorkerReleasePlatform } from "@mars/contracts";

const packagedManifest = (): string | URL =>
  Bun.env.WORKER_RELEASE_MANIFEST?.trim() ||
  (Bun.env.NODE_ENV === "production" ? "/app/release-manifest.json" : new URL("../../../deploy/control-plane/release-manifest.json", import.meta.url));

let loaded: Promise<WorkerReleaseManifest> | undefined;

/** Load and validate the immutable release manifest once during control-plane startup. */
export function loadWorkerReleaseManifest(source: string | URL = packagedManifest()): Promise<WorkerReleaseManifest> {
  loaded ??= (async () => {
    const file = Bun.file(source);
    if (!await file.exists()) throw new Error(`worker release manifest is unavailable: ${String(source)}`);
    let raw: unknown;
    try {
      raw = await file.json();
    } catch (error) {
      throw new Error(`worker release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return WorkerReleaseManifest.parse(raw);
  })();
  return loaded;
}

export function workerReleasePlatform<T extends WorkerReleasePlatform>(manifest: WorkerReleaseManifest, platform: T): WorkerReleaseManifest["platforms"][T] {
  return manifest.platforms[platform];
}
