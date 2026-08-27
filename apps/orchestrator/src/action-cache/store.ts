import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import type { WorkerCacheEntryProjection } from "@mars/contracts";

const SCHEMA_VERSION = 1;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
type Environment = Record<string, string | undefined>;
type Clock = () => Date;

type EntryRow = {
  entryId: string;
  githubRepositoryId: string;
  scope: string;
  cacheKey: string;
  version: string;
  archivePathId: string;
  sizeBytes: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  expiresAt: string;
};

type PartRow = { pathId: string };

export type ReservedCacheEntry = { entryId: string; archivePath: string; expiresAt: string };
export type ReserveCacheEntryInput = { githubRepositoryId: string; scope: string; cacheKey: string; version: string };
export type CacheStoreEntry = { entryId: string; cacheKey: string; version: string; sizeBytes: string; expiresAt: string; archivePath: string };
export type CacheStoreUploadPart = { partNumber: number; blockId: string; path: string; sizeBytes: string };
export type ActionCacheMutation = { type: "worker.cache_entry_upsert"; payload: { generation: string; entry: WorkerCacheEntryProjection } } | { type: "worker.cache_entry_deleted"; payload: { generation: string; entryId: string } };

export interface ActionCacheStore {
  readonly root: string;
  readonly generation: string;
  readonly journalMode: string;
  readonly ttlSeconds: number;
  reserveEntry(input: ReserveCacheEntryInput): Promise<ReservedCacheEntry | null>;
  writeArchive(entryId: string, bytes: Uint8Array): Promise<string>;
  writeUploadPart(entryId: string, partNumber: number, blockId: string, bytes: Uint8Array): Promise<string>;
  writeUploadPartStream(entryId: string, partNumber: number, blockId: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string>;
  findReady(input: { githubRepositoryId: string; scopes: string[]; cacheKey: string; restoreKeys: string[]; version: string }): Promise<CacheStoreEntry | null>;
  findUploading(input: { githubRepositoryId: string; scope: string; cacheKey: string; version: string }): Promise<CacheStoreEntry | null>;
  touchReady(entryId: string): Promise<CacheStoreEntry>;
  archiveForEntry(entryId: string): Promise<string | null>;
  listUploadParts(entryId: string): Promise<CacheStoreUploadPart[]>;
  assembleUpload(entryId: string, orderedBlockIds: string[]): Promise<void>;
  markReady(entryId: string, sizeBytes: bigint): Promise<void>;
  applyTtl(ttlSeconds: number): Promise<void>;
  setTelemetrySink(sink: ((type: ActionCacheMutation["type"], payload: Record<string, unknown>) => void) | null): void;
  status(): { sizeBytes: string; entryCount: number };
  sweep(): Promise<void>;
  snapshotPages(pageSize: number): AsyncIterable<WorkerCacheEntryProjection[]>;
  persistentSecretPath(label: string, extension: ".key" | ".crt"): string;
  probe(): Promise<void>;
  close(): Promise<void>;
}

function validateActionCacheRoot(value: string, platform: NodeJS.Platform): string {
  const root = value.trim();
  if (/[\0\r\n]/.test(root)) throw new Error("action cache root is invalid");
  if (!(platform === "win32" ? win32 : posix).isAbsolute(root)) throw new Error("action cache root must be absolute");
  return root;
}

export function resolveActionCacheRoot(env: Environment = Bun.env, platform: NodeJS.Platform = process.platform): string {
  let root: string;
  if (env.MARS_ACTION_CACHE_ROOT?.trim()) root = env.MARS_ACTION_CACHE_ROOT;
  else if (platform === "win32") root = win32.join(env.ProgramData?.trim() || "C:\\ProgramData", "Mars", "action-cache");
  else if (platform === "darwin") root = posix.join(env.HOME?.trim() || "/Users/Shared", "Library/Application Support/Mars/action-cache");
  else root = "/var/lib/mars/action-cache";
  return validateActionCacheRoot(root, platform);
}

let currentWindowsSid: string | null = null;

export async function secureWorkerPrivatePath(path: string, directory = false, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  if (!currentWindowsSid) {
    const identity = Bun.spawnSync(["whoami.exe", "/user", "/fo", "csv", "/nh"]);
    const output = new TextDecoder().decode(identity.stdout);
    currentWindowsSid = output.match(/S-\d+(?:-\d+)+/)?.[0] ?? null;
    if (identity.exitCode !== 0 || !currentWindowsSid) throw new Error("could not resolve the worker Windows security identifier");
  }
  const permission = directory ? "(OI)(CI)F" : "F";
  const grants = [`*${currentWindowsSid}:${permission}`];
  if (currentWindowsSid !== "S-1-5-18") grants.push(`*S-1-5-18:${permission}`);
  const result = Bun.spawnSync(["icacls.exe", path, "/inheritance:r", "/grant:r", ...grants]);
  if (result.exitCode !== 0) throw new Error(`could not secure worker-private cache path: ${new TextDecoder().decode(result.stderr).trim()}`);
}

async function syncObjectDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function requireTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("cache TTL must be a positive safe integer");
}

function requireRepositoryId(value: string): void {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > MAX_SIGNED_INT64) throw new Error("GitHub repository ID must be a positive decimal int64");
}

function expiryFrom(value: string, ttlSeconds: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("cache timestamp is invalid");
  return new Date(timestamp + ttlSeconds * 1_000).toISOString();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function preview(value: string): string {
  return [...value.replace(/[\p{Cc}\p{Cs}]/gu, "")].slice(0, 160).join("");
}

function project(row: EntryRow): WorkerCacheEntryProjection {
  return {
    entryId: row.entryId,
    githubRepositoryId: row.githubRepositoryId,
    cacheKeyPreview: preview(row.cacheKey),
    cacheKeyHash: hash(row.cacheKey),
    scopePreview: preview(row.scope),
    scopeHash: hash(row.scope),
    versionHash: hash(row.version),
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    lastAccessedAt: row.lastAccessedAt,
    expiresAt: row.expiresAt,
  };
}
class SqliteActionCacheStore implements ActionCacheStore {
  readonly generation: string;
  readonly journalMode: string;
  readonly #db: Database;
  readonly #now: Clock;
  readonly #removeFile: (path: string, options?: { force?: boolean }) => Promise<void>;
  readonly #syncDirectory: (path: string) => Promise<void>;
  #ttlSeconds: number;
  #closed = false;
  #telemetrySink: ((type: ActionCacheMutation["type"], payload: Record<string, unknown>) => void) | null = null;

  constructor(
    readonly root: string,
    db: Database,
    ttlSeconds: number,
    now: Clock,
    removeFile: (path: string, options?: { force?: boolean }) => Promise<void>,
    syncDirectory: (path: string) => Promise<void>,
  ) {
    this.#db = db;
    this.#now = now;
    this.#removeFile = removeFile;
    this.#syncDirectory = syncDirectory;
    this.journalMode = String(this.#db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase();
    const existing = this.#db.query<{ value: string }, [string]>("SELECT value FROM cache_metadata WHERE key = ?").get("generation")?.value;
    this.generation = existing ?? randomUUID();
    if (!existing) this.#db.query("INSERT INTO cache_metadata(key,value) VALUES ('generation',?)").run(this.generation);
    const persistedTtl = Number(this.#db.query<{ value: string }, [string]>("SELECT value FROM cache_metadata WHERE key = ?").get("ttl_seconds")?.value);
    this.#ttlSeconds = Number.isSafeInteger(persistedTtl) && persistedTtl > 0 ? persistedTtl : ttlSeconds;
    if (!(Number.isSafeInteger(persistedTtl) && persistedTtl > 0)) this.#db.query("INSERT INTO cache_metadata(key,value) VALUES ('ttl_seconds',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(ttlSeconds));
  }

  setTelemetrySink(sink: ((type: ActionCacheMutation["type"], payload: Record<string, unknown>) => void) | null): void {
    this.#telemetrySink = sink;
  }
  #emitUpsert(entryId: string): void {
    if (!this.#telemetrySink) return;
    const row = this.#db.query<EntryRow, [string]>(`SELECT entry_id AS entryId,github_repository_id AS githubRepositoryId,scope,cache_key AS cacheKey,version,archive_path_id AS archivePathId,size_bytes AS sizeBytes,created_at AS createdAt,updated_at AS updatedAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM cache_entries WHERE entry_id=? AND state='ready'`).get(entryId);
    if (row) this.#telemetrySink("worker.cache_entry_upsert", { generation: this.generation, entry: project(row) });
  }
  get ttlSeconds(): number { return this.#ttlSeconds; }

  #assertOpen(): void {
    if (this.#closed) throw new Error("action cache store is closed");
  }

  #archivePath(pathId: string): string { return join(this.root, "archives", `${pathId}.archive`); }
  #partPath(pathId: string): string { return join(this.root, "blocks", `${pathId}.part`); }

  async reserveEntry(input: ReserveCacheEntryInput): Promise<ReservedCacheEntry | null> {
    this.#assertOpen();
    requireRepositoryId(input.githubRepositoryId);
    if (!input.scope || !input.cacheKey || !input.version) throw new Error("cache identity fields must not be empty");
    const entryId = randomUUID();
    const archivePathId = randomUUID();
    const now = this.#now().toISOString();
    const expiresAt = expiryFrom(now, this.#ttlSeconds);
    try {
      this.#db.query(`INSERT INTO cache_entries(
        entry_id,github_repository_id,scope,cache_key,version,state,archive_path_id,size_bytes,created_at,updated_at,last_accessed_at,expires_at
      ) VALUES (?,?,?,?,?,'uploading',?,'0',?,?,?,?)`).run(entryId, input.githubRepositoryId, input.scope, input.cacheKey, input.version, archivePathId, now, now, now, expiresAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: cache_entries.github_repository_id, cache_entries.scope, cache_entries.cache_key, cache_entries.version")) return null;
      throw error;
    }
    return { entryId, archivePath: this.#archivePath(archivePathId), expiresAt };
  }

  async writeArchive(entryId: string, bytes: Uint8Array): Promise<string> {
    this.#assertOpen();
    const row = this.#db.query<{ archivePathId: string }, [string]>("SELECT archive_path_id AS archivePathId FROM cache_entries WHERE entry_id=? AND state='uploading'").get(entryId);
    if (!row) throw new Error("uploading cache entry not found");
    const target = this.#archivePath(row.archivePathId);
    const temporary = join(this.root, "archives", `${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      await rename(temporary, target);
      await this.#syncDirectory(join(this.root, "archives"));
    } catch (error) {
      await this.#removeFile(temporary, { force: true });
      throw error;
    }
    return target;
  }

  async writeUploadPart(entryId: string, partNumber: number, blockId: string, bytes: Uint8Array): Promise<string> {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return this.writeUploadPartStream(entryId, partNumber, blockId, body, bytes.byteLength);
  }

  async writeUploadPartStream(entryId: string, partNumber: number, blockId: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
    this.#assertOpen();
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !blockId || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid cache upload part");
    const exists = this.#db.query<{ value: number }, [string]>("SELECT 1 AS value FROM cache_entries WHERE entry_id=? AND state='uploading'").get(entryId);
    if (!exists) throw new Error("uploading cache entry not found");
    const pathId = randomUUID();
    const target = this.#partPath(pathId);
    const file = await open(target, "wx", 0o600);
    let sizeBytes = 0;
    try {
      for await (const chunk of body) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maxBytes) throw new Error("cache upload block is too large");
        await file.write(chunk);
      }
      await file.sync();
    } catch (error) {
      await file.close();
      await this.#removeFile(target, { force: true });
      throw error;
    }
    await file.close();
    await this.#syncDirectory(join(this.root, "blocks"));
    try {
      this.#db.query("INSERT INTO cache_upload_parts(entry_id,part_number,block_id,path_id,size_bytes,created_at) VALUES (?,?,?,?,?,?)")
        .run(entryId, partNumber, blockId, pathId, String(sizeBytes), this.#now().toISOString());
    } catch (error) {
      await this.#removeFile(target, { force: true });
      await this.#syncDirectory(join(this.root, "blocks"));
      throw error;
    }
    return target;
  }

  async findReady(input: { githubRepositoryId: string; scopes: string[]; cacheKey: string; restoreKeys: string[]; version: string }): Promise<CacheStoreEntry | null> {
    this.#assertOpen();
    await this.sweep();
    requireRepositoryId(input.githubRepositoryId);
    const exactQuery = this.#db.prepare<EntryRow, [string, string, string, string]>(`SELECT entry_id AS entryId,github_repository_id AS githubRepositoryId,scope,cache_key AS cacheKey,version,archive_path_id AS archivePathId,size_bytes AS sizeBytes,created_at AS createdAt,updated_at AS updatedAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM cache_entries WHERE state='ready' AND github_repository_id=? AND scope=? AND cache_key=? AND version=? LIMIT 1`);
    const prefixQuery = this.#db.prepare<EntryRow, [string, string, string, string]>(`SELECT entry_id AS entryId,github_repository_id AS githubRepositoryId,scope,cache_key AS cacheKey,version,archive_path_id AS archivePathId,size_bytes AS sizeBytes,created_at AS createdAt,updated_at AS updatedAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM cache_entries WHERE state='ready' AND github_repository_id=? AND scope=? AND cache_key LIKE ? ESCAPE '\\' AND version=? ORDER BY last_accessed_at DESC LIMIT 1`);
    const result = (row: EntryRow): CacheStoreEntry => ({ entryId: row.entryId, cacheKey: row.cacheKey, version: row.version, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt, archivePath: this.#archivePath(row.archivePathId) });
    const exact = (cacheKey: string): CacheStoreEntry | null => {
      for (const scope of input.scopes) {
        const row = exactQuery.get(input.githubRepositoryId, scope, cacheKey, input.version);
        if (row) return result(row);
      }
      return null;
    };
    const prefix = (cacheKey: string): CacheStoreEntry | null => {
      const escaped = cacheKey.replace(/[\\%_]/g, "\\$&");
      for (const scope of input.scopes) {
        const row = prefixQuery.get(input.githubRepositoryId, scope, `${escaped}%`, input.version);
        if (row) return result(row);
      }
      return null;
    };
    try {
      const primary = exact(input.cacheKey) ?? prefix(input.cacheKey);
      if (primary) return primary;
      for (const restoreKey of input.restoreKeys) {
        const restored = exact(restoreKey) ?? prefix(restoreKey);
        if (restored) return restored;
      }
      return null;
    } finally {
      exactQuery.finalize();
      prefixQuery.finalize();
    }
  }

  async findUploading(input: { githubRepositoryId: string; scope: string; cacheKey: string; version: string }): Promise<CacheStoreEntry | null> {
    this.#assertOpen();
    const query = this.#db.prepare<EntryRow, [string, string, string, string]>(`SELECT entry_id AS entryId,github_repository_id AS githubRepositoryId,scope,cache_key AS cacheKey,version,archive_path_id AS archivePathId,size_bytes AS sizeBytes,created_at AS createdAt,updated_at AS updatedAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM cache_entries WHERE state IN ('uploading','blob_ready','ready') AND github_repository_id=? AND scope=? AND cache_key=? AND version=? LIMIT 1`);
    let row: EntryRow | null;
    try { row = query.get(input.githubRepositoryId, input.scope, input.cacheKey, input.version); } finally { query.finalize(); }
    return row ? { entryId: row.entryId, cacheKey: row.cacheKey, version: row.version, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt, archivePath: this.#archivePath(row.archivePathId) } : null;
  }

  async touchReady(entryId: string): Promise<CacheStoreEntry> {
    this.#assertOpen();
    const now = this.#now().toISOString();
    const result = this.#db.query("UPDATE cache_entries SET last_accessed_at=?,updated_at=?,expires_at=? WHERE entry_id=? AND state='ready' AND expires_at>?").run(now, now, expiryFrom(now, this.#ttlSeconds), entryId, now);
    if (result.changes !== 1) throw new Error("ready cache entry not found");
    const query = this.#db.prepare<EntryRow, [string]>(`SELECT entry_id AS entryId,github_repository_id AS githubRepositoryId,scope,cache_key AS cacheKey,version,archive_path_id AS archivePathId,size_bytes AS sizeBytes,created_at AS createdAt,updated_at AS updatedAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM cache_entries WHERE entry_id=? AND state='ready'`);
    let row: EntryRow | null;
    try { row = query.get(entryId); } finally { query.finalize(); }
    if (!row) throw new Error("ready cache entry not found");
    this.#emitUpsert(entryId);
    return { entryId: row.entryId, cacheKey: row.cacheKey, version: row.version, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt, archivePath: this.#archivePath(row.archivePathId) };
  }

  async archiveForEntry(entryId: string): Promise<string | null> {
    this.#assertOpen();
    const query = this.#db.prepare<{ archivePathId: string }, [string]>("SELECT archive_path_id AS archivePathId FROM cache_entries WHERE entry_id=? AND state IN ('uploading','blob_ready','ready')");
    let row: { archivePathId: string } | null;
    try { row = query.get(entryId); } finally { query.finalize(); }
    if (!row) return null;
    const path = this.#archivePath(row.archivePathId);
    try { await stat(path); return path; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async listUploadParts(entryId: string): Promise<CacheStoreUploadPart[]> {
    this.#assertOpen();
    const query = this.#db.prepare<{ partNumber: number; blockId: string; pathId: string; sizeBytes: string }, [string]>("SELECT part_number AS partNumber,block_id AS blockId,path_id AS pathId,size_bytes AS sizeBytes FROM cache_upload_parts WHERE entry_id=? ORDER BY part_number");
    let rows: Array<{ partNumber: number; blockId: string; pathId: string; sizeBytes: string }>;
    try { rows = query.all(entryId); } finally { query.finalize(); }
    return rows.map((part) => ({ partNumber: part.partNumber, blockId: part.blockId, path: this.#partPath(part.pathId), sizeBytes: part.sizeBytes }));
  }

  async assembleUpload(entryId: string, orderedBlockIds: string[]): Promise<void> {
    this.#assertOpen();
    const entryQuery = this.#db.prepare<{ archivePathId: string }, [string]>("SELECT archive_path_id AS archivePathId FROM cache_entries WHERE entry_id=? AND state='uploading'");
    let row: { archivePathId: string } | null;
    try { row = entryQuery.get(entryId); } finally { entryQuery.finalize(); }
    if (!row) throw new Error("uploading cache entry not found");
    const parts = await this.listUploadParts(entryId);
    if (parts.length !== orderedBlockIds.length) throw new Error("cache upload parts do not match block list");
    const byBlockId = new Map(parts.map((part) => [part.blockId, part]));
    const temporary = join(this.root, "archives", `${randomUUID()}.tmp`);
    const target = this.#archivePath(row.archivePathId);
    const output = await open(temporary, "wx", 0o600);
    try {
      for (const blockId of orderedBlockIds) {
        const part = byBlockId.get(blockId);
        if (!part) throw new Error("cache upload block is missing");
        for await (const chunk of Bun.file(part.path).stream()) await output.write(chunk);
      }
      await output.sync();
    } catch (error) {
      await output.close();
      await this.#removeFile(temporary, { force: true });
      throw error;
    }
    await output.close();
    try {
      await rename(temporary, target);
      await this.#syncDirectory(join(this.root, "archives"));
    } catch (error) {
      await this.#removeFile(temporary, { force: true });
      throw error;
    }
  }

  async markReady(entryId: string, sizeBytes: bigint): Promise<void> {
    this.#assertOpen();
    if (sizeBytes < 0n || sizeBytes > MAX_SIGNED_INT64) throw new Error("cache size must be a nonnegative int64");
    const row = this.#db.query<{ archivePathId: string; state: string; sizeBytes: string }, [string]>("SELECT archive_path_id AS archivePathId,state,size_bytes AS sizeBytes FROM cache_entries WHERE entry_id=? AND state IN ('uploading','blob_ready','ready')").get(entryId);
    if (!row) throw new Error("finalizable cache entry not found");
    const archive = await stat(this.#archivePath(row.archivePathId));
    if (BigInt(archive.size) !== sizeBytes) throw new Error("cache archive size mismatch");
    if (row.state === "ready") {
      if (row.sizeBytes !== String(sizeBytes)) throw new Error("cache finalization size changed");
      return;
    }
    if (row.state === "uploading") {
      const now = this.#now().toISOString();
      const result = this.#db.query("UPDATE cache_entries SET state='blob_ready',size_bytes=?,updated_at=?,last_accessed_at=?,expires_at=? WHERE entry_id=? AND state='uploading'")
        .run(String(sizeBytes), now, now, expiryFrom(now, this.#ttlSeconds), entryId);
      if (result.changes !== 1) throw new Error("cache entry state transition failed");
    } else if (row.sizeBytes !== String(sizeBytes)) {
      throw new Error("cache finalization size changed");
    }
    await this.#finishBlobReady(entryId);
    this.#emitUpsert(entryId);
  }

  async #finishBlobReady(entryId: string): Promise<void> {
    const parts = this.#db.query<PartRow, [string]>("SELECT path_id AS pathId FROM cache_upload_parts WHERE entry_id=?").all(entryId);
    for (const part of parts) await this.#removeFile(this.#partPath(part.pathId), { force: true });
    if (parts.length) await this.#syncDirectory(join(this.root, "blocks"));
    const finish = this.#db.transaction(() => {
      this.#db.query("DELETE FROM cache_upload_parts WHERE entry_id=?").run(entryId);
      const result = this.#db.query("UPDATE cache_entries SET state='ready' WHERE entry_id=? AND state='blob_ready'").run(entryId);
      if (result.changes !== 1) throw new Error("cache entry finalization failed");
    });
    finish();
  }

  async applyTtl(ttlSeconds: number): Promise<void> {
    this.#assertOpen();
    requireTtl(ttlSeconds);
    const rows = this.#db.query<{ entryId: string; lastAccessedAt: string }, []>("SELECT entry_id AS entryId,last_accessed_at AS lastAccessedAt FROM cache_entries WHERE state='ready'").all();
    const update = this.#db.query("UPDATE cache_entries SET expires_at=?,updated_at=? WHERE entry_id=? AND state='ready'");
    const updatedAt = this.#now().toISOString();
    const transaction = this.#db.transaction(() => {
      for (const row of rows) update.run(expiryFrom(row.lastAccessedAt, ttlSeconds), updatedAt, row.entryId);
      this.#db.query("INSERT INTO cache_metadata(key,value) VALUES ('ttl_seconds',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(ttlSeconds));
    });
    transaction();
    this.#ttlSeconds = ttlSeconds;
    await this.sweep();
  }

  async sweep(): Promise<void> {
    this.#assertOpen();
    const staleUploadCutoff = new Date(this.#now().getTime() - 60 * 60_000).toISOString();
    this.#db.run("UPDATE cache_entries SET state='deleting',updated_at=? WHERE state='uploading' AND updated_at<=?", [this.#now().toISOString(), staleUploadCutoff]);
    await this.#sweepExpired();
  }
  async #sweepExpired(): Promise<void> {
    const now = this.#now().toISOString();
    const selectExpired = this.#db.prepare<EntryRow, [string]>(`SELECT entry_id AS entryId,github_repository_id AS githubRepositoryId,scope,cache_key AS cacheKey,version,
      archive_path_id AS archivePathId,size_bytes AS sizeBytes,created_at AS createdAt,updated_at AS updatedAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt
      FROM cache_entries WHERE state='deleting' OR (state='ready' AND expires_at<=?)`);
    let rows: EntryRow[];
    try { rows = selectExpired.all(now); } finally { selectExpired.finalize(); }
    for (const row of rows) {
      this.#db.query("UPDATE cache_entries SET state='deleting',updated_at=? WHERE entry_id=? AND state='ready'").run(now, row.entryId);
      try {
        await this.#removeFile(this.#archivePath(row.archivePathId), { force: true });
        const parts = this.#db.query<PartRow, [string]>("SELECT path_id AS pathId FROM cache_upload_parts WHERE entry_id=?").all(row.entryId);
        for (const part of parts) await this.#removeFile(this.#partPath(part.pathId), { force: true });
        await Promise.all([this.#syncDirectory(join(this.root, "archives")), this.#syncDirectory(join(this.root, "blocks"))]);
        this.#db.query("DELETE FROM cache_entries WHERE entry_id=? AND state='deleting'").run(row.entryId);
        this.#telemetrySink?.("worker.cache_entry_deleted", { generation: this.generation, entryId: row.entryId });
      } catch {
        // The deleting row is intentionally retained so a later sweep can retry filesystem cleanup.
      }
    }
  }

  async recoverStartup(): Promise<void> {
    this.#assertOpen();
    const interrupted = this.#db.query<{ entryId: string; archivePathId: string; state: "uploading" | "blob_ready" }, []>("SELECT entry_id AS entryId,archive_path_id AS archivePathId,state FROM cache_entries WHERE state IN ('uploading','blob_ready')").all();
    for (const row of interrupted) {
      if (row.state === "blob_ready") {
        await this.#finishBlobReady(row.entryId);
        continue;
      }
      const parts = this.#db.query<PartRow, [string]>("SELECT path_id AS pathId FROM cache_upload_parts WHERE entry_id=?").all(row.entryId);
      await this.#removeFile(this.#archivePath(row.archivePathId), { force: true });
      for (const part of parts) await this.#removeFile(this.#partPath(part.pathId), { force: true });
      await Promise.all([this.#syncDirectory(join(this.root, "archives")), this.#syncDirectory(join(this.root, "blocks"))]);
      this.#db.query("DELETE FROM cache_entries WHERE entry_id=? AND state='uploading'").run(row.entryId);
    }
    await this.sweep();
    const archiveReferences = new Set(this.#db.query<{ pathId: string }, []>("SELECT archive_path_id AS pathId FROM cache_entries").all().map((row) => `${row.pathId}.archive`));
    const partReferences = new Set(this.#db.query<PartRow, []>("SELECT path_id AS pathId FROM cache_upload_parts").all().map((row) => `${row.pathId}.part`));
    for (const [directory, references] of [[join(this.root, "archives"), archiveReferences], [join(this.root, "blocks"), partReferences]] as const) {
      for (const name of await readdir(directory)) if (!references.has(name)) await this.#removeFile(join(directory, name), { force: true });
      await this.#syncDirectory(directory);
    }
    const probes = join(this.root, "probes");
    for (const name of await readdir(probes)) await this.#removeFile(join(probes, name), { force: true });
    await this.#syncDirectory(probes);
  }

  status(): { sizeBytes: string; entryCount: number } {
    this.#assertOpen();
    const query = this.#db.prepare<{ entryCount: number; sizeBytes: string }, []>("SELECT COUNT(*) AS entryCount,COALESCE(SUM(CAST(size_bytes AS INTEGER)),0) AS sizeBytes FROM cache_entries WHERE state='ready'");
    try {
      const row = query.get();
      return { entryCount: Number(row?.entryCount ?? 0), sizeBytes: String(row?.sizeBytes ?? "0") };
    } finally {
      query.finalize();
    }
  }

  async *snapshotPages(pageSize: number): AsyncIterable<WorkerCacheEntryProjection[]> {
    this.#assertOpen();
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("cache snapshot page size must be between 1 and 100");
    const query = this.#db.query<EntryRow, [string, number]>(`SELECT entry_id AS entryId,github_repository_id AS githubRepositoryId,scope,cache_key AS cacheKey,version,
      archive_path_id AS archivePathId,size_bytes AS sizeBytes,created_at AS createdAt,updated_at AS updatedAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt
      FROM cache_entries WHERE state='ready' AND entry_id>? ORDER BY entry_id LIMIT ?`);
    let cursor = "";
    for (;;) {
      const page = [...query.iterate(cursor, pageSize)];
      if (!page.length) return;
      yield page.map(project);
      cursor = page[page.length - 1]!.entryId;
    }
  }

  persistentSecretPath(label: string, extension: ".key" | ".crt"): string {
    this.#assertOpen();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(label)) throw new Error("invalid persistent secret label");
    const key = `secret-path:${label}`;
    let pathId = this.#db.query<{ value: string }, [string]>("SELECT value FROM cache_metadata WHERE key=?").get(key)?.value;
    if (!pathId) {
      pathId = randomUUID();
      this.#db.query("INSERT INTO cache_metadata(key,value) VALUES (?,?)").run(key, pathId);
    }
    return join(this.root, "secrets", `${pathId}${extension}`);
  }

  async probe(): Promise<void> {
    this.#assertOpen();
    const key = `probe:${randomUUID()}`;
    const indexProbe = this.#db.transaction(() => {
      this.#db.query("INSERT INTO cache_metadata(key,value) VALUES (?,?)").run(key, "ok");
      this.#db.query("DELETE FROM cache_metadata WHERE key=?").run(key);
    });
    indexProbe();
    const first = join(this.root, "probes", `${randomUUID()}.tmp`);
    const second = join(this.root, "probes", `${randomUUID()}.ready`);
    const file = await open(first, "wx", 0o600);
    try { await file.writeFile("ready"); await file.sync(); } finally { await file.close(); }
    await rename(first, second);
    await this.#syncDirectory(join(this.root, "probes"));
    await this.#removeFile(second, { force: true });
    await this.#syncDirectory(join(this.root, "probes"));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const database = this.#db as unknown as { clearQueryCache?: () => void; close: (force?: boolean) => void };
    database.clearQueryCache?.();
    Bun.gc(true);
    database.close(true);
  }
}

export async function openActionCacheStore(options: {
  root?: string;
  ttlSeconds: number;
  env?: Environment;
  platform?: NodeJS.Platform;
  now?: Clock;
  removeFile?: (path: string, options?: { force?: boolean }) => Promise<void>;
  syncDirectory?: (path: string) => Promise<void>;
}): Promise<ActionCacheStore> {
  requireTtl(options.ttlSeconds);
  const platform = options.platform ?? process.platform;
  const root = options.root === undefined ? resolveActionCacheRoot(options.env ?? Bun.env, platform) : validateActionCacheRoot(options.root, platform);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all(["archives", "blocks", "probes", "secrets"].map((directory) => mkdir(join(root, directory), { recursive: true, mode: 0o700 })));
  await secureWorkerPrivatePath(root, true, platform);
  const databasePath = join(root, "cache.sqlite");
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath, { create: true, strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const version = Number(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) throw new Error(`unsupported action cache schema version ${version}`);
    if (version === 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE cache_entries (
            entry_id TEXT PRIMARY KEY,
            github_repository_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            cache_key TEXT NOT NULL,
            version TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('uploading','blob_ready','ready','deleting')),
            archive_path_id TEXT NOT NULL UNIQUE,
            size_bytes TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_accessed_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            UNIQUE(github_repository_id,scope,cache_key,version)
          );
          CREATE INDEX cache_entries_expiry_idx ON cache_entries(state,expires_at);
          CREATE TABLE cache_upload_parts (
            entry_id TEXT NOT NULL REFERENCES cache_entries(entry_id) ON DELETE CASCADE,
            part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
            block_id TEXT NOT NULL,
            path_id TEXT NOT NULL UNIQUE,
            size_bytes TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(entry_id,part_number),
            UNIQUE(entry_id,block_id)
          );
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const syncDirectory = options.syncDirectory ?? ((path: string) => syncObjectDirectory(path, platform));
    const store = new SqliteActionCacheStore(root, db, options.ttlSeconds, options.now ?? (() => new Date()), options.removeFile ?? rm, syncDirectory);
    await store.recoverStartup();
    await store.applyTtl(store.ttlSeconds);
    return store;
  } catch (error) {
    db.close(true);
    throw error;
  }
}
