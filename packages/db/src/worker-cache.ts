import type { DatabaseClient } from "./index.ts";
import type { DashboardWorkerCacheEntry, DashboardWorkerCachePage, WorkerCacheSummary } from "@whitesmith/contracts";

type SqlDb = DatabaseClient;
type CacheEntry = {
  entryId: string; githubRepositoryId: string; cacheKeyPreview: string; cacheKeyHash: string;
  scopePreview: string; scopeHash: string; versionHash: string; sizeBytes: string;
  createdAt: string; lastAccessedAt: string; expiresAt: string;
};
type CacheStatus = { generation: string; ready: boolean; ttlSeconds: number; proxyOrigin: string; cacheBaseUrl: string; sizeBytes: string; entryCount: number; observedAt: string; error: string | null };
type TelemetryEvent = { workerId: string; type: string; payload: Record<string, unknown> };

const decimal = (value: unknown, fallback = "0") => typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : fallback;
const timestamp = (value: unknown): string => { const raw = value instanceof Date ? value.toISOString() : String(value ?? ""); const parsed = Date.parse(raw); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw; };
const text = (value: unknown) => typeof value === "string" ? value : String(value ?? "");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const entryValues = (entry: CacheEntry) => [entry.entryId, decimal(entry.githubRepositoryId), text(entry.cacheKeyPreview), text(entry.cacheKeyHash), text(entry.scopePreview), text(entry.scopeHash), text(entry.versionHash), decimal(entry.sizeBytes), timestamp(entry.createdAt), timestamp(entry.lastAccessedAt), timestamp(entry.expiresAt)];

function validEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return uuid(entry.entryId) && typeof entry.githubRepositoryId === "string" && /^(?:0|[1-9]\d*)$/.test(entry.githubRepositoryId) && typeof entry.sizeBytes === "string" && /^(?:0|[1-9]\d*)$/.test(entry.sizeBytes) && ["cacheKeyPreview", "cacheKeyHash", "scopePreview", "scopeHash", "versionHash", "createdAt", "lastAccessedAt", "expiresAt"].every((key) => typeof entry[key] === "string");
}
function validStatus(value: unknown): value is CacheStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return uuid(status.generation) && typeof status.ready === "boolean" && Number.isSafeInteger(status.ttlSeconds) && Number(status.ttlSeconds) > 0 && typeof status.proxyOrigin === "string" && typeof status.cacheBaseUrl === "string" && typeof status.sizeBytes === "string" && typeof status.entryCount === "number" && Number.isSafeInteger(status.entryCount) && status.entryCount >= 0 && typeof status.observedAt === "string" && (status.error === null || typeof status.error === "string");
}

export async function sweepWorkerCacheSnapshots(db: SqlDb, maxAgeSeconds = 86_400): Promise<void> {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) throw new Error("snapshot sweep age must be a positive safe integer");
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  await db.begin(async (tx) => {
    await tx`DELETE FROM worker_cache_snapshot_entries WHERE staged_at < ${cutoff}`;
    await tx`UPDATE worker_cache_status SET active_snapshot_id=NULL,active_snapshot_started_at=NULL WHERE active_snapshot_started_at < ${cutoff}`;
  });
}

export async function applyWorkerCacheTelemetry(db: SqlDb, input: TelemetryEvent): Promise<boolean> {
  const payload = input.payload ?? {};
  if (!uuid(input.workerId)) return false;
  if (input.type === "worker.cache_entry_upsert") {
    const entry = payload.entry;
    if (!uuid(payload.generation) || !validEntry(entry)) return false;
    const generation = payload.generation;
    const [active] = await db<{ generation?: unknown }[]>`SELECT generation FROM worker_cache_status WHERE worker_id=${input.workerId}`;
    if (typeof active?.generation === "string" && active.generation !== generation) return false;
    const values = entryValues(entry);
    await db`INSERT INTO worker_cache_entries (worker_id,entry_id,github_repository_id,cache_key_preview,cache_key_hash,scope_preview,scope_hash,version_hash,size_bytes,created_at,last_accessed_at,expires_at,observed_generation) SELECT ${input.workerId},${values[0]},${values[1]},${values[2]},${values[3]},${values[4]},${values[5]},${values[6]},${values[7]},${values[8]},${values[9]},${values[10]},${generation} FROM worker_cache_status WHERE worker_id=${input.workerId} AND generation=${generation} ON CONFLICT (worker_id,entry_id) DO UPDATE SET github_repository_id=excluded.github_repository_id,cache_key_preview=excluded.cache_key_preview,cache_key_hash=excluded.cache_key_hash,scope_preview=excluded.scope_preview,scope_hash=excluded.scope_hash,version_hash=excluded.version_hash,size_bytes=excluded.size_bytes,created_at=excluded.created_at,last_accessed_at=excluded.last_accessed_at,expires_at=excluded.expires_at,observed_generation=excluded.observed_generation WHERE worker_cache_entries.observed_generation=${generation} AND worker_cache_entries.observed_generation=(SELECT generation FROM worker_cache_status WHERE worker_id=${input.workerId})`;
    return true;
  }
  if (input.type === "worker.cache_entry_deleted") {
    if (!uuid(payload.generation) || !uuid(payload.entryId)) return false;
    const generation = payload.generation;
    const entryId = payload.entryId;
    await db`DELETE FROM worker_cache_entries WHERE worker_id=${input.workerId} AND entry_id=${entryId} AND observed_generation=${generation} AND observed_generation=(SELECT generation FROM worker_cache_status WHERE worker_id=${input.workerId})`;
    return true;
  }
  if (input.type === "worker.cache_snapshot_begin") {
    if (!uuid(payload.snapshotId) || !validStatus(payload.status)) return false;
    const snapshotId = payload.snapshotId;
    const status = payload.status;
    await sweepWorkerCacheSnapshots(db);
    await db.begin(async (tx) => {
      const [active] = await tx<{ activeSnapshotId?: unknown; lastCompletedSnapshotId?: unknown }[]>`SELECT active_snapshot_id AS "activeSnapshotId",last_completed_snapshot_id AS "lastCompletedSnapshotId" FROM worker_cache_status WHERE worker_id=${input.workerId} FOR UPDATE`;
      const lastCompletedSnapshotId: string | null = typeof active?.lastCompletedSnapshotId === "string" ? active.lastCompletedSnapshotId : null;
      if (lastCompletedSnapshotId === snapshotId && active?.activeSnapshotId == null) return;
      await tx`DELETE FROM worker_cache_snapshot_entries WHERE worker_id=${input.workerId} AND snapshot_id=${snapshotId}`;
      await tx`INSERT INTO worker_cache_status (worker_id,generation,ready,ttl_seconds,proxy_origin,cache_base_url,size_bytes,entry_count,observed_at,error,active_snapshot_id,active_snapshot_started_at,last_completed_snapshot_id) VALUES (${input.workerId},${status.generation},${status.ready},${status.ttlSeconds},${status.proxyOrigin},${status.cacheBaseUrl},${status.sizeBytes},${status.entryCount},${status.observedAt},${status.error},${snapshotId},now(),${lastCompletedSnapshotId}) ON CONFLICT (worker_id) DO UPDATE SET generation=excluded.generation,ready=excluded.ready,ttl_seconds=excluded.ttl_seconds,proxy_origin=excluded.proxy_origin,cache_base_url=excluded.cache_base_url,size_bytes=excluded.size_bytes,entry_count=excluded.entry_count,observed_at=excluded.observed_at,error=excluded.error,active_snapshot_id=excluded.active_snapshot_id,active_snapshot_started_at=excluded.active_snapshot_started_at,last_completed_snapshot_id=excluded.last_completed_snapshot_id WHERE worker_cache_status.worker_id=${input.workerId}`;
    });
    return true;
  }
  if (input.type === "worker.cache_snapshot_page") {
    if (!uuid(payload.snapshotId) || !safeInteger(payload.sequence) || payload.sequence < 0 || !Array.isArray(payload.entries) || payload.entries.length > 100 || !payload.entries.every(validEntry)) return false;
    const snapshotId = payload.snapshotId;
    const sequence = payload.sequence;
    const [active] = await db<{ activeSnapshotId?: unknown }[]>`SELECT active_snapshot_id AS "activeSnapshotId" FROM worker_cache_status WHERE worker_id=${input.workerId}`;
    if (active?.activeSnapshotId !== snapshotId) return false;
    for (const entry of payload.entries as CacheEntry[]) {
      const values = entryValues(entry);
      await db`INSERT INTO worker_cache_snapshot_entries (worker_id,snapshot_id,sequence,entry_id,github_repository_id,cache_key_preview,cache_key_hash,scope_preview,scope_hash,version_hash,size_bytes,created_at,last_accessed_at,expires_at,observed_generation,staged_at) VALUES (${input.workerId},${snapshotId},${sequence},${values[0]},${values[1]},${values[2]},${values[3]},${values[4]},${values[5]},${values[6]},${values[7]},${values[8]},${values[9]},${values[10]},(SELECT generation FROM worker_cache_status WHERE worker_id=${input.workerId}),now()) ON CONFLICT DO NOTHING`;
    }
    return true;
  }
  if (input.type === "worker.cache_snapshot_end") {
    if (!uuid(payload.snapshotId) || !safeInteger(payload.pageCount) || payload.pageCount < 0 || !safeInteger(payload.entryCount) || payload.entryCount < 0 || typeof payload.sizeBytes !== "string" || !/^(?:0|[1-9]\d*)$/.test(payload.sizeBytes)) return false;
    const snapshotId = payload.snapshotId;
    const pageCount = payload.pageCount;
    const entryCount = payload.entryCount;
    const sizeBytes = payload.sizeBytes;
    await sweepWorkerCacheSnapshots(db);
    return await db.begin(async (tx) => {
      const [active] = await tx<{ activeSnapshotId?: unknown; lastCompletedSnapshotId?: unknown }[]>`SELECT active_snapshot_id AS "activeSnapshotId",last_completed_snapshot_id AS "lastCompletedSnapshotId" FROM worker_cache_status WHERE worker_id=${input.workerId} FOR UPDATE`;
      if (active?.lastCompletedSnapshotId === snapshotId && active.activeSnapshotId == null) return true;
      if (active?.activeSnapshotId !== snapshotId) return false;
      const pages = await tx`SELECT count(DISTINCT sequence)::int AS count FROM worker_cache_snapshot_entries WHERE worker_id=${input.workerId} AND snapshot_id=${snapshotId}`;
      const count = Number(pages[0]?.count ?? 0);
      const rows = await tx`SELECT count(*)::int AS count FROM worker_cache_snapshot_entries WHERE worker_id=${input.workerId} AND snapshot_id=${snapshotId}`;
      if (count !== pageCount || Number(rows[0]?.count ?? 0) !== entryCount) {
        await tx`DELETE FROM worker_cache_snapshot_entries WHERE worker_id=${input.workerId} AND snapshot_id=${snapshotId}`;
        await tx`UPDATE worker_cache_status SET active_snapshot_id=NULL,active_snapshot_started_at=NULL WHERE worker_id=${input.workerId} AND active_snapshot_id=${snapshotId}`;
        return false;
      }
      await tx`DELETE FROM worker_cache_entries WHERE worker_id=${input.workerId}`;
      await tx`INSERT INTO worker_cache_entries (worker_id,entry_id,github_repository_id,cache_key_preview,cache_key_hash,scope_preview,scope_hash,version_hash,size_bytes,created_at,last_accessed_at,expires_at,observed_generation) SELECT worker_id,entry_id,github_repository_id,cache_key_preview,cache_key_hash,scope_preview,scope_hash,version_hash,size_bytes,created_at,last_accessed_at,expires_at,observed_generation FROM worker_cache_snapshot_entries WHERE worker_id=${input.workerId} AND snapshot_id=${snapshotId}`;
      await tx`UPDATE worker_cache_status SET size_bytes=${sizeBytes},entry_count=${entryCount},observed_at=now(),active_snapshot_id=NULL,active_snapshot_started_at=NULL,last_completed_snapshot_id=${snapshotId} WHERE worker_id=${input.workerId} AND active_snapshot_id=${snapshotId}`;
      await tx`DELETE FROM worker_cache_snapshot_entries WHERE worker_id=${input.workerId} AND snapshot_id=${snapshotId}`;
      return true;
    });
  }
  return false;
}

export function encodeWorkerCacheCursor(value: { lastAccessedAt: string; entryId: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
export function decodeWorkerCacheCursor(value: string): { lastAccessedAt: string; entryId: string } {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error("Invalid cursor");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("Invalid cursor"); }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid cursor");
  const candidate = parsed as { lastAccessedAt?: unknown; entryId?: unknown };
  if (typeof candidate.lastAccessedAt !== "string" || !uuid(candidate.entryId) || Number.isNaN(Date.parse(candidate.lastAccessedAt))) throw new Error("Invalid cursor");
  return { lastAccessedAt: candidate.lastAccessedAt, entryId: candidate.entryId };
}
function normalizeEntry(row: Record<string, unknown>): DashboardWorkerCacheEntry {
  const fullName = row.repositoryFullName == null ? null : String(row.repositoryFullName);
  return { entryId: text(row.entryId), githubRepositoryId: decimal(row.githubRepositoryId), repositoryFullName: fullName, repositoryUrl: fullName ? `https://github.com/${fullName}` : null, cacheKeyPreview: text(row.cacheKeyPreview), cacheKeyHash: text(row.cacheKeyHash), scopePreview: text(row.scopePreview), scopeHash: text(row.scopeHash), versionHash: text(row.versionHash), sizeBytes: decimal(row.sizeBytes), createdAt: timestamp(row.createdAt), lastAccessedAt: timestamp(row.lastAccessedAt), expiresAt: timestamp(row.expiresAt) };
}
export async function listWorkerCacheEntries(db: SqlDb, workerId: string, options: { cursor?: string | null; limit?: number; query?: string } = {}): Promise<DashboardWorkerCachePage> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const cursor = options.cursor ? decodeWorkerCacheCursor(options.cursor) : null;
  const query = options.query?.trim() ?? "";
  const rows = await db<Record<string, unknown>[]>`SELECT e.entry_id AS "entryId",e.github_repository_id AS "githubRepositoryId",r.full_name AS "repositoryFullName",e.cache_key_preview AS "cacheKeyPreview",e.cache_key_hash AS "cacheKeyHash",e.scope_preview AS "scopePreview",e.scope_hash AS "scopeHash",e.version_hash AS "versionHash",e.size_bytes AS "sizeBytes",e.created_at AS "createdAt",e.last_accessed_at AS "lastAccessedAt",e.expires_at AS "expiresAt" FROM worker_cache_entries e LEFT JOIN dashboard_repositories r ON r.github_repository_id=e.github_repository_id WHERE e.worker_id=${workerId} AND (${cursor?.lastAccessedAt ?? null}::timestamptz IS NULL OR (e.last_accessed_at,e.entry_id)<(${cursor?.lastAccessedAt ?? null}::timestamptz,${cursor?.entryId ?? null}::uuid)) AND (${query}='' OR lower(COALESCE(r.full_name,'')) LIKE lower(${"%" + query + "%"}) OR lower(e.cache_key_preview) LIKE lower(${"%" + query + "%"}) OR lower(e.scope_preview) LIKE lower(${"%" + query + "%"}) OR e.cache_key_hash=${query} OR e.scope_hash=${query} OR e.version_hash=${query}) ORDER BY e.last_accessed_at DESC,e.entry_id LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map(normalizeEntry);
  return { items, nextCursor: rows.length > limit && items.length ? encodeWorkerCacheCursor({ lastAccessedAt: items.at(-1)!.lastAccessedAt, entryId: items.at(-1)!.entryId }) : null };
}

export async function getWorkerCacheSummary(db: SqlDb, workerId: string, desiredTtlSeconds = 172800): Promise<WorkerCacheSummary> {
  const [row] = await db<Record<string, unknown>[]>`SELECT desired_configuration AS "desiredConfiguration",s.generation,s.ready,s.ttl_seconds AS "ttlSeconds",s.proxy_origin AS "proxyOrigin",s.cache_base_url AS "cacheBaseUrl",s.size_bytes AS "sizeBytes",s.entry_count AS "entryCount",s.observed_at AS "observedAt",s.error FROM workers w LEFT JOIN worker_cache_status s ON s.worker_id=w.id WHERE w.id=${workerId}`;
  const desired = row?.desiredConfiguration && typeof row.desiredConfiguration === "object" ? (row.desiredConfiguration as Record<string, unknown>) : {};
  return { desiredTtlSeconds: Number((desired.cache as Record<string, unknown> | undefined)?.ttlSeconds ?? desiredTtlSeconds), effectiveTtlSeconds: row?.ttlSeconds == null ? null : Number(row.ttlSeconds), ready: row?.ready === true, proxyOrigin: row?.proxyOrigin == null ? null : String(row.proxyOrigin), cacheBaseUrl: row?.cacheBaseUrl == null ? null : String(row.cacheBaseUrl), sizeBytes: decimal(row?.sizeBytes), entryCount: Number(row?.entryCount ?? 0), observedAt: row?.observedAt == null ? null : timestamp(row.observedAt), error: row?.error == null ? null : String(row.error) };
}
