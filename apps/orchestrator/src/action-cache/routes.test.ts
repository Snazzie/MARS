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

function fixture(githubRepositoryId = "1") {
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
    writeUploadPartStream: async (entryId: string, partNumber: number, id: string, body: ReadableStream<Uint8Array>, maxBytes: number) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error("cache upload block is too large");
      const current = parts.get(entryId) ?? [];
      current.push({ partNumber, blockId: id, bytes });
      parts.set(entryId, current);
      return "";
    },
    markReady: async (entryId: string, sizeBytes: bigint) => { const entry = entries.get(entryId)!; entry.sizeBytes = String(sizeBytes); },
    findReady: async ({ cacheKey, version }: { githubRepositoryId: string; scopes: string[]; cacheKey: string; restoreKeys: string[]; version: string }) => [...entries.values()].find((entry) => entry.cacheKey === cacheKey && entry.version === version) ?? null,
    findUploading: async ({ cacheKey, version }: { githubRepositoryId: string; scope: string; cacheKey: string; version: string }) => [...entries.values()].find((entry) => entry.cacheKey === cacheKey && entry.version === version) ?? null,
    touchReady: async (entryId: string) => entries.get(entryId)!,
    archiveForEntry: async (entryId: string) => entries.get(entryId)?.archivePath ?? null,
    listUploadParts: async (entryId: string) => parts.get(entryId) ?? [],
    assembleUpload: async (entryId: string, ids: string[]) => { const entry = entries.get(entryId)!; const bytes = Buffer.concat((parts.get(entryId) ?? []).sort((a, b) => a.partNumber - b.partNumber).filter((part) => ids.includes(part.blockId)).map((part) => Buffer.from(part.bytes))); await writeFile(entry.archivePath, bytes); },
    removeEntry: async () => undefined,
  };
  const route = createActionCacheRoutes({
    cacheBaseUrl: "https://cache.example.test",
    store: store as never,
    authorize: async () => ({ githubRepositoryId, scopes: new Map([["refs/heads/main", 3]]) }),
    signedUrl: (entryId, operation) => {
      const url = new URL(`/_apis/artifactcache/cache/${entryId}`, "https://cache.example.test");
      url.searchParams.set("op", operation);
      url.searchParams.set("sig", `${operation}-${entryId}`);
      return url.toString();
    },
    verifyGrant: (request, entryId, operation) => new URL(request.url).searchParams.get("sig") === `${operation}-${entryId}`,
  });
  return { route, entries };
}

test("rejects cache RPCs without a verified GitHub runtime token", async () => {
  const route = createActionCacheRoutes({ cacheBaseUrl: "https://cache.example.test", store: {} as never });
  const response = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "linux-node", version: "v1" }) }));
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "unauthenticated" });
});

test("finalizes an uploading entry and returns its immutable entry ID", async () => {
  const { route } = fixture();
  await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "k", version: "v" }) }));
  const response = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/FinalizeCacheEntryUpload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "k", size_bytes: "0", version: "v" }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, entry_id: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
});

test("rejects repository metadata that exceeds the runtime token", async () => {
  const { route } = fixture();
  const response = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "2", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "k", version: "v" }) }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "permission_denied" });
});

test("uploads Azure blocks and serves full, HEAD, and byte-range downloads", async () => {
  const { route, entries } = fixture();
  const create = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "k", version: "v" }) }));
  const uploadUrl = (await create.json()).signed_upload_url as string;
  const id0 = blockId(0);
  expect(new URL(uploadUrl).searchParams.get("sig")).not.toBeNull();
  const id1 = blockId(1);
  const firstBlockUrl = new URL(uploadUrl);
  firstBlockUrl.searchParams.set("comp", "block");
  firstBlockUrl.searchParams.set("blockid", id0);
  expect((await route(new Request(firstBlockUrl, { method: "PUT", body: "abc" }))).status).toBe(201);
  const secondBlockUrl = new URL(uploadUrl);
  secondBlockUrl.searchParams.set("comp", "block");
  secondBlockUrl.searchParams.set("blockid", id1);
  expect((await route(new Request(secondBlockUrl, { method: "PUT", body: "def" }))).status).toBe(201);
  const list = "<BlockList><Latest>" + id0 + "</Latest><Latest>" + id1 + "</Latest></BlockList>";
  const blockListUrl = new URL(uploadUrl);
  blockListUrl.searchParams.set("comp", "blocklist");
  expect((await route(new Request(blockListUrl, { method: "PUT", body: list }))).status).toBe(201);
  const entryId = [...entries.keys()][0]!;
  const download = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "1" }] }, key: "k", restore_keys: [], version: "v" }) }));
  const downloadUrl = (await download.json()).signed_download_url as string;
  expect(await (await route(new Request(downloadUrl))).text()).toBe("abcdef");
  expect((await route(new Request(downloadUrl, { method: "HEAD" }))).headers.get("content-length")).toBe("6");
  const tampered = new URL(downloadUrl);
  tampered.searchParams.set("sig", "tampered");
  expect((await route(new Request(tampered))).status).toBe(403);
  const ranged = await route(new Request(downloadUrl, { headers: { range: "bytes=1-3" } }));
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("content-range")).toBe("bytes 1-3/6");
  expect(await ranged.text()).toBe("bcd");
  expect(entries.has(entryId)).toBe(true);
});
test("rejects an oversized upload block before buffering its body", async () => {
  const { route } = fixture();
  const create = await route(new Request("https://cache.example.test/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { repository_id: "1", scope: [{ scope: "refs/heads/main", permission: "2" }] }, key: "large", version: "v1" }) }));
  const createBody: unknown = await create.json();
  if (!createBody || typeof createBody !== "object" || !("signed_upload_url" in createBody) || typeof createBody.signed_upload_url !== "string") throw new Error("cache create response missing upload URL");
  const uploadUrl = new URL(createBody.signed_upload_url);
  uploadUrl.searchParams.set("comp", "block");
  uploadUrl.searchParams.set("blockid", blockId(0));
  const response = await route(new Request(uploadUrl, { method: "PUT", headers: { "content-length": String(128 * 1024 * 1024 + 1) }, body: "small" }));
  expect(response.status).toBe(413);
});
