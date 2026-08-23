import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createRemoteJWKSet, jwtVerify } from "jose";
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
export type CacheAuthorization = {
  githubRepositoryId: string;
  scopes: ReadonlyMap<string, number>;
};
export type CacheTokenVerifier = (request: Request) => Promise<CacheAuthorization | null>;
export type CacheGrantOperation = "upload" | "download";

export function createGitHubCacheTokenVerifier(options: { issuer?: string; jwksUrl?: string } = {}): CacheTokenVerifier {
  const issuer = options.issuer ?? "https://token.actions.githubusercontent.com";
  const jwksUrl = options.jwksUrl ?? "https://token.actions.githubusercontent.com/.well-known/jwks";
  const issuerUrl = new URL(issuer);
  const keysUrl = new URL(jwksUrl);
  if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) throw new Error("cache token issuer must be an HTTPS URL");
  if (keysUrl.protocol !== "https:" || keysUrl.username || keysUrl.password || keysUrl.hash) throw new Error("cache token JWKS URL must be HTTPS");
  const keys = createRemoteJWKSet(keysUrl);
  return async (request) => {
    const header = request.headers.get("authorization");
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header ?? "");
    if (!match) return null;
    try {
      const { payload } = await jwtVerify(match[1]!, keys, { issuer });
      const repositoryId = decimalInt64(payload.repository_id, "repository_id", true);
      const rawAccess = typeof payload.ac === "string" ? JSON.parse(payload.ac) : payload.ac;
      if (!Array.isArray(rawAccess) || rawAccess.length === 0) return null;
      const scopes = new Map<string, number>();
      for (const value of rawAccess) {
        if (!value || typeof value !== "object") return null;
        const item = value as Record<string, unknown>;
        const scope = boundedText(item.Scope ?? item.scope, "token scope", 1024);
        const permission = Number(item.Permission ?? item.permission);
        if (!Number.isSafeInteger(permission) || permission < 1 || permission > 3) return null;
        scopes.set(scope, (scopes.get(scope) ?? 0) | permission);
      }
      return { githubRepositoryId: repositoryId, scopes };
    } catch {
      return null;
    }
  };
}

export type ReadyCacheEntry = { entryId: string; cacheKey: string; version: string; sizeBytes: string; expiresAt?: string; archivePath?: string };
export type UploadPart = { partNumber: number; blockId: string; path?: string; sizeBytes?: string };
/** Additional store operations used by the protocol boundary. Existing stores can implement these without changing the cache service lifecycle. */
export type ActionCacheRouteStore = Pick<ActionCacheStore, "reserveEntry" | "writeUploadPartStream" | "markReady"> & {
  findReady(input: { githubRepositoryId: string; scopes: string[]; cacheKey: string; restoreKeys: string[]; version: string }): Promise<ReadyCacheEntry | null>;
  findUploading(input: { githubRepositoryId: string; scope: string; cacheKey: string; version: string }): Promise<ReadyCacheEntry | null>;
  touchReady(entryId: string): Promise<ReadyCacheEntry>;
  archiveForEntry(entryId: string): Promise<string | null>;
  listUploadParts(entryId: string): Promise<UploadPart[]>;
  assembleUpload(entryId: string, orderedBlockIds: string[]): Promise<void>;
};

export type ActionCacheRouteDependencies = {
  cacheBaseUrl: string;
  store: ActionCacheRouteStore;
  authorize?: (request: Request) => Promise<CacheAuthorization | null>;
  signedUrl?: (entryId: string, operation: CacheGrantOperation) => string;
  verifyGrant?: (request: Request, entryId: string, operation: CacheGrantOperation) => boolean;
};
export type ActionCacheRoute = (request: Request) => Promise<Response>;
export type NodeActionCacheHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

function twirp(status: number, code: string, msg: string, extra: JsonObject = {}): Response { return Response.json({ code, msg, meta: extra }, { status, headers: { "content-type": "application/json" } }); }
function okJson(body: JsonObject): Response { return Response.json(body, { headers: { "content-type": "application/json" } }); }
function unsupportedMethod(): Response { return twirp(404, "unimplemented", "unsupported cache-service method"); }
function unsupportedContentType(): Response { return twirp(415, "unsupported_content_type", "cache-service JSON is required"); }
function badRequest(msg: string): Response { return twirp(400, "invalid_argument", msg); }
function unauthenticated(): Response { return twirp(401, "unauthenticated", "valid GitHub Actions runtime token required"); }
function permissionDenied(): Response { return twirp(403, "permission_denied", "runtime token does not authorize this cache operation"); }
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
function signedUrl(dependencies: ActionCacheRouteDependencies, entryId: string, operation: CacheGrantOperation): string {
  return dependencies.signedUrl?.(entryId, operation) ?? baseUrl(dependencies.cacheBaseUrl, entryId);
}
async function parseJson(request: Request): Promise<unknown> { try { return await request.json(); } catch { throw new Error("request JSON is invalid"); } }
function authorizedScopes(authorization: CacheAuthorization, value: CacheMetadataWire, permission: 1 | 2): string[] {
  if (authorization.githubRepositoryId !== value.repository_id) return [];
  return value.scope
    .map((item) => item.scope)
    .filter((scope, index, scopes) => scopes.indexOf(scope) === index && ((authorization.scopes.get(scope) ?? 0) & permission) !== 0);
}

function decodeBlockId(blockId: string): number {
  let bytes: Buffer; try { bytes = Buffer.from(blockId, "base64"); } catch { throw new Error("block ID is invalid"); }
  if (!bytes.length || bytes.toString("base64") !== blockId) throw new Error("block ID is invalid");
  if (bytes.length === 48) { const decimal = bytes.subarray(36).toString("ascii").replace(/\0+$/g, ""); if (!/^\d+$/.test(decimal)) throw new Error("block ID is invalid"); const index = Number(decimal); if (!Number.isSafeInteger(index)) throw new Error("block ID is invalid"); return index + 1; }
  if (bytes.length === 64) return bytes.readUInt32BE(16) + 1;
  throw new Error("block ID is invalid");
}
function xmlBlockIds(xml: string): string[] { if (/[\0]|<!DOCTYPE|<!ENTITY|<\?(?!xml)/i.test(xml)) throw new Error("block list XML is invalid"); const ids = [...xml.matchAll(/<Latest>([^<]*)<\/Latest>/gi)].map((match) => match[1]!.trim()); if (!ids.length || ids.some((id) => !id)) throw new Error("block list XML is invalid"); return ids; }
async function bodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body;
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function handleTwirp(request: Request, path: string, dependencies: ActionCacheRouteDependencies): Promise<Response> {
  if (request.method !== "POST") return twirp(405, "method_not_allowed", "cache-service methods require POST");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return unsupportedContentType();
  const authorization = await dependencies.authorize?.(request) ?? null;
  if (!authorization) return unauthenticated();
  let raw: unknown;
  try { raw = await parseJson(request); } catch (error) { return badRequest(error instanceof Error ? error.message : "request JSON is invalid"); }
  try {
    if (path === CREATE) {
      const input = parseCreate(raw);
      const scopes = authorizedScopes(authorization, input.metadata, 2);
      if (!scopes.length) return permissionDenied();
      const reserved = await dependencies.store.reserveEntry({ githubRepositoryId: authorization.githubRepositoryId, scope: scopes[0]!, cacheKey: input.key, version: input.version });
      if (!reserved) return okJson({ ok: false, message: "cache entry already exists" });
      return okJson({ ok: true, signed_upload_url: signedUrl(dependencies, reserved.entryId, "upload") });
    }
    if (path === FINALIZE) {
      const input = parseFinalize(raw);
      const scopes = authorizedScopes(authorization, input.metadata, 2);
      if (!scopes.length) return permissionDenied();
      const entry = await dependencies.store.findUploading({ githubRepositoryId: authorization.githubRepositoryId, scope: scopes[0]!, cacheKey: input.key, version: input.version });
      if (!entry) return okJson({ ok: false, message: "cache entry not found" });
      await dependencies.store.markReady(entry.entryId, BigInt(input.size_bytes));
      return okJson({ ok: true, entry_id: entry.entryId });
    }
    const input = parseDownload(raw);
    const scopes = authorizedScopes(authorization, input.metadata, 1);
    if (!scopes.length) return permissionDenied();
    const entry = await dependencies.store.findReady({ githubRepositoryId: authorization.githubRepositoryId, scopes, cacheKey: input.key, restoreKeys: input.restore_keys, version: input.version });
    if (!entry) return okJson({ ok: false });
    const touched = await dependencies.store.touchReady(entry.entryId);
    return okJson({ ok: true, signed_download_url: signedUrl(dependencies, touched.entryId, "download"), matched_key: touched.cacheKey });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "request is invalid");
  }
}
function range(value: string | null, size: number): { start: number; end: number } | null | false { if (!value) return null; const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim()); if (!match || (!match[1] && !match[2])) return false; let start: number; let end: number; if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return false; start = Math.max(0, size - suffix); end = size - 1; } else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; } if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return false; return { start, end: Math.min(end, size - 1) }; }
async function handleData(request: Request, dependencies: ActionCacheRouteDependencies): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/_apis\/artifactcache\/cache\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (!match || !UUID.test(match[1]!)) return new Response("not found\n", { status: 404 });
  const entryId = match[1]!;
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "PUT") return twirp(405, "method_not_allowed", "unsupported cache data method");
  const operation = request.method === "PUT" ? "upload" : "download";
  if (!dependencies.verifyGrant?.(request, entryId, operation)) return twirp(403, "permission_denied", "valid cache operation grant required");
  if (request.method === "PUT") {
    const comp = url.searchParams.get("comp");
    try {
      if (comp === "block") {
        const blockId = url.searchParams.get("blockid");
        if (!blockId) return badRequest("block ID is required");
        const partNumber = decodeBlockId(blockId);
        if (partNumber < 1 || partNumber > 10_000) return badRequest("block ID is invalid");
        const contentLength = request.headers.get("content-length");
        if (contentLength && (!/^\d+$/.test(contentLength) || BigInt(contentLength) > 128n * 1024n * 1024n)) return twirp(413, "resource_exhausted", "cache upload block exceeds 128 MiB");
        const existing = await dependencies.store.listUploadParts(entryId);
        const prior = existing.find((part) => part.partNumber === partNumber);
        if (prior && prior.blockId !== blockId) return badRequest("duplicate block number has a different block ID");
        if (prior) return badRequest("duplicate block ID");
        if (!request.body) return badRequest("cache upload block body is required");
        await dependencies.store.writeUploadPartStream(entryId, partNumber, blockId, request.body, 128 * 1024 * 1024);
        return new Response(null, { status: 201 });
      }
      if (comp === "blocklist") {
        const ids = xmlBlockIds(new TextDecoder().decode(await bodyBytes(request, 1024 * 1024)));
        const parts = await dependencies.store.listUploadParts(entryId);
        if (new Set(ids).size !== ids.length || ids.length !== parts.length) return badRequest("block list must declare each block exactly once");
        const expected = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        if (expected.some((part, index) => part.partNumber !== index + 1 || part.blockId !== ids[index])) return badRequest("block list must be contiguous and match uploaded blocks");
        await dependencies.store.assembleUpload(entryId, ids);
        const archive = await dependencies.store.archiveForEntry(entryId);
        if (!archive) return badRequest("upload entry not found");
        await dependencies.store.markReady(entryId, BigInt(Bun.file(archive).size));
        return new Response(null, { status: 201 });
      }
      return badRequest("unsupported Azure upload operation");
    } catch (error) {
      if (error instanceof Error && error.message === "cache upload block is too large") return twirp(413, "resource_exhausted", error.message);
      return badRequest(error instanceof Error ? error.message : "upload failed");
    }
  }
  const archive = await dependencies.store.archiveForEntry(entryId);
  if (!archive) return new Response("not found\n", { status: 404 });
  const file = Bun.file(archive);
  const size = file.size;
  const selected = range(request.headers.get("range"), size);
  if (selected === false) return new Response(null, { status: 416, headers: { "accept-ranges": "bytes", "content-range": `bytes */${size}` } });
  const headers = new Headers({ "accept-ranges": "bytes", "content-length": String(selected ? selected.end - selected.start + 1 : size), "content-type": "application/octet-stream" });
  if (!selected) return request.method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(file, { status: 200, headers });
  headers.set("content-range", `bytes ${selected.start}-${selected.end}/${size}`);
  return request.method === "HEAD" ? new Response(null, { status: 206, headers }) : new Response(file.slice(selected.start, selected.end + 1), { status: 206, headers });
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
