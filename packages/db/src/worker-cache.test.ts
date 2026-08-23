import { expect, test } from "bun:test";
import { applyWorkerCacheTelemetry, encodeWorkerCacheCursor, decodeWorkerCacheCursor, listWorkerCacheEntries, sweepWorkerCacheSnapshots } from "./worker-cache.ts";

const workerId = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
const entry = {
  entryId: "33333333-3333-4333-8333-333333333333",
  githubRepositoryId: "123456789012345",
  cacheKeyPreview: "build-linux",
  cacheKeyHash: "a".repeat(64),
  scopePreview: "refs/heads/main",
  scopeHash: "b".repeat(64),
  versionHash: "c".repeat(64),
  sizeBytes: "9007199254740993",
  createdAt: "2026-08-23T12:00:00.000Z",
  lastAccessedAt: "2026-08-23T12:01:00.000Z",
  expiresAt: "2026-08-25T12:01:00.000Z",
};
const status = { generation, ready: true, ttlSeconds: 172800, proxyOrigin: "http://worker.local:8788", cacheBaseUrl: "https://worker.local:8789", sizeBytes: "1", entryCount: 1, observedAt: "2026-08-23T12:01:00.000Z", error: null };
const event = (type: string, payload: Record<string, unknown>) => ({ version: 1, id: crypto.randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: string[] = [];
  let completed = false;
  const db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    calls.push(query);
    if (query.includes("SELECT generation FROM worker_cache_status")) return [{ generation }];
    if (query.includes("active_snapshot_id AS")) return completed ? [{ activeSnapshotId: null, lastCompletedSnapshotId: generation }] : [{ activeSnapshotId: generation, lastCompletedSnapshotId: null }];
    if (query.includes("SET size_bytes=")) completed = true;
    if (query.includes("SELECT count")) return [{ count: 1 }];
    return rows;
  }) as never, {
    begin: async (fn: (tx: unknown) => unknown) => fn(db),
  });
  return { db, calls };
}

test("worker cache upsert is idempotent and never stores secrets", async () => {
  const { db, calls } = fakeDb();
  const telemetry = await applyWorkerCacheTelemetry(db, event("worker.cache_entry_upsert", { generation, entry }));
  expect(telemetry).toBe(true);
  await applyWorkerCacheTelemetry(db, event("worker.cache_entry_upsert", { generation, entry }));
  expect(calls.filter((sql) => sql.includes("INSERT INTO worker_cache_entries")).length).toBe(2);
  expect(calls.join(" ")).not.toMatch(/token|grant|certificate|signed_url/i);
});
test("worker cache deltas refresh summary count and bytes", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_entry_upsert", { generation, entry }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_entry_deleted", { generation, entryId: entry.entryId }));
  expect(calls.filter((sql) => sql.includes("UPDATE worker_cache_status SET entry_count=")).length).toBe(2);
});

test("worker cache upsert rejects a delta from an inactive generation", async () => {
  const { db, calls } = fakeDb([{ generation }]);
  const staleGeneration = "44444444-4444-4444-8444-444444444444";
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_entry_upsert", { generation: staleGeneration, entry }))).toBe(false);
  expect(calls.some((sql) => sql.includes("INSERT INTO worker_cache_entries"))).toBe(false);
});

test("snapshot end rejects an unknown snapshot without clearing live inventory", async () => {
  const { db, calls } = fakeDb();
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 0, entryCount: 0, sizeBytes: "0" }))).toBe(false);
  expect(calls.some((sql) => sql.includes("DELETE FROM worker_cache_entries"))).toBe(false);
});

test("snapshot pages atomically replace only after complete and valid end", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_begin", { snapshotId: generation, status }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: generation, sequence: 0, entries: [entry] }));
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 1, entryCount: 1, sizeBytes: "9007199254740993" }))).toBe(true);
  expect(calls.some((sql) => sql.includes("DELETE FROM worker_cache_entries"))).toBe(true);
  expect(calls.some((sql) => sql.includes("INSERT INTO worker_cache_entries"))).toBe(true);
});

test("interrupted snapshot is discarded without swapping inventory", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_begin", { snapshotId: generation, status }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: generation, sequence: 0, entries: [entry] }));
  expect(calls.some((sql) => sql.includes("DELETE FROM worker_cache_entries"))).toBe(false);
});

test("replayed snapshot end is idempotent after completion", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_begin", { snapshotId: generation, status }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: generation, sequence: 0, entries: [entry] }));
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 1, entryCount: 1, sizeBytes: "1" }))).toBe(true);
  const deletesBeforeReplay = calls.filter((sql) => sql.includes("DELETE FROM worker_cache_entries")).length;
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 1, entryCount: 1, sizeBytes: "1" }))).toBe(true);
  expect(calls.filter((sql) => sql.includes("DELETE FROM worker_cache_entries")).length).toBe(deletesBeforeReplay);
});

test("opaque worker cache cursor round trips and rejects tampering", () => {
  const cursor = encodeWorkerCacheCursor({ lastAccessedAt: entry.lastAccessedAt, entryId: entry.entryId });
  expect(decodeWorkerCacheCursor(cursor)).toEqual({ lastAccessedAt: entry.lastAccessedAt, entryId: entry.entryId });
  expect(() => decodeWorkerCacheCursor("%%%" )).toThrow();
});

test("worker cache listing searches metadata and returns stable URL projection", async () => {
  const { db } = fakeDb([entry]);
  const page = await listWorkerCacheEntries(db, workerId, { limit: 10, query: "BUILD" });
  expect(page.items[0]).toMatchObject({ entryId: entry.entryId, repositoryUrl: null, githubRepositoryId: entry.githubRepositoryId });
});
test("worker cache deletion is idempotent", async () => {
  const { db, calls } = fakeDb();
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_entry_deleted", { generation, entryId: entry.entryId }))).toBe(true);
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_entry_deleted", { generation, entryId: entry.entryId }))).toBe(true);
  expect(calls.filter((sql) => sql.includes("DELETE FROM worker_cache_entries")).length).toBe(2);
});

test("snapshot end rejects incomplete page counts and clears staging", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_begin", { snapshotId: generation, status }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: generation, sequence: 0, entries: [entry] }));
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 2, entryCount: 1, sizeBytes: "10" }))).toBe(false);
  expect(calls.some((sql) => sql.includes("DELETE FROM worker_cache_snapshot_entries"))).toBe(true);
});

test("snapshot sweep removes stale staging rows and abandoned active markers", async () => {
  const { db, calls } = fakeDb();
  await sweepWorkerCacheSnapshots(db, 60);
  expect(calls.some((sql) => sql.includes("staged_at <"))).toBe(true);
  expect(calls.some((sql) => sql.includes("active_snapshot_started_at <"))).toBe(true);
});
