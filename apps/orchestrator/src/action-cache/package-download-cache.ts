import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { secureWorkerPrivatePath } from "./store.ts";

export const PUBLIC_DOWNLOAD_HOSTS = ["registry.npmjs.org", "cdn.playwright.dev", "playwright.download.prss.microsoft.com", "github.com", "nodejs.org"] as const;
const PACKAGE_HOST = PUBLIC_DOWNLOAD_HOSTS[0];
const GITHUB_RELEASE_REDIRECT_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);
const CACHEABLE_HOSTS = new Set(PUBLIC_DOWNLOAD_HOSTS);
const SCHEMA_VERSION = 1;
const FILL_MAX_AGE_MS = 60 * 60 * 1_000;
const CACHE_HEADERS = ["content-type", "content-length", "content-encoding", "etag", "last-modified", "cache-control"] as const;
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

type HeaderValue = string | string[];
type HeaderMap = Record<string, HeaderValue>;
type Clock = () => Date;
type PackageEntry = {
  urlHash: string;
  canonicalUrl: string;
  objectPathId: string;

  state: "filling" | "ready" | "deleting";
  responseHeaders: string;
  sizeBytes: string;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
};

type FillResult = { published: boolean; generation: number };

type CapturedResponse = {
  statusCode: number;
  headers: HeaderMap;
  sizeBytes: number;
  stagingPath: string;
};

export type PackageDownloadCacheMutation = {
  type: "worker.runner_cache_status";
  payload: { sizeBytes: string; entryCount: number; hitCount?: number; missCount?: number };
};
export type PackageDownloadCacheTelemetrySink = (
  type: PackageDownloadCacheMutation["type"],
  payload: PackageDownloadCacheMutation["payload"],
) => void;
export type PackageUpstreamHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

function requireTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("cache TTL must be a positive safe integer");
}
function requireMaxBytes(maxBytes: bigint): void {
  if (typeof maxBytes !== "bigint" || maxBytes <= 0n) throw new Error("runner cache size cap must be a positive bigint");
}

function hostFor(request: IncomingMessage): string {
  const value = request.headers.host;
  if (Array.isArray(value)) return "";
  if (!value) return "";
  try {
    const parsed = new URL(`https://${value}`);
    if (parsed.port && parsed.port !== "443") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}
function canonicalUrlFor(request: IncomingMessage): string | null {
  if (request.method?.toUpperCase() !== "GET") return null;
  const host = hostFor(request);
  if (!CACHEABLE_HOSTS.has(host as typeof PUBLIC_DOWNLOAD_HOSTS[number])) return null;
  const rawUrl = request.url ?? "";
  if (rawUrl.includes("?") || rawUrl.includes("#") || rawUrl.includes("\\") || /%2f|%5c|%2e/i.test(rawUrl)) return null;
  let url: URL;
  try { url = new URL(rawUrl, `https://${host}`); } catch { return null; }
  if (url.hostname.toLowerCase() !== host || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname;
  if (rawUrl.includes("/../") || rawUrl.includes("/./")) return null;
  const npmMatch = /^\/(?:@[^/]+\/)?([^/]+)\/-\/([^/]+)-([0-9]+\.[0-9]+\.[0-9]+)\.tgz$/.exec(pathname);
  const npm = npmMatch !== null && npmMatch[1] === npmMatch[2];
  const bun = /^\/oven-sh\/bun\/releases\/download\/bun-v[0-9]+\.[0-9]+\.[0-9]+\/bun-windows-(?:x64|x64-baseline|x64-profile|x64-baseline-profile|aarch64|aarch64-profile)\.zip$/.test(pathname);
  const githubNodeMatch = /^\/actions\/node-versions\/releases\/download\/([0-9]+\.[0-9]+\.[0-9]+)-[^/]+\/node-([0-9]+\.[0-9]+\.[0-9]+)-win32-(?:x64|x86|arm64)\.7z$/.exec(pathname);
  const nodeDistMatch = /^\/dist\/v([0-9]+\.[0-9]+\.[0-9]+)\/node-v([0-9]+\.[0-9]+\.[0-9]+)-win-(?:x64|x86|arm64)\.(?:7z|zip)$/.exec(pathname);
  const node = (githubNodeMatch !== null && githubNodeMatch[1] === githubNodeMatch[2])
    || (nodeDistMatch !== null && nodeDistMatch[1] === nodeDistMatch[2])
    || /^\/dist\/v[0-9]+\.[0-9]+\.[0-9]+\/win-(?:x64|x86|arm64)\/node\.(?:exe|lib)$/.test(pathname);
  const playwright = host === "cdn.playwright.dev"
    ? /^\/builds\/(?:chromium|chromium-headless-shell|firefox|webkit|ffmpeg|winldd)\/[1-9]\d*\/[A-Za-z0-9._-]+\.(?:zip|tar\.gz)$/.test(pathname)
    : host === "playwright.download.prss.microsoft.com"
      ? /^\/dbazure\/download\/playwright\/builds\/(?:chromium|chromium-headless-shell|firefox|webkit|ffmpeg|winldd)\/[1-9]\d*\/[A-Za-z0-9._-]+\.(?:zip|tar\.gz)$/.test(pathname)
      : false;
  const validPath = host === PACKAGE_HOST ? npm : host === "github.com" ? (bun || node) : host === "nodejs.org" ? node : playwright;
  if (!validPath) return null;
  if (["authorization", "cookie", "range", "if-none-match", "if-modified-since"].some((name) => request.headers[name] !== undefined)) return null;
  const cacheControl = request.headers["cache-control"];
  if (typeof cacheControl === "string" && /(?:^|,)\s*no-(?:cache|store)\s*(?:,|$)/i.test(cacheControl)) return null;
  return `https://${host}${pathname}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoAfter(date: Date, ttlSeconds: number): string {
  return new Date(date.getTime() + ttlSeconds * 1_000).toISOString();
}

function headerMap(headers: IncomingHttpHeaders): HeaderMap {
  const result: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? [...value] : value;
  }
  return result;
}

function selectedHeaders(headers: HeaderMap): HeaderMap {
  const result: HeaderMap = {};
  for (const name of CACHE_HEADERS) {
    const value = headers[name];
    if (value !== undefined) result[name] = Array.isArray(value) ? [...value] : value;
  }
  return result;
}

function hasHeader(headers: HeaderMap, name: string): boolean {
  return headers[name.toLowerCase()] !== undefined;
}

function contentLength(headers: HeaderMap): bigint | null {
  const value = headers["content-length"];
  if (Array.isArray(value) || value === undefined || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

class StreamingCaptureResponse extends Writable {
  statusCode: number;
  readonly headers: HeaderMap = {};
  sizeBytes = 0;
  readonly stagingPath: string;
  readonly #client: ServerResponse;
  readonly #staging: WriteStream;

  constructor(client: ServerResponse, stagingPath: string) {
    super();
    this.#client = client;
    this.stagingPath = stagingPath;
    this.statusCode = client.statusCode || 200;
    this.#staging = createWriteStream(stagingPath, { flags: "wx", mode: 0o600 });
    for (const [name, header] of Object.entries(client.getHeaders())) {
      if (header !== undefined) this.headers[name.toLowerCase()] = Array.isArray(header) ? [...header] : String(header);
    }
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? [...value] : String(value);
    this.#client.setHeader(name, value);
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  getHeaders(): HeaderMap {
    return { ...this.headers };
  }

  hasHeader(name: string): boolean {
    return this.getHeader(name) !== undefined;
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
    this.#client.removeHeader(name);
  }

  writeHead(statusCode: number, reasonOrHeaders?: string | IncomingHttpHeaders, maybeHeaders?: IncomingHttpHeaders): this {
    this.statusCode = statusCode;
    const supplied = typeof reasonOrHeaders === "string" ? maybeHeaders : reasonOrHeaders;
    if (supplied) {
      for (const [name, value] of Object.entries(supplied)) {
        if (value !== undefined) this.headers[name.toLowerCase()] = Array.isArray(value) ? [...value] : String(value);
      }
    }
    const headers = { ...supplied, "x-mars-package-cache": "MISS" };
    if (typeof reasonOrHeaders === "string") this.#client.writeHead(statusCode, reasonOrHeaders, headers);
    else this.#client.writeHead(statusCode, headers);
    return this;
  }

  #prepareClient(): void {
    if (this.#client.headersSent) return;
    this.#client.statusCode = this.statusCode;
    this.#client.setHeader("x-mars-package-cache", "MISS");
  }

  _write(chunk: Buffer | string | Uint8Array, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk, encoding);
    this.sizeBytes += bytes.length;
    this.#prepareClient();
    let pending = 2;
    let failure: Error | null = null;
    const complete = (error?: Error | null) => {
      if (error && !failure) failure = error;
      pending -= 1;
      if (pending === 0) callback(failure);
    };
    this.#client.write(bytes, complete);
    this.#staging.write(bytes, complete);
  }

  _final(callback: (error?: Error | null) => void): void {
    this.#prepareClient();
    this.#staging.end(callback);
  }

  captured(): CapturedResponse {
    return { statusCode: this.statusCode, headers: this.headers, sizeBytes: this.sizeBytes, stagingPath: this.stagingPath };
  }
}

function requestPath(request: IncomingMessage): string { return request.url || "/"; }

function forwardHeaders(request: IncomingMessage, host: string): Record<string, string | string[]> {
  const connectionTokens = new Set(
    String(request.headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lowerName) || connectionTokens.has(lowerName) || lowerName === "host" || lowerName === "proxy-authorization") continue;
    result[name] = Array.isArray(value) ? [...value] : value;
  }
  result.host = host;
  return result;
}

export const forwardPublicNpmRequest: PackageUpstreamHandler = async (request, response) => {
  const host = hostFor(request);
  if (!CACHEABLE_HOSTS.has(host as typeof PUBLIC_DOWNLOAD_HOSTS[number])) {
    response.writeHead(421, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("unsupported upstream host\n");
    return;
  }
  const anonymousGitHubDownload = request.method === "GET" && host === "github.com" && request.headers.authorization === undefined && request.headers.cookie === undefined;
  let activeUpstream: ClientRequest | undefined;
  request.once("aborted", () => activeUpstream?.destroy(new Error("downstream request aborted")));
  const forward = (target: URL, redirectsRemaining: number, pipeRequestBody: boolean): Promise<void> => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const upstream = httpsRequest({
      hostname: target.hostname,
      port: target.port ? Number(target.port) : 443,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: forwardHeaders(request, target.host),
    }, (incoming) => {
      const statusCode = incoming.statusCode ?? 502;
      const location = incoming.headers.location;
      if (anonymousGitHubDownload && redirectsRemaining > 0 && statusCode >= 300 && statusCode < 400 && typeof location === "string") {
        let redirected: URL;
        try { redirected = new URL(location, target); } catch { redirected = new URL("http://invalid"); }
        if (redirected.protocol === "https:" && !redirected.username && !redirected.password && GITHUB_RELEASE_REDIRECT_HOSTS.has(redirected.hostname.toLowerCase())) {
          incoming.resume();
          incoming.once("error", reject);
          incoming.once("end", () => forward(redirected, redirectsRemaining - 1, false).then(resolve, reject));
          return;
        }
      }
      response.writeHead(statusCode, headerMap(incoming.headers));
      incoming.on("error", reject);
      incoming.on("end", resolve);
      incoming.pipe(response);
    });
    activeUpstream = upstream;
    upstream.on("error", (error) => {
      if (!response.headersSent) response.destroy(error);
      reject(error);
    });
    if (pipeRequestBody) request.pipe(upstream);
    else upstream.end();
    return promise;
  };
  await forward(new URL(requestPath(request), `https://${host}`), 5, true);
};

export interface PackageDownloadCache {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  applyTtl(ttlSeconds: number): Promise<void>;
  setEnabled(enabled: boolean): void;
  setMaxBytes(maxBytes: bigint): void;
  purge(): Promise<void>;
  sweep(): Promise<void>;
  probe(): Promise<void>;
  status(): { sizeBytes: string; entryCount: number; hitCount?: number; missCount?: number };
  setTelemetrySink(sink: PackageDownloadCacheTelemetrySink | null): void;
  close(): Promise<void>;
}

class SqlitePackageDownloadCache implements PackageDownloadCache {
  readonly #root: string;
  readonly #objects: string;
  readonly #staging: string;
  readonly #probes: string;
  readonly #db: Database;
  readonly #now: Clock;
  readonly #upstream: PackageUpstreamHandler;
  readonly #flights = new Map<string, Promise<FillResult>>();
  readonly #activeFills = new Set<Promise<FillResult>>();
  #ttlSeconds: number;
  #maxBytes = 20n * 1024n ** 3n;
  #eviction: Promise<void> | null = null;
  #enabled = true;
  #generation = 0;
  #closed = false;
  #telemetrySink: PackageDownloadCacheTelemetrySink | null = null;
  #hitCount = 0;
  #missCount = 0;

  constructor(root: string, db: Database, ttlSeconds: number, now: Clock, upstream: PackageUpstreamHandler) {
    this.#root = root;
    this.#objects = join(root, "objects");
    this.#staging = join(root, "staging");
    this.#probes = join(root, "probes");
    this.#db = db;
    this.#ttlSeconds = ttlSeconds;
    this.#now = now;
    this.#upstream = upstream;
  }
  status(): { sizeBytes: string; entryCount: number; hitCount: number; missCount: number } {
    const aggregate = this.#db.query<{ sizeBytes: string | number; entryCount: number }, []>(
      "SELECT COALESCE(SUM(CAST(size_bytes AS INTEGER)), 0) AS sizeBytes, COUNT(*) AS entryCount FROM package_entries WHERE state='ready'",
    ).get();
    return { sizeBytes: String(aggregate?.sizeBytes ?? 0), entryCount: Number(aggregate?.entryCount ?? 0), hitCount: this.#hitCount, missCount: this.#missCount };
  }
  #emitMutation(): void {
    try { this.#telemetrySink?.("worker.runner_cache_status", this.status()); } catch { /* telemetry is best effort */ }
  }
  setTelemetrySink(sink: PackageDownloadCacheTelemetrySink | null): void { this.#telemetrySink = sink; }
  #assertOpen(): void { if (this.#closed) throw new Error("package download cache is closed"); }
  #objectPath(pathId: string): string { return join(this.#objects, `${pathId}.blob`); }

  #row(canonicalUrl: string): PackageEntry | null {
    return this.#db.query<PackageEntry, [string]>(`SELECT url_hash AS urlHash,canonical_url AS canonicalUrl,object_path_id AS objectPathId,state,response_headers AS responseHeaders,size_bytes AS sizeBytes,created_at AS createdAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM package_entries WHERE url_hash=?`).get(hash(canonicalUrl)) ?? null;
  }
  async #evict(row: PackageEntry): Promise<void> {
    try {
      const result = this.#db.query("UPDATE package_entries SET state='deleting' WHERE url_hash=? AND state IN ('ready','deleting')").run(row.urlHash);
      if (row.state === "ready" && result.changes === 1) this.#emitMutation();
      await rm(this.#objectPath(row.objectPathId), { force: true });
      this.#db.query("DELETE FROM package_entries WHERE url_hash=? AND state='deleting'").run(row.urlHash);
    } catch { /* leave deleting rows for a later sweep */ }
  }

  async #enforceMaxBytes(): Promise<void> {
    const previous = this.#eviction;
    let next!: Promise<void>;
    next = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
      let total = BigInt(String(this.#db.query<{ total: string | number }, []>("SELECT COALESCE(SUM(CAST(size_bytes AS INTEGER)), 0) AS total FROM package_entries WHERE state='ready'").get()?.total ?? 0));
      if (total <= this.#maxBytes) return;
      const rows = this.#db.query<PackageEntry, []>(`SELECT url_hash AS urlHash,canonical_url AS canonicalUrl,object_path_id AS objectPathId,state,response_headers AS responseHeaders,size_bytes AS sizeBytes,created_at AS createdAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM package_entries WHERE state='ready' ORDER BY last_accessed_at ASC,created_at ASC`).all();
      for (const row of rows) {
        if (total <= this.#maxBytes) break;
        await this.#evict(row);
        total -= BigInt(row.sizeBytes);
      }
    }).finally(() => {
      if (this.#eviction === next) this.#eviction = null;
    });
  }

  async #hit(canonicalUrl: string, response: ServerResponse): Promise<boolean> {
    const row = this.#row(canonicalUrl);
    if (!row || row.state !== "ready") return false;
    if (Date.parse(row.expiresAt) <= this.#now().getTime()) { await this.#evict(row); return false; }
    const objectPath = this.#objectPath(row.objectPathId);
    let objectStat;
    try { objectStat = await stat(objectPath); } catch { await this.#evict(row); return false; }
    if (BigInt(objectStat.size) !== BigInt(row.sizeBytes)) { await this.#evict(row); return false; }
    try {
      this.#db.query("UPDATE package_entries SET last_accessed_at=?,expires_at=? WHERE url_hash=? AND state='ready'").run(this.#now().toISOString(), isoAfter(this.#now(), this.#ttlSeconds), row.urlHash);
    } catch { return false; }
    this.#hitCount += 1;
    let storedHeaders: HeaderMap;
    try { storedHeaders = JSON.parse(row.responseHeaders) as HeaderMap; } catch { await this.#evict(row); return false; }
    const headers: HeaderMap = { ...storedHeaders, "content-length": row.sizeBytes, "x-mars-package-cache": "HIT" };
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(objectPath);
      stream.on("error", reject);
      stream.on("end", resolve);
      response.writeHead(200, headers);
      stream.pipe(response);
    });
    return true;
  }

  async #publish(canonicalUrl: string, captured: CapturedResponse, generation: number): Promise<boolean> {
    if (generation !== this.#generation || captured.statusCode !== 200 || hasHeader(captured.headers, "set-cookie")) {
      await rm(captured.stagingPath, { force: true }).catch(() => undefined);
      return false;
    }
    const length = contentLength(captured.headers);
    if (length !== null && length !== BigInt(captured.sizeBytes)) {
      await rm(captured.stagingPath, { force: true }).catch(() => undefined);
      return false;
    }
    const urlHash = hash(canonicalUrl);
    const objectPathId = randomUUID();
    const now = this.#now().toISOString();
    const objectPath = this.#objectPath(objectPathId);
    try {
      this.#db.query(`INSERT INTO package_entries(url_hash,canonical_url,object_path_id,state,response_headers,size_bytes,created_at,last_accessed_at,expires_at) VALUES (?,?,?,'filling',?,?,?,?,?)`).run(urlHash, canonicalUrl, objectPathId, JSON.stringify(selectedHeaders(captured.headers)), String(captured.sizeBytes), now, now, isoAfter(this.#now(), this.#ttlSeconds));
      const file = await open(captured.stagingPath, "r+");
      try { await file.sync(); } finally { await file.close(); }
      await rename(captured.stagingPath, objectPath);
      await this.#syncDirectory(this.#objects);
      if (generation !== this.#generation) {
        await rm(objectPath, { force: true });
        this.#db.query("DELETE FROM package_entries WHERE url_hash=? AND state='filling'").run(urlHash);
        return false;
      }
      const result = this.#db.query("UPDATE package_entries SET state='ready' WHERE url_hash=? AND state='filling'").run(urlHash);
      if (result.changes !== 1) throw new Error("package cache publication lost its reservation");
      this.#emitMutation();
      await this.#enforceMaxBytes();
      const retained = this.#row(canonicalUrl);
      return retained?.state === "ready";
    } catch {
      await rm(captured.stagingPath, { force: true }).catch(() => undefined);
      await rm(objectPath, { force: true }).catch(() => undefined);
      try { this.#db.query("DELETE FROM package_entries WHERE url_hash=? AND state IN ('filling','ready')").run(urlHash); } catch { /* fail-open */ }
      return false;
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") return;
    const directory = await open(path, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async #fill(canonicalUrl: string, request: IncomingMessage, response: ServerResponse): Promise<FillResult> {
    const generation = this.#generation;
    const stagingPath = join(this.#staging, `${randomUUID()}.tmp`);
    const capture = new StreamingCaptureResponse(response, stagingPath);
    try {
      await this.#upstream(request, capture as unknown as ServerResponse);
      if (!capture.writableEnded) capture.end();
      await finished(capture);
    } catch (error) {
      capture.destroy();
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const published = await this.#publish(canonicalUrl, capture.captured(), generation);
    response.end();
    return { published, generation };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#assertOpen();
    if (!this.#enabled) { await this.#upstream(request, response); return; }
    const canonicalUrl = canonicalUrlFor(request);
    if (!canonicalUrl) { await this.#upstream(request, response); return; }
    try {
      if (await this.#hit(canonicalUrl, response)) return;
    } catch { await this.#upstream(request, response); return; }
    this.#missCount += 1;
    const existing = this.#flights.get(canonicalUrl);
    if (existing) {
      const result = await existing;
      if (result.published && await this.#hit(canonicalUrl, response)) return;
      if (result.generation !== this.#generation && this.#enabled) {
        const fill = this.#fill(canonicalUrl, request, response);
        this.#flights.set(canonicalUrl, fill);
        this.#activeFills.add(fill);
        try { await fill; } finally { this.#activeFills.delete(fill); this.#flights.delete(canonicalUrl); }
        return;
      }
      await this.#upstream(request, response);
      return;
    }
    const fill = this.#fill(canonicalUrl, request, response);
    this.#flights.set(canonicalUrl, fill);
    this.#activeFills.add(fill);
    try { await fill; } finally { this.#activeFills.delete(fill); this.#flights.delete(canonicalUrl); }
  }

  async applyTtl(ttlSeconds: number): Promise<void> {
    this.#assertOpen();
    requireTtl(ttlSeconds);
    this.#ttlSeconds = ttlSeconds;
    this.#db.query("UPDATE package_entries SET expires_at=datetime(last_accessed_at, ? || ' seconds') WHERE state='ready'").run(`+${ttlSeconds}`);
    await this.sweep();
  }
  setEnabled(enabled: boolean): void {
    this.#assertOpen();
    this.#enabled = enabled;
  }
  setMaxBytes(maxBytes: bigint): void {
    this.#assertOpen();
    requireMaxBytes(maxBytes);
    this.#maxBytes = maxBytes;
    void this.#enforceMaxBytes().catch(() => undefined);
  }

  async purge(): Promise<void> {
    this.#assertOpen();
    this.#generation += 1;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec("DELETE FROM package_entries");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    let files: string[] = [];
    try { files = await readdir(this.#objects); } catch { /* retry next sweep */ }
    await Promise.all(files.map((fileName) => rm(join(this.#objects, fileName), { force: true })));
    this.#emitMutation();
  }

  async sweep(): Promise<void> {
    this.#assertOpen();
    const now = this.#now();
    const expired = this.#db.query<PackageEntry, [string]>(`SELECT url_hash AS urlHash,canonical_url AS canonicalUrl,object_path_id AS objectPathId,state,response_headers AS responseHeaders,size_bytes AS sizeBytes,created_at AS createdAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM package_entries WHERE state='ready' AND expires_at<=?`).all(now.toISOString());
    for (const row of expired) await this.#evict(row);
    const deleting = this.#db.query<PackageEntry, []>(`SELECT url_hash AS urlHash,canonical_url AS canonicalUrl,object_path_id AS objectPathId,state,response_headers AS responseHeaders,size_bytes AS sizeBytes,created_at AS createdAt,last_accessed_at AS lastAccessedAt,expires_at AS expiresAt FROM package_entries WHERE state='deleting'`).all();
    for (const row of deleting) await this.#evict(row);
    const cutoff = new Date(now.getTime() - FILL_MAX_AGE_MS).toISOString();
    this.#db.query("DELETE FROM package_entries WHERE state='filling' AND created_at<?").run(cutoff);
    let files: string[] = [];
    try { files = await readdir(this.#staging); } catch { /* retry next sweep */ }
    for (const fileName of files) {
      const filePath = join(this.#staging, fileName);
      try { if ((await stat(filePath)).mtimeMs < now.getTime() - FILL_MAX_AGE_MS) await rm(filePath, { force: true }); } catch { /* retry next sweep */ }
    }
    await this.#enforceMaxBytes();
  }

  async probe(): Promise<void> {
    this.#assertOpen();
    const source = join(this.#probes, `${randomUUID()}.probe`);
    const target = join(this.#probes, `${randomUUID()}.probe`);
    const file = await open(source, "wx", 0o600);
    try { await file.write(new Uint8Array([1])); await file.sync(); } finally { await file.close(); }
    await rename(source, target);
    await this.#syncDirectory(this.#probes);
    await rm(target, { force: true });
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const id = randomUUID();
      this.#db.query("INSERT INTO package_entries(url_hash,canonical_url,object_path_id,state,response_headers,size_bytes,created_at,last_accessed_at,expires_at) VALUES (?,?,?,'filling','{}','0',?,?,?)").run(`probe-${id}`, "https://probe.invalid", randomUUID(), this.#now().toISOString(), this.#now().toISOString(), this.#now().toISOString());
      this.#db.query("DELETE FROM package_entries WHERE canonical_url='https://probe.invalid'").run();
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#activeFills]);
    if (this.#eviction) await Promise.allSettled([this.#eviction]);
    this.#db.close(true);
  }
}

export async function openPackageDownloadCache(options: {
  root: string;
  ttlSeconds: number;
  now?: Clock;
  upstream?: PackageUpstreamHandler;
}): Promise<PackageDownloadCache> {
  requireTtl(options.ttlSeconds);
  const root = join(options.root, "packages");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all(["objects", "staging", "probes"].map((directory) => mkdir(join(root, directory), { recursive: true, mode: 0o700 })));
  await secureWorkerPrivatePath(root, true);
  const db = new Database(join(root, "cache.sqlite"), { create: true, strict: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const version = Number(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) throw new Error(`unsupported package cache schema version ${version}`);
    if (version === 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE package_entries (
          url_hash TEXT PRIMARY KEY,
          canonical_url TEXT NOT NULL UNIQUE,
          object_path_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('filling','ready','deleting')),
          response_headers TEXT NOT NULL,
          size_bytes TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ); CREATE INDEX package_entries_expiry_idx ON package_entries(state,expires_at); PRAGMA user_version = ${SCHEMA_VERSION};`);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    const cache = new SqlitePackageDownloadCache(root, db, options.ttlSeconds, options.now ?? (() => new Date()), options.upstream ?? forwardPublicNpmRequest);
    await cache.sweep();
    return cache;
  } catch (error) { db.close(true); throw error; }
}
