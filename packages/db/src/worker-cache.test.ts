import { expect, test } from "bun:test";
import { applyWorkerCacheTelemetry, encodeWorkerCacheCursor, decodeWorkerCacheCursor, listWorkerCacheEntries, sweepWorkerCacheSnapshots } from "./worker-cache.ts";
import { preparedTestDatabase } from "./prepared-test-fixture.ts";
import type { DatabaseClient } from "./index.ts";

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
const runnerStatus = { generation, enabled: true, maxGiB: 20, sizeBytes: "9007199254740993", entryCount: 1, observedAt: "2026-08-23T12:01:00.000Z" };
const event = (type: string, payload: Record<string, unknown>) => ({ version: 1, id: crypto.randomUUID(), workerId, type, occurredAt: new Date().toISOString(), payload });

function fakeDb(rows: Record<string, unknown>[] = [], runnerUpdateRows: Record<string, unknown>[] = [{ worker_id: workerId }]) {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  let completed = false;
  let snapshotActive = false;
  let snapshotStarted = false;
  let activeGeneration: string | null = generation;
  const db = preparedTestDatabase(async (name, params) => {
    calls.push({ name, params });
    switch (name) {
      case "worker_cache_generation": return activeGeneration ? [{ generation: activeGeneration }] : [];
      case "worker_cache_runner_status": return runnerUpdateRows;
      case "worker_cache_snapshot_lock": return completed ? [{ activeSnapshotId: null, lastCompletedSnapshotId: generation }] : [{ activeSnapshotId: snapshotActive ? generation : null, lastCompletedSnapshotId: null }];
      case "worker_cache_snapshot_active": return [{ activeSnapshotId: snapshotActive ? generation : null }];
      case "worker_cache_snapshot_page_count": return [{ count: snapshotStarted ? 1 : 0 }];
      case "worker_cache_snapshot_entry_count": return [{ count: snapshotStarted ? 1 : 0 }];
      case "worker_cache_listing": return rows;
      case "worker_cache_snapshot_begin": snapshotActive = true; snapshotStarted = true; return [];
      case "worker_cache_snapshot_complete": completed = true; snapshotActive = false; return [];
      case "worker_cache_clear_snapshot": snapshotActive = false; return [];
      default: return [];
    }
  });
  return { db, calls, setActiveGeneration: (value: string | null) => { activeGeneration = value; } };
}

test("worker cache upsert is idempotent and never stores secrets", async () => {
  const { db, calls } = fakeDb();
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_entry_upsert", { generation, entry }))).toBe(true);
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_entry_upsert", { generation, entry }))).toBe(true);
  const inserts = calls.filter((call) => call.name === "worker_cache_entry_upsert");
  expect(inserts).toHaveLength(2);
  expect(JSON.stringify(inserts)).not.toMatch(/token|grant|certificate|signed_url/i);
});
test("worker cache deltas refresh summary count and bytes", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_entry_upsert", { generation, entry }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_entry_deleted", { generation, entryId: entry.entryId }));
  expect(calls.filter((call) => call.name === "worker_cache_refresh_summary")).toHaveLength(2);
});

test("acknowledges a cache delta from an inactive generation without applying it", async () => {
  const { db, calls } = fakeDb();
  const staleGeneration = "44444444-4444-4444-8444-444444444444";
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_entry_upsert", { generation: staleGeneration, entry }))).toBe(true);
  expect(calls.some((call) => call.name === "worker_cache_entry_upsert")).toBe(false);
});
test("runner cache status updates only the matching generation", async () => {
  const { db, calls } = fakeDb();
  expect(await applyWorkerCacheTelemetry(db, event("worker.runner_cache_status", runnerStatus))).toBe(true);
  expect(calls.some((call) => call.name === "worker_cache_runner_status")).toBe(true);
});
test("runner cache status rejects missing workers", async () => {
  const { db } = fakeDb([], []);
  expect(await applyWorkerCacheTelemetry(db, event("worker.runner_cache_status", runnerStatus))).toBe(false);
});
test("runner cache status acknowledges stale generations without updating status", async () => {
  const { db, calls } = fakeDb();
  const stale = { ...runnerStatus, generation: "44444444-4444-4444-8444-444444444444" };
  expect(await applyWorkerCacheTelemetry(db, event("worker.runner_cache_status", stale))).toBe(true);
  expect(calls.some((call) => call.name === "worker_cache_runner_status")).toBe(false);
});

test("stale snapshot end is acknowledged without clearing live inventory", async () => {
  const { db, calls } = fakeDb();
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 0, entryCount: 0, sizeBytes: "0" }))).toBe(true);
  expect(calls.some((call) => call.name === "worker_cache_clear_entries")).toBe(false);
});
test("stale snapshot page is acknowledged without staging entries", async () => {
  const { db, calls } = fakeDb();
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: "44444444-4444-4444-8444-444444444444", sequence: 0, entries: [entry] }))).toBe(true);
  expect(calls.some((call) => call.name === "worker_cache_snapshot_page")).toBe(false);
});

test("snapshot pages atomically replace only after complete and valid end", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_begin", { snapshotId: generation, status }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: generation, sequence: 0, entries: [entry] }));
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 1, entryCount: 1, sizeBytes: "9007199254740993" }))).toBe(true);
  expect(calls.findIndex((call) => call.name === "worker_cache_clear_entries")).toBeLessThan(calls.findIndex((call) => call.name === "worker_cache_snapshot_promote"));
  expect(calls.some((call) => call.name === "worker_cache_snapshot_complete")).toBe(true);
});

test("interrupted snapshot is discarded without swapping inventory", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_begin", { snapshotId: generation, status }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: generation, sequence: 0, entries: [entry] }));
  expect(calls.some((call) => call.name === "worker_cache_clear_entries")).toBe(false);
});

test("replayed snapshot end is idempotent after completion", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_begin", { snapshotId: generation, status }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: generation, sequence: 0, entries: [entry] }));
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 1, entryCount: 1, sizeBytes: "1" }))).toBe(true);
  const deletesBeforeReplay = calls.filter((call) => call.name === "worker_cache_clear_entries").length;
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 1, entryCount: 1, sizeBytes: "1" }))).toBe(true);
  expect(calls.filter((call) => call.name === "worker_cache_clear_entries")).toHaveLength(deletesBeforeReplay);
});

test("opaque worker cache cursor round trips and rejects tampering", () => {
  const cursor = encodeWorkerCacheCursor({ lastAccessedAt: entry.lastAccessedAt, entryId: entry.entryId });
  expect(decodeWorkerCacheCursor(cursor)).toEqual({ lastAccessedAt: entry.lastAccessedAt, entryId: entry.entryId });
  expect(() => decodeWorkerCacheCursor("%%%" )).toThrow();
});

test("worker cache listing preserves URL projection and normalizes entries", async () => {
  const { db } = fakeDb([{ ...entry, repositoryFullName: null }]);
  const page = await listWorkerCacheEntries(db, workerId, { limit: 10, query: "BUILD" });
  expect(page.items[0]).toMatchObject({ entryId: entry.entryId, repositoryUrl: null, githubRepositoryId: entry.githubRepositoryId });
});
test("worker cache deletion is idempotent", async () => {
  const { db, calls } = fakeDb();
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_entry_deleted", { generation, entryId: entry.entryId }))).toBe(true);
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_entry_deleted", { generation, entryId: entry.entryId }))).toBe(true);
  expect(calls.filter((call) => call.name === "worker_cache_entry_delete")).toHaveLength(2);
});

test("incomplete snapshot is discarded and acknowledged without swapping inventory", async () => {
  const { db, calls } = fakeDb();
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_begin", { snapshotId: generation, status }));
  await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_page", { snapshotId: generation, sequence: 0, entries: [entry] }));
  expect(await applyWorkerCacheTelemetry(db, event("worker.cache_snapshot_end", { snapshotId: generation, pageCount: 2, entryCount: 1, sizeBytes: "10" }))).toBe(true);
  expect(calls.some((call) => call.name === "worker_cache_snapshot_delete")).toBe(true);
  expect(calls.some((call) => call.name === "worker_cache_snapshot_complete")).toBe(false);
});

test("snapshot sweep removes stale staging rows and abandoned active markers", async () => {
  const { db, calls } = fakeDb();
  await sweepWorkerCacheSnapshots(db, 60);
  expect(calls.some((call) => call.name === "worker_cache_sweep_entries")).toBe(true);
  expect(calls.some((call) => call.name === "worker_cache_sweep_status")).toBe(true);
});
