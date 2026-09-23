import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, basename, isAbsolute } from "node:path";

export type LeasePickupState = { paused: boolean; activeCount: number };
export type LeasePickupStateController = {
  readonly acceptingLeases: boolean;
  subscribe(listener: (acceptingLeases: boolean) => void): () => void;
  close(): Promise<void>;
};

const parseState = (value: unknown): LeasePickupState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lease pickup state must be an object");
  const object = value as Record<string, unknown>;
  if ((object.paused !== true && object.paused !== false) || Object.keys(object).some(key => key !== "paused" && key !== "activeCount")) throw new Error("lease pickup state has invalid fields");
  const activeCount = typeof object.activeCount === "undefined" ? 0 : object.activeCount;
  if (typeof activeCount !== "number" || !Number.isInteger(activeCount) || activeCount < 0) throw new Error("lease pickup state activeCount must be a non-negative integer");
  return { paused: object.paused, activeCount };
};

const readState = async (path: string): Promise<LeasePickupState> => {
  try {
    return parseState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paused: false, activeCount: 0 };
    console.error("Lease pickup state unreadable; failing closed", { path, error: error instanceof Error ? error.message : String(error) });
    return { paused: true, activeCount: 0 };
  }
};

export async function readLeasePickupState(path: string): Promise<boolean> {
  return !(await readState(path)).paused;
}

const pendingWrites = new Map<string, Promise<void>>();
export function writeLeasePickupState(path: string, acceptingLeases: boolean, activeCount = 0): Promise<void> {
  const previous = pendingWrites.get(path);
  const write = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ paused: !acceptingLeases, activeCount }), { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch (error) {
      await Bun.file(temporary).delete().catch(() => {});
      throw error;
    }
  });
  pendingWrites.set(path, write);
  const clear = () => { if (pendingWrites.get(path) === write) pendingWrites.delete(path); };
  void write.then(clear, clear);
  return write;
}

export async function openLeasePickupState(path: string): Promise<LeasePickupStateController> {
  if (!isAbsolute(path)) throw new Error("lease pickup state path must be absolute");
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") await writeLeasePickupState(path, true);
  }
  let acceptingLeases = !(await readState(path)).paused;
  const listeners = new Set<(acceptingLeases: boolean) => void>();
  let closed = false;
  let loading: Promise<void> | undefined;
  const reload = async () => {
    if (closed) return;
    if (loading) return loading;
    loading = (async () => {
      const next = !(await readState(path)).paused;
      if (next !== acceptingLeases) {
        acceptingLeases = next;
        for (const listener of listeners) listener(next);
      }
    })().finally(() => { loading = undefined; });
    return loading;
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(path), () => { void reload(); });
  } catch (error) {
    console.error("Lease pickup state watcher unavailable", { path, error: error instanceof Error ? error.message : String(error) });
  }
  const timer = setInterval(() => { void reload(); }, 5_000);
  return {
    get acceptingLeases() { return acceptingLeases; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      watcher?.close();
      listeners.clear();
      await loading;
    },
  };
}

export const leasePickupStateFile = () => Bun.env.MARS_LEASE_PICKUP_STATE_FILE ?? `${Bun.env.HOME ?? "."}/Library/Application Support/Mars/lease-pickup.json`;
export const leasePickupStateFilename = (path: string) => basename(path);
