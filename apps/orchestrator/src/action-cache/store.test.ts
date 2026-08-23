import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openActionCacheStore, resolveActionCacheRoot } from "./store.ts";
import { Database } from "bun:sqlite";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-action-cache-"));
  roots.push(root);
  return root;
}

test("resolves the worker-local cache root for every supported platform", () => {
  expect(resolveActionCacheRoot({ WHITESMITH_ACTION_CACHE_ROOT: "D:\\cache" }, "win32")).toBe("D:\\cache");
  expect(resolveActionCacheRoot({ ProgramData: "D:\\ProgramData" }, "win32")).toBe("D:\\ProgramData\\Whitesmith\\action-cache");
  expect(resolveActionCacheRoot({ HOME: "/Users/worker" }, "darwin")).toBe("/Users/worker/Library/Application Support/Whitesmith/action-cache");
  expect(resolveActionCacheRoot({}, "linux")).toBe("/var/lib/whitesmith/action-cache");
});

test("rejects relative or control-character cache roots", () => {
  expect(() => resolveActionCacheRoot({ WHITESMITH_ACTION_CACHE_ROOT: "relative/cache" }, "linux")).toThrow("absolute");
  expect(() => resolveActionCacheRoot({ WHITESMITH_ACTION_CACHE_ROOT: "relative\\cache" }, "win32")).toThrow("absolute");
  expect(() => resolveActionCacheRoot({ WHITESMITH_ACTION_CACHE_ROOT: "/var/lib/cache\nother" }, "linux")).toThrow("invalid");
});

test("persists one generation and immutable entry metadata in WAL SQLite", async () => {
  const root = await temporaryRoot();
  const now = new Date("2026-08-23T00:00:00.000Z");
  const first = await openActionCacheStore({ root, ttlSeconds: 3600, now: () => now });
  const reserved = await first.reserveEntry({ githubRepositoryId: "123", scope: "refs/heads/main", cacheKey: "npm/cache:unsafe", version: "v1" });
  expect(reserved).not.toBeNull();
  expect(await first.reserveEntry({ githubRepositoryId: "123", scope: "refs/heads/main", cacheKey: "npm/cache:unsafe", version: "v1" })).toBeNull();
  const archivePath = await first.writeArchive(reserved!.entryId, new TextEncoder().encode("archive"));
  const partPath = await first.writeUploadPart(reserved!.entryId, 1, "../../../raw-block-id", new TextEncoder().encode("part"));
  await first.markReady(reserved!.entryId, 7n);
  expect(basename(archivePath)).toMatch(/^[0-9a-f-]{36}\.archive$/);
  expect(basename(partPath)).toMatch(/^[0-9a-f-]{36}\.part$/);
  expect(archivePath).not.toContain("npm");
  expect(partPath).not.toContain("raw-block-id");
  const generation = first.generation;
  await first.close();

  const reopened = await openActionCacheStore({ root, ttlSeconds: 3600, now: () => now });
  expect(reopened.generation).toBe(generation);
  expect(reopened.journalMode).toBe("wal");
  expect(await Array.fromAsync(reopened.snapshotPages(100))).toEqual([[
    expect.objectContaining({ githubRepositoryId: "123", sizeBytes: "7", cacheKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/), scopeHash: expect.stringMatching(/^[0-9a-f]{64}$/), versionHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
  ]]);
  await reopened.close();
});

test("backs the cache route adapter with ordered blocks and ready lookups", async () => {
  const root = await temporaryRoot();
  let now = new Date("2026-08-23T00:00:00.000Z");
  const store = await openActionCacheStore({ root, ttlSeconds: 3600, now: () => now });
  const identity = { githubRepositoryId: "124", scope: "refs/heads/main", cacheKey: "npm-main", version: "v1" };
  const reserved = (await store.reserveEntry(identity))!;
  await store.writeUploadPart(reserved.entryId, 1, "block-1", new TextEncoder().encode("a"));
  await store.writeUploadPart(reserved.entryId, 2, "block-2", new TextEncoder().encode("b"));
  expect(await store.listUploadParts(reserved.entryId)).toEqual([
    expect.objectContaining({ partNumber: 1, blockId: "block-1", sizeBytes: "1" }),
    expect.objectContaining({ partNumber: 2, blockId: "block-2", sizeBytes: "1" }),
  ]);
  await store.assembleUpload(reserved.entryId, ["block-1", "block-2"]);
  const archivePath = await store.archiveForEntry(reserved.entryId);
  expect(await readFile(archivePath!, "utf8")).toBe("ab");
  await store.markReady(reserved.entryId, 2n);
  expect(await store.findReady({ githubRepositoryId: "124", scopes: ["refs/heads/main"], cacheKey: "missing", restoreKeys: ["npm-"], version: "v1" })).toMatchObject({ entryId: reserved.entryId, cacheKey: "npm-main" });
  now = new Date("2026-08-23T00:10:00.000Z");
  expect(await store.touchReady(reserved.entryId)).toMatchObject({ expiresAt: "2026-08-23T01:10:00.000Z" });
  expect(await store.findUploading(identity)).toMatchObject({ entryId: reserved.entryId });
  await expect(store.markReady(reserved.entryId, 2n)).resolves.toBeUndefined();
  await store.close();
});
test("matches primary and restore keys in GitHub cache precedence order", async () => {
  const root = await temporaryRoot();
  let now = new Date("2026-08-23T00:00:00.000Z");
  const store = await openActionCacheStore({ root, ttlSeconds: 3600, now: () => now });
  const createReady = async (cacheKey: string, minute: number) => {
    now = new Date(`2026-08-23T00:${String(minute).padStart(2, "0")}:00.000Z`);
    const reserved = (await store.reserveEntry({ githubRepositoryId: "125", scope: "refs/heads/main", cacheKey, version: "v1" }))!;
    await store.writeArchive(reserved.entryId, new Uint8Array([minute]));
    await store.markReady(reserved.entryId, 1n);
    return reserved.entryId;
  };
  const primaryPrefix = await createReady("primary-new", 1);
  const exactRestore = await createReady("restore", 2);
  await createReady("restore-newer", 3);

  await expect(store.findReady({ githubRepositoryId: "125", scopes: ["refs/heads/main"], cacheKey: "primary-", restoreKeys: ["restore"], version: "v1" }))
    .resolves.toMatchObject({ entryId: primaryPrefix, cacheKey: "primary-new" });
  await expect(store.findReady({ githubRepositoryId: "125", scopes: ["refs/heads/main"], cacheKey: "missing", restoreKeys: ["restore"], version: "v1" }))
    .resolves.toMatchObject({ entryId: exactRestore, cacheKey: "restore" });
  await store.close();
});
test("emits metadata upserts for fills and hits without cache bytes", async () => {
  const root = await temporaryRoot();
  const store = await openActionCacheStore({ root, ttlSeconds: 3600 });
  try {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    store.setTelemetrySink((type, payload) => events.push({ type, payload }));
    const reserved = (await store.reserveEntry({ githubRepositoryId: "124", scope: "scope", cacheKey: "key", version: "version" }))!;
    await store.writeArchive(reserved.entryId, new Uint8Array([1]));
    await store.markReady(reserved.entryId, 1n);
    await store.touchReady(reserved.entryId);
    expect(events.map((item) => item.type)).toEqual(["worker.cache_entry_upsert", "worker.cache_entry_upsert"]);
    expect(events[0]?.payload).not.toHaveProperty("bytes");
  } finally {
    await store.close();
  }
});

test("recomputes expiry from last access and removes expired bytes before returning", async () => {
  const root = await temporaryRoot();
  let now = new Date("2026-08-23T00:00:00.000Z");
  const store = await openActionCacheStore({ root, ttlSeconds: 3600, now: () => now });
  const reserved = (await store.reserveEntry({ githubRepositoryId: "456", scope: "scope", cacheKey: "key", version: "version" }))!;
  const archivePath = await store.writeArchive(reserved.entryId, new Uint8Array([1, 2, 3]));
  await store.markReady(reserved.entryId, 3n);
  now = new Date("2026-08-23T00:01:00.000Z");
  await store.applyTtl(30);
  expect(await store.status()).toEqual({ entryCount: 0, sizeBytes: "0" });
  await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  await store.close();
});
test("explicit sweep removes expired entries without a cache lookup", async () => {
  const root = await temporaryRoot();
  let now = new Date("2026-08-23T00:00:00.000Z");
  const store = await openActionCacheStore({ root, ttlSeconds: 60, now: () => now });
  const reserved = (await store.reserveEntry({ githubRepositoryId: "457", scope: "scope", cacheKey: "key", version: "version" }))!;
  const archivePath = await store.writeArchive(reserved.entryId, new Uint8Array([1]));
  await store.markReady(reserved.entryId, 1n);
  now = new Date("2026-08-23T00:02:00.000Z");
  await store.sweep();
  expect(store.status()).toEqual({ entryCount: 0, sizeBytes: "0" });
  await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  await store.close();
});
test("closes cleanly after sweeping a finalized block upload", async () => {
  const root = await temporaryRoot();
  let now = new Date("2026-08-23T00:00:00.000Z");
  const store = await openActionCacheStore({ root, ttlSeconds: 60, now: () => now });
  const reserved = (await store.reserveEntry({ githubRepositoryId: "458", scope: "scope", cacheKey: "key", version: "version" }))!;
  await store.writeUploadPartStream(reserved.entryId, 1, "block", new Response("abc").body!, 1024);
  await store.assembleUpload(reserved.entryId, ["block"]);
  await store.markReady(reserved.entryId, 3n);
  now = new Date("2026-08-23T00:02:00.000Z");
  await store.sweep();
  expect(store.status()).toEqual({ entryCount: 0, sizeBytes: "0" });
  expect(store.status()).toEqual({ entryCount: 0, sizeBytes: "0" });
  await expect(store.close()).resolves.toBeUndefined();
});

test("retries byte cleanup for entries left in deleting state", async () => {
  const root = await temporaryRoot();
  const store = await openActionCacheStore({ root, ttlSeconds: 3600 });
  const reserved = (await store.reserveEntry({ githubRepositoryId: "789", scope: "scope", cacheKey: "key", version: "version" }))!;
  const archivePath = await store.writeArchive(reserved.entryId, new Uint8Array([1, 2, 3]));
  await store.markReady(reserved.entryId, 3n);
  const database = new Database(join(root, "cache.sqlite"));
  database.query("UPDATE cache_entries SET state='deleting' WHERE entry_id=?").run(reserved.entryId);
  database.close();
  try {
    await store.applyTtl(3600);
    await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await store.close();
  }
});

test("persists the last applied TTL and uses it for restart recovery", async () => {
  const root = await temporaryRoot();
  let now = new Date("2026-08-23T00:00:00.000Z");
  const first = await openActionCacheStore({ root, ttlSeconds: 30, now: () => now });
  const reserved = (await first.reserveEntry({ githubRepositoryId: "790", scope: "scope", cacheKey: "key", version: "version" }))!;
  await first.writeArchive(reserved.entryId, new Uint8Array([1]));
  await first.markReady(reserved.entryId, 1n);
  await first.applyTtl(7200);
  await first.close();
  now = new Date("2026-08-23T01:00:00.000Z");
  const reopened = await openActionCacheStore({ root, ttlSeconds: 30, now: () => now });
  expect(reopened.ttlSeconds).toBe(7200);
  expect(await reopened.status()).toEqual({ entryCount: 1, sizeBytes: "1" });
  await reopened.close();
});

test("recovers interrupted uploads and unreferenced object files before reopening", async () => {
  const root = await temporaryRoot();
  const first = await openActionCacheStore({ root, ttlSeconds: 3600 });
  const identity = { githubRepositoryId: "791", scope: "scope", cacheKey: "key", version: "version" };
  const reserved = (await first.reserveEntry(identity))!;
  const archivePath = await first.writeArchive(reserved.entryId, new Uint8Array([1]));
  const partPath = await first.writeUploadPart(reserved.entryId, 1, "block", new Uint8Array([2]));
  const orphanArchive = join(root, "archives", "00000000-0000-4000-8000-000000000099.archive");
  const orphanPart = join(root, "blocks", "00000000-0000-4000-8000-000000000099.part");
  await writeFile(orphanArchive, "orphan");
  await writeFile(orphanPart, "orphan");
  await first.close();
  const reopened = await openActionCacheStore({ root, ttlSeconds: 3600 });
  expect(await reopened.reserveEntry(identity)).not.toBeNull();
  for (const path of [archivePath, partPath, orphanArchive, orphanPart]) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await reopened.close();
});

test("keeps finalization retryable until upload-part cleanup succeeds", async () => {
  const root = await temporaryRoot();
  let failPartCleanup = true;
  const store = await openActionCacheStore({
    root,
    ttlSeconds: 3600,
    removeFile: async (path: string) => {
      if (failPartCleanup && path.endsWith(".part")) throw new Error("part busy");
      await rm(path, { force: true });
    },
  });
  const reserved = (await store.reserveEntry({ githubRepositoryId: "792", scope: "scope", cacheKey: "key", version: "version" }))!;
  await store.writeArchive(reserved.entryId, new Uint8Array([1]));
  await store.writeUploadPart(reserved.entryId, 1, "block", new Uint8Array([2]));
  await expect(store.markReady(reserved.entryId, 1n)).rejects.toThrow("part busy");
  expect(await store.status()).toEqual({ entryCount: 0, sizeBytes: "0" });
  failPartCleanup = false;
  await expect(store.markReady(reserved.entryId, 1n)).resolves.toBeUndefined();
  expect(await store.status()).toEqual({ entryCount: 1, sizeBytes: "1" });
  await store.close();
});

test("readiness probe exercises the SQLite index and atomic object lifecycle", async () => {
  const root = await temporaryRoot();
  const store = await openActionCacheStore({ root, ttlSeconds: 3600 });
  await expect(store.probe()).resolves.toBeUndefined();
  await store.close();
});
