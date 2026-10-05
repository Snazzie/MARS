import type { DatabaseClient } from "./index.ts";
import { WorkerCacheSummary, type DashboardWorkerCacheEntry, type DashboardWorkerCachePage } from "@mars/contracts";
import { and, count, desc, eq, lt, or, sql } from "drizzle-orm";
import { defineQueries } from "./prepared.ts";
import * as schema from "./drizzle-schema.ts";

type SqlDb = DatabaseClient;
type CacheEntry = {
  entryId: string; githubRepositoryId: string; cacheKeyPreview: string; cacheKeyHash: string;
  scopePreview: string; scopeHash: string; versionHash: string; sizeBytes: string;
  createdAt: string; lastAccessedAt: string; expiresAt: string;
};
type CacheStatus = { generation: string; ready: boolean; ttlSeconds: number; proxyOrigin: string; cacheBaseUrl: string; sizeBytes: string; entryCount: number; hitCount?: number; missCount?: number; observedAt: string; error: string | null };
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
function validRunnerStatus(value: unknown): value is { generation: string; enabled: boolean; maxGiB: number; sizeBytes: string; entryCount: number; hitCount?: number; missCount?: number; observedAt: string } {
  if (!value || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return uuid(status.generation) && typeof status.enabled === "boolean" && typeof status.maxGiB === "number" && Number.isSafeInteger(status.maxGiB) && status.maxGiB > 0 && typeof status.sizeBytes === "string" && /^(?:0|[1-9]\d*)$/.test(status.sizeBytes) && typeof status.entryCount === "number" && Number.isSafeInteger(status.entryCount) && status.entryCount >= 0 && (status.hitCount === undefined || (typeof status.hitCount === "number" && Number.isSafeInteger(status.hitCount) && status.hitCount >= 0)) && (status.missCount === undefined || (typeof status.missCount === "number" && Number.isSafeInteger(status.missCount) && status.missCount >= 0)) && typeof status.observedAt === "string" && Number.isFinite(Date.parse(status.observedAt));
}

const cacheQueries = defineQueries((db) => ({
  sweepEntries: db.delete(schema.workerCacheSnapshotEntries).where(lt(schema.workerCacheSnapshotEntries.stagedAt, sql.placeholder("cutoff"))).prepare("worker_cache_sweep_entries"),
  sweepStatuses: db.update(schema.workerCacheStatus).set({ activeSnapshotId: null, activeSnapshotStartedAt: null }).where(lt(schema.workerCacheStatus.activeSnapshotStartedAt, sql.placeholder("cutoff"))).prepare("worker_cache_sweep_status"),
  refreshSummary: db.update(schema.workerCacheStatus).set({
    entryCount: sql`(SELECT count(*)::int FROM ${schema.workerCacheEntries} WHERE ${schema.workerCacheEntries.workerId}=${sql.placeholder("workerId")})`,
    sizeBytes: sql`(SELECT COALESCE(sum(${schema.workerCacheEntries.sizeBytes}),0) FROM ${schema.workerCacheEntries} WHERE ${schema.workerCacheEntries.workerId}=${sql.placeholder("workerId")})`,
    observedAt: sql`now()`,
  }).where(and(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId")), eq(schema.workerCacheStatus.generation, sql.placeholder("generation")))).prepare("worker_cache_refresh_summary"),
  generation: db.select({ generation: schema.workerCacheStatus.generation }).from(schema.workerCacheStatus).where(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId"))).prepare("worker_cache_generation"),
  runnerUpdate: db.update(schema.workerCacheStatus).set({
    runnerCacheEnabled: sql`${sql.placeholder("enabled")}`, runnerCacheMaxGiB: sql`${sql.placeholder("maxGiB")}`,
    runnerCacheSizeBytes: sql`${sql.placeholder("sizeBytes")}::bigint`, runnerCacheEntryCount: sql`${sql.placeholder("entryCount")}`,
    runnerCacheHitCount: sql`${sql.placeholder("hitCount")}`, runnerCacheMissCount: sql`${sql.placeholder("missCount")}`,
    runnerCacheObservedAt: sql`${sql.placeholder("observedAt")}::timestamptz`,
  }).where(and(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId")), eq(schema.workerCacheStatus.generation, sql.placeholder("generation")))).returning({ workerId: schema.workerCacheStatus.workerId }).prepare("worker_cache_runner_status"),
  entryUpsert: db.insert(schema.workerCacheEntries).select(db.select({ workerId: sql`${sql.placeholder("workerId")}`.as("worker_id"), entryId: sql`${sql.placeholder("entryId")}`.as("entry_id"), githubRepositoryId: sql`${sql.placeholder("githubRepositoryId")}`.as("github_repository_id"), cacheKeyPreview: sql`${sql.placeholder("cacheKeyPreview")}`.as("cache_key_preview"), cacheKeyHash: sql`${sql.placeholder("cacheKeyHash")}`.as("cache_key_hash"), scopePreview: sql`${sql.placeholder("scopePreview")}`.as("scope_preview"), scopeHash: sql`${sql.placeholder("scopeHash")}`.as("scope_hash"), versionHash: sql`${sql.placeholder("versionHash")}`.as("version_hash"), sizeBytes: sql`${sql.placeholder("sizeBytes")}`.as("size_bytes"), createdAt: sql`${sql.placeholder("createdAt")}`.as("created_at"), lastAccessedAt: sql`${sql.placeholder("lastAccessedAt")}`.as("last_accessed_at"), expiresAt: sql`${sql.placeholder("expiresAt")}`.as("expires_at"), observedGeneration: sql`${sql.placeholder("generation")}`.as("observed_generation") }).from(schema.workerCacheStatus).where(and(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId")), eq(schema.workerCacheStatus.generation, sql.placeholder("generation"))))).onConflictDoUpdate({ target: [schema.workerCacheEntries.workerId, schema.workerCacheEntries.entryId], set: { githubRepositoryId: sql`excluded.github_repository_id`, cacheKeyPreview: sql`excluded.cache_key_preview`, cacheKeyHash: sql`excluded.cache_key_hash`, scopePreview: sql`excluded.scope_preview`, scopeHash: sql`excluded.scope_hash`, versionHash: sql`excluded.version_hash`, sizeBytes: sql`excluded.size_bytes`, createdAt: sql`excluded.created_at`, lastAccessedAt: sql`excluded.last_accessed_at`, expiresAt: sql`excluded.expires_at`, observedGeneration: sql`excluded.observed_generation` } }).prepare("worker_cache_entry_upsert"),
  entryDelete: db.delete(schema.workerCacheEntries).where(and(eq(schema.workerCacheEntries.workerId, sql.placeholder("workerId")), eq(schema.workerCacheEntries.entryId, sql.placeholder("entryId")), eq(schema.workerCacheEntries.observedGeneration, sql.placeholder("generation")), eq(schema.workerCacheEntries.observedGeneration, sql`(SELECT generation FROM ${schema.workerCacheStatus} WHERE ${schema.workerCacheStatus.workerId}=${sql.placeholder("workerId")})`))).prepare("worker_cache_entry_delete"),
  snapshotLock: db.select({ activeSnapshotId: schema.workerCacheStatus.activeSnapshotId, lastCompletedSnapshotId: schema.workerCacheStatus.lastCompletedSnapshotId }).from(schema.workerCacheStatus).where(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId"))).for("update").prepare("worker_cache_snapshot_lock"),
  snapshotDelete: db.delete(schema.workerCacheSnapshotEntries).where(and(eq(schema.workerCacheSnapshotEntries.workerId, sql.placeholder("workerId")), eq(schema.workerCacheSnapshotEntries.snapshotId, sql.placeholder("snapshotId")))).prepare("worker_cache_snapshot_delete"),
  snapshotBegin: db.insert(schema.workerCacheStatus).values({ workerId: sql.placeholder("workerId"), generation: sql.placeholder("generation"), ready: sql.placeholder("ready"), ttlSeconds: sql.placeholder("ttlSeconds"), proxyOrigin: sql.placeholder("proxyOrigin"), cacheBaseUrl: sql.placeholder("cacheBaseUrl"), sizeBytes: sql.placeholder("sizeBytes"), entryCount: sql.placeholder("entryCount"), observedAt: sql.placeholder("observedAt"), error: sql.placeholder("error"), activeSnapshotId: sql.placeholder("snapshotId"), activeSnapshotStartedAt: sql`now()`, lastCompletedSnapshotId: sql.placeholder("lastCompletedSnapshotId") }).onConflictDoUpdate({ target: schema.workerCacheStatus.workerId, set: { generation: sql`excluded.generation`, ready: sql`excluded.ready`, ttlSeconds: sql`excluded.ttl_seconds`, proxyOrigin: sql`excluded.proxy_origin`, cacheBaseUrl: sql`excluded.cache_base_url`, sizeBytes: sql`excluded.size_bytes`, entryCount: sql`excluded.entry_count`, observedAt: sql`excluded.observed_at`, error: sql`excluded.error`, activeSnapshotId: sql`excluded.active_snapshot_id`, activeSnapshotStartedAt: sql`excluded.active_snapshot_started_at`, lastCompletedSnapshotId: sql`excluded.last_completed_snapshot_id`, runnerCacheEnabled: sql`CASE WHEN ${schema.workerCacheStatus.generation} IS DISTINCT FROM excluded.generation THEN NULL ELSE ${schema.workerCacheStatus.runnerCacheEnabled} END`, runnerCacheMaxGiB: sql`CASE WHEN ${schema.workerCacheStatus.generation} IS DISTINCT FROM excluded.generation THEN NULL ELSE ${schema.workerCacheStatus.runnerCacheMaxGiB} END`, runnerCacheSizeBytes: sql`CASE WHEN ${schema.workerCacheStatus.generation} IS DISTINCT FROM excluded.generation THEN NULL ELSE ${schema.workerCacheStatus.runnerCacheSizeBytes} END`, runnerCacheEntryCount: sql`CASE WHEN ${schema.workerCacheStatus.generation} IS DISTINCT FROM excluded.generation THEN NULL ELSE ${schema.workerCacheStatus.runnerCacheEntryCount} END`, runnerCacheHitCount: sql`CASE WHEN ${schema.workerCacheStatus.generation} IS DISTINCT FROM excluded.generation THEN 0 ELSE ${schema.workerCacheStatus.runnerCacheHitCount} END`, runnerCacheMissCount: sql`CASE WHEN ${schema.workerCacheStatus.generation} IS DISTINCT FROM excluded.generation THEN 0 ELSE ${schema.workerCacheStatus.runnerCacheMissCount} END`, runnerCacheObservedAt: sql`CASE WHEN ${schema.workerCacheStatus.generation} IS DISTINCT FROM excluded.generation THEN NULL ELSE ${schema.workerCacheStatus.runnerCacheObservedAt} END` } }).prepare("worker_cache_snapshot_begin"),
  snapshotPage: db.insert(schema.workerCacheSnapshotEntries).values({ workerId: sql.placeholder("workerId"), snapshotId: sql.placeholder("snapshotId"), sequence: sql.placeholder("sequence"), entryId: sql.placeholder("entryId"), githubRepositoryId: sql.placeholder("githubRepositoryId"), cacheKeyPreview: sql.placeholder("cacheKeyPreview"), cacheKeyHash: sql.placeholder("cacheKeyHash"), scopePreview: sql.placeholder("scopePreview"), scopeHash: sql.placeholder("scopeHash"), versionHash: sql.placeholder("versionHash"), sizeBytes: sql.placeholder("sizeBytes"), createdAt: sql.placeholder("createdAt"), lastAccessedAt: sql.placeholder("lastAccessedAt"), expiresAt: sql.placeholder("expiresAt"), observedGeneration: sql`(SELECT generation FROM ${schema.workerCacheStatus} WHERE ${schema.workerCacheStatus.workerId}=${sql.placeholder("workerId")})`, stagedAt: sql`now()` }).onConflictDoNothing().prepare("worker_cache_snapshot_page"),
  snapshotActive: db.select({ activeSnapshotId: schema.workerCacheStatus.activeSnapshotId }).from(schema.workerCacheStatus).where(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId"))).prepare("worker_cache_snapshot_active"),
  snapshotPages: db.select({ count: sql<number>`count(DISTINCT ${schema.workerCacheSnapshotEntries.sequence})::int` }).from(schema.workerCacheSnapshotEntries).where(and(eq(schema.workerCacheSnapshotEntries.workerId, sql.placeholder("workerId")), eq(schema.workerCacheSnapshotEntries.snapshotId, sql.placeholder("snapshotId")))).prepare("worker_cache_snapshot_page_count"),
  snapshotRows: db.select({ count: count() }).from(schema.workerCacheSnapshotEntries).where(and(eq(schema.workerCacheSnapshotEntries.workerId, sql.placeholder("workerId")), eq(schema.workerCacheSnapshotEntries.snapshotId, sql.placeholder("snapshotId")))).prepare("worker_cache_snapshot_entry_count"),
  clearActive: db.update(schema.workerCacheStatus).set({ activeSnapshotId: null, activeSnapshotStartedAt: null }).where(and(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId")), eq(schema.workerCacheStatus.activeSnapshotId, sql.placeholder("snapshotId")))).prepare("worker_cache_clear_snapshot"),
  clearEntries: db.delete(schema.workerCacheEntries).where(eq(schema.workerCacheEntries.workerId, sql.placeholder("workerId"))).prepare("worker_cache_clear_entries"),
  snapshotPromote: db.insert(schema.workerCacheEntries).select(db.select({ workerId: schema.workerCacheSnapshotEntries.workerId, entryId: schema.workerCacheSnapshotEntries.entryId, githubRepositoryId: schema.workerCacheSnapshotEntries.githubRepositoryId, cacheKeyPreview: schema.workerCacheSnapshotEntries.cacheKeyPreview, cacheKeyHash: schema.workerCacheSnapshotEntries.cacheKeyHash, scopePreview: schema.workerCacheSnapshotEntries.scopePreview, scopeHash: schema.workerCacheSnapshotEntries.scopeHash, versionHash: schema.workerCacheSnapshotEntries.versionHash, sizeBytes: schema.workerCacheSnapshotEntries.sizeBytes, createdAt: schema.workerCacheSnapshotEntries.createdAt, lastAccessedAt: schema.workerCacheSnapshotEntries.lastAccessedAt, expiresAt: schema.workerCacheSnapshotEntries.expiresAt, observedGeneration: schema.workerCacheSnapshotEntries.observedGeneration }).from(schema.workerCacheSnapshotEntries).where(and(eq(schema.workerCacheSnapshotEntries.workerId, sql.placeholder("workerId")), eq(schema.workerCacheSnapshotEntries.snapshotId, sql.placeholder("snapshotId"))))).prepare("worker_cache_snapshot_promote"),
  snapshotComplete: db.update(schema.workerCacheStatus).set({
    sizeBytes: sql`${sql.placeholder("sizeBytes")}::bigint`, entryCount: sql`${sql.placeholder("entryCount")}`,
    observedAt: sql`now()`, activeSnapshotId: null, activeSnapshotStartedAt: null,
    lastCompletedSnapshotId: sql`${sql.placeholder("snapshotId")}::uuid`,
  }).where(and(eq(schema.workerCacheStatus.workerId, sql.placeholder("workerId")), eq(schema.workerCacheStatus.activeSnapshotId, sql.placeholder("snapshotId")))).prepare("worker_cache_snapshot_complete"),
  listing: db.select({ entryId: schema.workerCacheEntries.entryId, githubRepositoryId: schema.workerCacheEntries.githubRepositoryId, repositoryFullName: schema.dashboardRepositories.fullName, cacheKeyPreview: schema.workerCacheEntries.cacheKeyPreview, cacheKeyHash: schema.workerCacheEntries.cacheKeyHash, scopePreview: schema.workerCacheEntries.scopePreview, scopeHash: schema.workerCacheEntries.scopeHash, versionHash: schema.workerCacheEntries.versionHash, sizeBytes: schema.workerCacheEntries.sizeBytes, createdAt: schema.workerCacheEntries.createdAt, lastAccessedAt: schema.workerCacheEntries.lastAccessedAt, expiresAt: schema.workerCacheEntries.expiresAt }).from(schema.workerCacheEntries).leftJoin(schema.dashboardRepositories, eq(schema.dashboardRepositories.githubRepositoryId, schema.workerCacheEntries.githubRepositoryId)).where(and(eq(schema.workerCacheEntries.workerId, sql.placeholder("workerId")), or(sql`${sql.placeholder("cursorAt")}::timestamptz IS NULL`, lt(sql`(${schema.workerCacheEntries.lastAccessedAt},${schema.workerCacheEntries.entryId})`, sql`(${sql.placeholder("cursorAt")}::timestamptz,${sql.placeholder("cursorId")}::uuid)`)), or(sql`${sql.placeholder("query")} = ''`, sql`${schema.workerCacheEntries.cacheKeyPreview} ILIKE ${sql.placeholder("pattern")}`, sql`${schema.workerCacheEntries.scopePreview} ILIKE ${sql.placeholder("pattern")}`, sql`${schema.dashboardRepositories.fullName} ILIKE ${sql.placeholder("pattern")}`))).orderBy(desc(schema.workerCacheEntries.lastAccessedAt), desc(schema.workerCacheEntries.entryId)).limit(sql.placeholder("take")).prepare("worker_cache_listing"),
  summary: db.select({ desiredConfiguration: schema.workers.desiredConfiguration, generation: schema.workerCacheStatus.generation, ready: schema.workerCacheStatus.ready, ttlSeconds: schema.workerCacheStatus.ttlSeconds, proxyOrigin: schema.workerCacheStatus.proxyOrigin, cacheBaseUrl: schema.workerCacheStatus.cacheBaseUrl, sizeBytes: schema.workerCacheStatus.sizeBytes, entryCount: schema.workerCacheStatus.entryCount, hitCount: schema.workerCacheStatus.hitCount, missCount: schema.workerCacheStatus.missCount, runnerCacheEnabled: schema.workerCacheStatus.runnerCacheEnabled, runnerCacheMaxGiB: schema.workerCacheStatus.runnerCacheMaxGiB, runnerCacheSizeBytes: schema.workerCacheStatus.runnerCacheSizeBytes, runnerCacheEntryCount: schema.workerCacheStatus.runnerCacheEntryCount, runnerCacheHitCount: schema.workerCacheStatus.runnerCacheHitCount, runnerCacheMissCount: schema.workerCacheStatus.runnerCacheMissCount, observedAt: schema.workerCacheStatus.observedAt, runnerCacheObservedAt: schema.workerCacheStatus.runnerCacheObservedAt, error: schema.workerCacheStatus.error }).from(schema.workers).leftJoin(schema.workerCacheStatus, eq(schema.workerCacheStatus.workerId, schema.workers.id)).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_cache_summary"),
}));

export async function sweepWorkerCacheSnapshots(db: SqlDb, maxAgeSeconds = 86_400): Promise<void> {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) throw new Error("snapshot sweep age must be a positive safe integer");
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  const queries = cacheQueries(db);
  await db.transaction(async (tx) => {
    await queries.sweepEntries.execute({ cutoff });
    await queries.sweepStatuses.execute({ cutoff });
  });
}
async function refreshWorkerCacheSummary(db: SqlDb, workerId: string, generation: string): Promise<void> {
  await cacheQueries(db).refreshSummary.execute({ workerId, generation });
}

export async function applyWorkerCacheTelemetry(db: SqlDb, input: TelemetryEvent): Promise<boolean> {
  const payload = input.payload ?? {};
  if (!uuid(input.workerId)) return false;
  const queries = cacheQueries(db);
  if (input.type === "worker.runner_cache_status") {
    if (!validRunnerStatus(payload)) return false;
    const status = payload;
    return await db.transaction(async () => {
      const [active] = await queries.generation.execute({ workerId: input.workerId });
      if (!active) return false;
      if (active.generation !== status.generation) return true;
      const updated = await queries.runnerUpdate.execute({ workerId: input.workerId, generation: status.generation, enabled: status.enabled, maxGiB: status.maxGiB, sizeBytes: status.sizeBytes, entryCount: status.entryCount, hitCount: status.hitCount ?? 0, missCount: status.missCount ?? 0, observedAt: status.observedAt });
      return updated.length > 0;
    });
  }
  if (input.type === "worker.cache_entry_upsert") {
    const entry = payload.entry;
    if (!uuid(payload.generation) || !validEntry(entry)) return false;
    const values = entryValues(entry);
    const generation = payload.generation;
    const [active] = await queries.generation.execute({ workerId: input.workerId });
    if (typeof active?.generation === "string" && active.generation !== generation) return true;
    await queries.entryUpsert.execute({ workerId: input.workerId, entryId: values[0], githubRepositoryId: values[1], cacheKeyPreview: values[2], cacheKeyHash: values[3], scopePreview: values[4], scopeHash: values[5], versionHash: values[6], sizeBytes: values[7], createdAt: values[8], lastAccessedAt: values[9], expiresAt: values[10], generation });
    await refreshWorkerCacheSummary(db, input.workerId, generation);
    return true;
  }
  if (input.type === "worker.cache_entry_deleted") {
    if (!uuid(payload.generation) || !uuid(payload.entryId)) return false;
    const generation = payload.generation;
    await queries.entryDelete.execute({ workerId: input.workerId, entryId: payload.entryId, generation });
    await refreshWorkerCacheSummary(db, input.workerId, generation);
    return true;
  }
  if (input.type === "worker.cache_snapshot_begin") {
    if (!uuid(payload.snapshotId) || !validStatus(payload.status)) return false;
    const snapshotId = payload.snapshotId;
    const status = payload.status;
    await sweepWorkerCacheSnapshots(db);
    await db.transaction(async () => {
      const [active] = await queries.snapshotLock.execute({ workerId: input.workerId });
      const lastCompletedSnapshotId: string | null = typeof active?.lastCompletedSnapshotId === "string" ? active.lastCompletedSnapshotId : null;
      if (lastCompletedSnapshotId === snapshotId && active?.activeSnapshotId == null) return;
      await queries.snapshotDelete.execute({ workerId: input.workerId, snapshotId });
      await queries.snapshotBegin.execute({ workerId: input.workerId, generation: status.generation, ready: status.ready, ttlSeconds: status.ttlSeconds, proxyOrigin: status.proxyOrigin, cacheBaseUrl: status.cacheBaseUrl, sizeBytes: status.sizeBytes, entryCount: status.entryCount, observedAt: status.observedAt, error: status.error, snapshotId, lastCompletedSnapshotId });
    });
    return true;
  }
  if (input.type === "worker.cache_snapshot_page") {
    if (!uuid(payload.snapshotId) || !safeInteger(payload.sequence) || payload.sequence < 0 || !Array.isArray(payload.entries) || payload.entries.length > 100 || !payload.entries.every(validEntry)) return false;
    const snapshotId = payload.snapshotId;
    const sequence = payload.sequence;
    const [active] = await queries.snapshotActive.execute({ workerId: input.workerId });
    if (active?.activeSnapshotId !== snapshotId) return true;
    for (const entry of payload.entries as CacheEntry[]) {
      const values = entryValues(entry);
      await queries.snapshotPage.execute({ workerId: input.workerId, snapshotId, sequence, entryId: values[0], githubRepositoryId: values[1], cacheKeyPreview: values[2], cacheKeyHash: values[3], scopePreview: values[4], scopeHash: values[5], versionHash: values[6], sizeBytes: values[7], createdAt: values[8], lastAccessedAt: values[9], expiresAt: values[10] });
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
    return await db.transaction(async () => {
      const [active] = await queries.snapshotLock.execute({ workerId: input.workerId });
      if (active?.lastCompletedSnapshotId === snapshotId && active.activeSnapshotId == null) return true;
      if (active?.activeSnapshotId !== snapshotId) return true;
      const pages = await queries.snapshotPages.execute({ workerId: input.workerId, snapshotId });
      const rows = await queries.snapshotRows.execute({ workerId: input.workerId, snapshotId });
      if (Number(pages[0]?.count ?? 0) !== pageCount || Number(rows[0]?.count ?? 0) !== entryCount) {
        await queries.snapshotDelete.execute({ workerId: input.workerId, snapshotId });
        await queries.clearActive.execute({ workerId: input.workerId, snapshotId });
        return true;
      }
      await queries.clearEntries.execute({ workerId: input.workerId });
      await queries.snapshotPromote.execute({ workerId: input.workerId, snapshotId });
      await queries.snapshotComplete.execute({ workerId: input.workerId, snapshotId, sizeBytes, entryCount });
      await queries.snapshotDelete.execute({ workerId: input.workerId, snapshotId });
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
  const rows = await cacheQueries(db).listing.execute({ workerId, cursorAt: cursor?.lastAccessedAt ?? null, cursorId: cursor?.entryId ?? null, query, pattern: `%${query}%`, take: limit + 1 });
  const items = rows.slice(0, limit).map((row) => normalizeEntry(row as unknown as Record<string, unknown>));
  return { items, nextCursor: rows.length > limit && items.length ? encodeWorkerCacheCursor({ lastAccessedAt: items.at(-1)!.lastAccessedAt, entryId: items.at(-1)!.entryId }) : null };
}

export async function getWorkerCacheSummary(db: SqlDb, workerId: string, desiredTtlSeconds = 172800): Promise<WorkerCacheSummary> {
  const [row] = await cacheQueries(db).summary.execute({ workerId });
  const desired = row?.desiredConfiguration && typeof row.desiredConfiguration === "object" ? row.desiredConfiguration as Record<string, unknown> : {};
  const cache = desired.cache && typeof desired.cache === "object" ? desired.cache as Record<string, unknown> : {};
  return WorkerCacheSummary.parse({ desiredTtlSeconds: Number(cache.ttlSeconds ?? desiredTtlSeconds), desiredRunnerCacheEnabled: cache.runnerCacheEnabled !== false, desiredRunnerCacheMaxGiB: Number(cache.runnerCacheMaxGiB ?? 20), effectiveTtlSeconds: row?.ttlSeconds == null ? null : Number(row.ttlSeconds), effectiveRunnerCacheEnabled: row?.runnerCacheEnabled == null ? null : row.runnerCacheEnabled === true, effectiveRunnerCacheMaxGiB: row?.runnerCacheMaxGiB == null ? null : Number(row.runnerCacheMaxGiB), ready: row?.ready === true, proxyOrigin: row?.proxyOrigin == null ? null : String(row.proxyOrigin), cacheBaseUrl: row?.cacheBaseUrl == null ? null : String(row.cacheBaseUrl), sizeBytes: row?.observedAt == null ? null : decimal(row.sizeBytes), entryCount: row?.observedAt == null ? null : Number(row.entryCount ?? 0), hitCount: row?.observedAt == null ? null : Number(row.hitCount ?? 0), missCount: row?.observedAt == null ? null : Number(row.missCount ?? 0), observedAt: row?.observedAt == null ? null : timestamp(row.observedAt), error: row?.error == null ? null : String(row.error), runnerCacheSizeBytes: row?.runnerCacheObservedAt == null ? null : decimal(row.runnerCacheSizeBytes), runnerCacheEntryCount: row?.runnerCacheObservedAt == null ? null : Number(row.runnerCacheEntryCount ?? 0), runnerCacheHitCount: row?.runnerCacheObservedAt == null ? null : Number(row.runnerCacheHitCount ?? 0), runnerCacheMissCount: row?.runnerCacheObservedAt == null ? null : Number(row.runnerCacheMissCount ?? 0), runnerCacheObservedAt: row?.runnerCacheObservedAt == null ? null : timestamp(row.runnerCacheObservedAt) });
}
