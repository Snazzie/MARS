import { expect, test } from "bun:test";
import { createActionCacheRoutes } from "./routes.ts";

test("returns explicit unsupported response for unknown cache-service methods", async () => {
  const route = createActionCacheRoutes({
    cacheBaseUrl: "https://cache.example.test",
    store: {} as never,
  });
  const response = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/Unknown", { method: "POST" }));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "unimplemented", msg: "unsupported cache-service method", meta: {} });
});

test("rejects invalid protobuf content type without forwarding", async () => {
  const route = createActionCacheRoutes({
    cacheBaseUrl: "https://cache.example.test",
    store: {} as never,
  });
  const response = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/protobuf" }, body: "" }));
  expect(response.status).toBe(415);
  expect(await response.json()).toEqual({ code: "unsupported_content_type", msg: "cache-service JSON is required", meta: {} });
});
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function blockId(index: number): string {
  const bytes = Buffer.alloc(48);
  Buffer.from(String(index)).copy(bytes, 36);
  return bytes.toString("base64");
}

function fixture() {
  const entries = new Map<string, { entryId: string; cacheKey: string; version: string; sizeBytes: string; archivePath: string; expiresAt: string }>();
  const parts = new Map<string, { partNumber: number; blockId: string; bytes: Uint8Array }[]>();
  let sequence = 0;
  const store = {
    reserveEntry: async ({ cacheKey, version }: { githubRepositoryId: string; scope: string; cacheKey: string; version: string }) => {
      if ([...entries.values()].some((entry) => entry.cacheKey === cacheKey && entry.version === version)) return null;
      const entryId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const archivePath = join(tmpdir(), `cache-route-${entryId}.archive`);
      const entry = { entryId, cacheKey, version, sizeBytes: "0", archivePath, expiresAt: "2026-08-24T00:00:00.000Z" };
      entries.set(entryId, entry);
      return { entryId, archivePath, expiresAt: entry.expiresAt };
    },
    writeArchive: async () => "",
    writeUploadPart: async (entryId: string, partNumber: number, id: string, bytes: Uint8Array) => { const current = parts.get(entryId) ?? []; current.push({ partNumber, blockId: id, bytes }); parts.set(entryId, current); return ""; },
    markReady: async (entryId: string, sizeBytes: bigint) => { const entry = entries.get(entryId)!; entry.sizeBytes = String(sizeBytes); },
    findReady: async ({ cacheKey, version }: { githubRepositoryId: string; scopes: string[]; cacheKey: string; restoreKeys: string[]; version: string }) => [...entries.values()].find((entry) => entry.cacheKey === cacheKey && entry.version === version) ?? null,
    findUploading: async ({ cacheKey, version }: { githubRepositoryId: string; scope: string; cacheKey: string; version: string }) => [...entries.values()].find((entry) => entry.cacheKey === cacheKey && entry.version === version) ?? null,
    touchReady: async (entryId: string) => entries.get(entryId)!,
    archiveForEntry: async (entryId: string) => entries.get(entryId)?.archivePath ?? null,
    listUploadParts: async (entryId: string) => parts.get(entryId) ?? [],
    assembleUpload: async (entryId: string, ids: string[]) => { const entry = entries.get(entryId)!; const bytes = Buffer.concat((parts.get(entryId) ?? []).sort((a, b) => a.partNumber - b.partNumber).filter((part) => ids.includes(part.blockId)).map((part) => Buffer.from(part.bytes))); await writeFile(entry.archivePath, bytes); },
    removeEntry: async () => undefined,
  };
  const route = createActionCacheRoutes({ cacheBaseUrl: "https://cache.example.test", store: store as never });
  return { route, entries };
}

test("creates an immutable cache entry without an authorization layer", async () => {
  const { route } = fixture();
  const response = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "linux-node", version: "v1" }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, signed_upload_url: expect.stringContaining("/_apis/artifactcache/cache/") });
});

test("finalizes an uploading entry and returns its immutable entry ID", async () => {
  const { route } = fixture();
  await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "k", version: "v" }) }));
  const response = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/FinalizeCacheEntryUpload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "k", size_bytes: "0", version: "v" }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, entry_id: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
});

test("accepts the repository and scope declared by the local cache client", async () => {
  const { route } = fixture();
  const response = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "2", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "k", version: "v" }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
});

test("uploads Azure blocks and serves full, HEAD, and byte-range downloads", async () => {
  const { route, entries } = fixture();
  const create = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "k", version: "v" }) }));
  const uploadUrl = (await create.json()).signed_upload_url as string;
  const id0 = blockId(0);
  const id1 = blockId(1);
  expect((await route(new Request(`${uploadUrl}?comp=block&blockid=${encodeURIComponent(id0)}`, { method: "PUT", body: "abc" }))).status).toBe(201);
  expect((await route(new Request(`${uploadUrl}?comp=block&blockid=${encodeURIComponent(id1)}`, { method: "PUT", body: "def" }))).status).toBe(201);
  const list = "<BlockList><Latest>" + id0 + "</Latest><Latest>" + id1 + "</Latest></BlockList>";
  expect((await route(new Request(`${uploadUrl}?comp=blocklist`, { method: "PUT", body: list }))).status).toBe(201);
  const entryId = [...entries.keys()][0]!;
  const download = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "1" }] }, key: "k", restore_keys: [], version: "v" }) }));
  const downloadUrl = (await download.json()).signed_download_url as string;
  expect(await (await route(new Request(downloadUrl))).text()).toBe("abcdef");
  expect((await route(new Request(downloadUrl, { method: "HEAD" }))).headers.get("content-length")).toBe("6");
  const ranged = await route(new Request(downloadUrl, { headers: { range: "bytes=1-3" } }));
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("content-range")).toBe("bytes 1-3/6");
  expect(await ranged.text()).toBe("bcd");
  expect(entries.has(entryId)).toBe(true);
});
