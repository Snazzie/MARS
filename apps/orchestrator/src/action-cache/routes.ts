import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ActionCacheStore } from "./store.ts";
export const CREATE_CACHE_ENTRY_PATH = "/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry";
export const FINALIZE_CACHE_ENTRY_UPLOAD_PATH = "/twirp/github.actions.results.api.v1.CacheService/FinalizeCacheEntryUpload";
export const GET_CACHE_ENTRY_DOWNLOAD_URL_PATH = "/twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL";
const CREATE = CREATE_CACHE_ENTRY_PATH;
const FINALIZE = FINALIZE_CACHE_ENTRY_UPLOAD_PATH;
const DOWNLOAD_URL = GET_CACHE_ENTRY_DOWNLOAD_URL_PATH;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

export type CacheMetadataWire = { repository_id: string; scope: Array<{ scope: string; permission: string }> };
export type CreateCacheEntryRequestWire = { metadata: CacheMetadataWire; key: string; version: string };
export type FinalizeCacheEntryUploadRequestWire = { metadata: CacheMetadataWire; key: string; size_bytes: string; version: string };
export type GetCacheEntryDownloadURLRequestWire = { metadata: CacheMetadataWire; key: string; restore_keys: string[]; version: string };

export type ReadyCacheEntry = { entryId: string; cacheKey: string; version: string; sizeBytes: string; expiresAt?: string; archivePath?: string };
export type UploadPart = { partNumber: number; blockId: string; path?: string; sizeBytes?: string };
/** Additional store operations used by the protocol boundary. Existing stores can implement these without changing the cache service lifecycle. */
export type ActionCacheRouteStore = Pick<ActionCacheStore, "reserveEntry" | "writeUploadPart" | "markReady"> & {
  findReady(input: { githubRepositoryId: string; scopes: string[]; cacheKey: string; restoreKeys: string[]; version: string }): Promise<ReadyCacheEntry | null>;
  findUploading(input: { githubRepositoryId: string; scope: string; cacheKey: string; version: string }): Promise<ReadyCacheEntry | null>;
  touchReady(entryId: string): Promise<ReadyCacheEntry>;
  archiveForEntry(entryId: string): Promise<string | null>;
  listUploadParts(entryId: string): Promise<UploadPart[]>;
  assembleUpload(entryId: string, orderedBlockIds: string[]): Promise<void>;
};

export type ActionCacheRouteDependencies = { cacheBaseUrl: string; store: ActionCacheRouteStore };
export type ActionCacheRoute = (request: Request) => Promise<Response>;
export type NodeActionCacheHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

function twirp(status: number, code: string, msg: string, extra: JsonObject = {}): Response { return Response.json({ code, msg, meta: extra }, { status, headers: { "content-type": "application/json" } }); }
function okJson(body: JsonObject): Response { return Response.json(body, { headers: { "content-type": "application/json" } }); }
function unsupportedMethod(): Response { return twirp(404, "unimplemented", "unsupported cache-service method"); }
function unsupportedContentType(): Response { return twirp(415, "unsupported_content_type", "cache-service JSON is required"); }
function badRequest(msg: string): Response { return twirp(400, "invalid_argument", msg); }
function stringField(value: unknown, name: string): string { if (typeof value !== "string") throw new Error(`${name} must be a string`); return value; }
function boundedText(value: unknown, name: string, max: number): string { const text = stringField(value, name); if ([...text].length < 1 || [...text].length > max || /[\0\r\n]/u.test(text)) throw new Error(`${name} is invalid`); return text; }
function decimalInt64(value: unknown, name: string, positive = false): string {
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || value < 0 || (positive && value < 1)) throw new Error(`${name} is invalid`); return String(value); }
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${name} is invalid`);
  let parsed: bigint; try { parsed = BigInt(value); } catch { throw new Error(`${name} is invalid`); }
  if (parsed > MAX_INT64 || (positive && parsed < 1n)) throw new Error(`${name} is invalid`);
  return String(parsed);
}
function metadata(value: unknown): CacheMetadataWire {
  if (!value || typeof value !== "object") throw new Error("metadata is invalid");
  const raw = value as JsonObject;
  const repository_id = decimalInt64(raw.repository_id, "repository_id", true);
  if (!Array.isArray(raw.scope) || raw.scope.length === 0) throw new Error("scope is invalid");
  const scope = raw.scope.map((item) => { if (!item || typeof item !== "object") throw new Error("scope is invalid"); const rawScope = item as JsonObject; return { scope: boundedText(rawScope.scope, "scope", 1024), permission: decimalInt64(rawScope.permission, "permission") }; });
  return { repository_id, scope };
}
function parseCreate(value: unknown): CreateCacheEntryRequestWire { if (!value || typeof value !== "object") throw new Error("request is invalid"); const raw = value as JsonObject; return { metadata: metadata(raw.metadata), key: boundedText(raw.key, "key", 512), version: boundedText(raw.version, "version", 128) }; }
function parseFinalize(value: unknown): FinalizeCacheEntryUploadRequestWire { if (!value || typeof value !== "object") throw new Error("request is invalid"); const raw = value as JsonObject; return { metadata: metadata(raw.metadata), key: boundedText(raw.key, "key", 512), size_bytes: decimalInt64(raw.size_bytes, "size_bytes"), version: boundedText(raw.version, "version", 128) }; }
function parseDownload(value: unknown): GetCacheEntryDownloadURLRequestWire { if (!value || typeof value !== "object") throw new Error("request is invalid"); const raw = value as JsonObject; if (!Array.isArray(raw.restore_keys) || raw.restore_keys.length > 10) throw new Error("restore_keys is invalid"); return { metadata: metadata(raw.metadata), key: boundedText(raw.key, "key", 512), restore_keys: raw.restore_keys.map((item) => boundedText(item, "restore_key", 512)), version: boundedText(raw.version, "version", 128) }; }
function baseUrl(origin: string, entryId: string): string { return new URL(`/_apis/artifactcache/cache/${entryId}`, origin).toString(); }
async function parseJson(request: Request): Promise<unknown> { try { return await request.json(); } catch { throw new Error("request JSON is invalid"); } }

function decodeBlockId(blockId: string): number {
  let bytes: Buffer; try { bytes = Buffer.from(blockId, "base64"); } catch { throw new Error("block ID is invalid"); }
  if (!bytes.length || bytes.toString("base64") !== blockId) throw new Error("block ID is invalid");
  if (bytes.length === 48) { const decimal = bytes.subarray(36).toString("ascii").replace(/\0+$/g, ""); if (!/^\d+$/.test(decimal)) throw new Error("block ID is invalid"); const index = Number(decimal); if (!Number.isSafeInteger(index)) throw new Error("block ID is invalid"); return index + 1; }
  if (bytes.length === 64) return bytes.readUInt32BE(16) + 1;
  throw new Error("block ID is invalid");
}
function xmlBlockIds(xml: string): string[] { if (/[\0]|<!DOCTYPE|<!ENTITY|<\?(?!xml)/i.test(xml)) throw new Error("block list XML is invalid"); const ids = [...xml.matchAll(/<Latest>([^<]*)<\/Latest>/gi)].map((match) => match[1]!.trim()); if (!ids.length || ids.some((id) => !id)) throw new Error("block list XML is invalid"); return ids; }
async function bodyBytes(request: Request): Promise<Uint8Array> { return new Uint8Array(await request.arrayBuffer()); }

async function handleTwirp(request: Request, path: string, dependencies: ActionCacheRouteDependencies): Promise<Response> {
  if (request.method !== "POST") return twirp(405, "method_not_allowed", "cache-service methods require POST");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return unsupportedContentType();
  let raw: unknown;
  try { raw = await parseJson(request); } catch (error) { return badRequest(error instanceof Error ? error.message : "request JSON is invalid"); }
  try {
    if (path === CREATE) {
      const input = parseCreate(raw);
      const reserved = await dependencies.store.reserveEntry({ githubRepositoryId: input.metadata.repository_id, scope: input.metadata.scope[0]!.scope, cacheKey: input.key, version: input.version });
      if (!reserved) return okJson({ ok: false, message: "cache entry already exists" });
      return okJson({ ok: true, signed_upload_url: baseUrl(dependencies.cacheBaseUrl, reserved.entryId) });
    }
    if (path === FINALIZE) {
      const input = parseFinalize(raw);
      const entry = await dependencies.store.findUploading({ githubRepositoryId: input.metadata.repository_id, scope: input.metadata.scope[0]!.scope, cacheKey: input.key, version: input.version });
      if (!entry) return okJson({ ok: false, message: "cache entry not found" });
      await dependencies.store.markReady(entry.entryId, BigInt(input.size_bytes));
      return okJson({ ok: true, entry_id: entry.entryId });
    }
    const input = parseDownload(raw);
    const entry = await dependencies.store.findReady({ githubRepositoryId: input.metadata.repository_id, scopes: input.metadata.scope.map((item) => item.scope), cacheKey: input.key, restoreKeys: input.restore_keys, version: input.version });
    if (!entry) return okJson({ ok: false });
    const touched = await dependencies.store.touchReady(entry.entryId);
    return okJson({ ok: true, signed_download_url: baseUrl(dependencies.cacheBaseUrl, touched.entryId), matched_key: touched.cacheKey });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "request is invalid");
  }
}
function range(value: string | null, size: number): { start: number; end: number } | null | false { if (!value) return null; const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim()); if (!match || (!match[1] && !match[2])) return false; let start: number; let end: number; if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return false; start = Math.max(0, size - suffix); end = size - 1; } else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; } if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return false; return { start, end: Math.min(end, size - 1) }; }
async function handleData(request: Request, dependencies: ActionCacheRouteDependencies): Promise<Response> {
  const url = new URL(request.url); const match = /^\/_apis\/artifactcache\/cache\/([0-9a-f-]{36})$/i.exec(url.pathname); if (!match || !UUID.test(match[1]!)) return new Response("not found\n", { status: 404 }); const entryId = match[1]!; if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "PUT") return twirp(405, "method_not_allowed", "unsupported cache data method");
  if (request.method === "PUT") { const comp = url.searchParams.get("comp"); try { if (comp === "block") { const blockId = url.searchParams.get("blockid"); if (!blockId) return badRequest("block ID is required"); const partNumber = decodeBlockId(blockId); if (partNumber < 1 || partNumber > 10_000) return badRequest("block ID is invalid"); const existing = await dependencies.store.listUploadParts(entryId); const prior = existing.find((part) => part.partNumber === partNumber); if (prior && prior.blockId !== blockId) return badRequest("duplicate block number has a different block ID"); if (prior) return badRequest("duplicate block ID"); await dependencies.store.writeUploadPart(entryId, partNumber, blockId, await bodyBytes(request)); return new Response(null, { status: 201 }); } if (comp === "blocklist") { const ids = xmlBlockIds(new TextDecoder().decode(await bodyBytes(request))); const parts = await dependencies.store.listUploadParts(entryId); if (new Set(ids).size !== ids.length || ids.length !== parts.length) return badRequest("block list must declare each block exactly once"); const expected = [...parts].sort((a, b) => a.partNumber - b.partNumber); if (expected.some((part, index) => part.partNumber !== index + 1 || part.blockId !== ids[index])) return badRequest("block list must be contiguous and match uploaded blocks"); await dependencies.store.assembleUpload(entryId, ids); const archive = await dependencies.store.archiveForEntry(entryId); if (!archive) return badRequest("upload entry not found"); await dependencies.store.markReady(entryId, BigInt(Bun.file(archive).size)); return new Response(null, { status: 201 }); } return badRequest("unsupported Azure upload operation"); } catch (error) { return badRequest(error instanceof Error ? error.message : "upload failed"); } }
  const archive = await dependencies.store.archiveForEntry(entryId); if (!archive) return new Response("not found\n", { status: 404 }); const file = Bun.file(archive); const size = file.size; const selected = range(request.headers.get("range"), size); if (selected === false) return new Response(null, { status: 416, headers: { "accept-ranges": "bytes", "content-range": `bytes */${size}` } }); const headers = new Headers({ "accept-ranges": "bytes", "content-length": String(selected ? selected.end - selected.start + 1 : size), "content-type": "application/octet-stream" }); if (!selected) return request.method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(file, { status: 200, headers }); headers.set("content-range", `bytes ${selected.start}-${selected.end}/${size}`); const bytes = new Uint8Array(await file.arrayBuffer()); return request.method === "HEAD" ? new Response(null, { status: 206, headers }) : new Response(bytes.subarray(selected.start, selected.end + 1), { status: 206, headers });
}
export function createActionCacheRoutes(dependencies: ActionCacheRouteDependencies): ActionCacheRoute { return async (request) => { const path = new URL(request.url).pathname; if (path === CREATE || path === FINALIZE || path === DOWNLOAD_URL) return handleTwirp(request, path, dependencies); if (path.startsWith("/_apis/artifactcache/cache/")) return handleData(request, dependencies); return unsupportedMethod(); }; }
export const createActionCacheRouter = createActionCacheRoutes;
export function createNodeActionCacheHandler(route: ActionCacheRoute): NodeActionCacheHandler {
  return async (request, response): Promise<void> => {
    const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
    const protocol = encrypted ? "https" : "http";
    const host = request.headers.host ?? "localhost";
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : Readable.toWeb(request) as unknown as BodyInit;
    const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, body, ...(body ? { duplex: "half" } : {}) };
    const result = await route(new Request(`${protocol}://${host}${request.url ?? "/"}`, init));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) Readable.fromWeb(result.body as never).pipe(response);
    else response.end();
  };
}
