import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { isIP, connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  WorkerCacheProxy as WorkerCacheProxySchema,
  WorkerCacheStatus as WorkerCacheStatusSchema,
  type WorkerCacheEntryProjection,
  type WorkerCacheProxy,
  type WorkerCacheStatus,
} from "@mars/contracts";
import { retryControlPlaneOperation } from "../worker-client.ts";
import { loadOrCreateCertificateAuthority, type IssuedLeafCertificate, type WorkerCertificateAuthority } from "./certificates.ts";
import { openActionCacheStore, type ActionCacheMutation, type ActionCacheStore } from "./store.ts";
import { CREATE_CACHE_ENTRY_PATH, FINALIZE_CACHE_ENTRY_UPLOAD_PATH, GET_CACHE_ENTRY_DOWNLOAD_URL_PATH, createActionCacheRoutes, createGitHubCacheTokenVerifier, createNodeActionCacheHandler, type CacheTokenVerifier, type NodeActionCacheHandler } from "./routes.ts";

type Environment = Record<string, string | undefined>;
type Clock = () => Date;
type CertificateRenewalHandle = { cancel(): void };
type CertificateRenewalScheduler = (callback: () => Promise<void>, delayMs: number) => CertificateRenewalHandle;
type SweepHandle = { cancel(): void };
type SweepScheduler = (callback: () => Promise<void>, intervalMs: number) => SweepHandle;

export type ActionCacheNetworkConfiguration = {
  proxyPort: number;
  dataPort: number;
  overrideOrigins: { proxyOrigin: string; cacheBaseUrl: string } | null;
};

export type StartActionCacheServiceOptions = {
  controlPlaneOrigin: string;
  ttlSeconds: number;
  root?: string;
  proxyPort?: number;
  dataPort?: number;
  env?: Environment;
  platform?: NodeJS.Platform;
  now?: Clock;
  discoverAdvertiseHost?: (controlPlaneOrigin: string) => Promise<string>;
  scheduleCertificateRenewal?: CertificateRenewalScheduler;
  authorizeCacheRequest?: CacheTokenVerifier;
  forwardResultsRequest?: NodeActionCacheHandler;
  scheduleSweep?: SweepScheduler;
};

export interface ActionCacheService {
  status(): WorkerCacheStatus;
  applyTtl(ttlSeconds: number): Promise<void>;
  transport(leaseId: string, expiresAt: string): WorkerCacheProxy;
  unregisterLease(leaseId: string): void;
  snapshotPages(pageSize: number): AsyncIterable<WorkerCacheEntryProjection[]>;
  setTelemetrySink(sink: ((type: ActionCacheMutation["type"], payload: Record<string, unknown>) => void) | null): void;
  close(): Promise<void>;
}

export async function emitActionCacheSnapshot(service: Pick<ActionCacheService, "status" | "snapshotPages" | "setTelemetrySink">, send: (type: string, payload: Record<string, unknown>) => void): Promise<void> {
  const snapshotId = randomUUID();
  const queued: ActionCacheMutation[] = [];
  service.setTelemetrySink((type, payload) => queued.push({ type, payload } as ActionCacheMutation));
  const status = service.status();
  send("worker.cache_snapshot_begin", { snapshotId, status });
  let pageCount = 0;
  let entryCount = 0;
  for await (const entries of service.snapshotPages(100)) {
    send("worker.cache_snapshot_page", { snapshotId, sequence: pageCount, entries });
    pageCount += 1;
    entryCount += entries.length;
  }
  send("worker.cache_snapshot_end", { snapshotId, pageCount, entryCount, sizeBytes: status.sizeBytes });
  service.setTelemetrySink(send);
  for (const event of queued) send(event.type, event.payload);
}
const INTERCEPTED_CACHE_HOSTS = ["results-receiver.actions.githubusercontent.com", "artifactcache.actions.githubusercontent.com"];

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}


function configuredPort(value: string | undefined, fallback: number, name: string): number {
  const port = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be an integer between 1 and 65535`);
  return port;
}

function explicitPort(value: number | undefined, configured: number, name: string): number {
  if (value === undefined) return configured;
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) throw new Error(`${name} must be an integer between 0 and 65535`);
  return value;
}

function parseAdvertiseOrigin(value: string, protocol: "http:" | "https:", name: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute ${protocol.slice(0, -1).toUpperCase()} origin`); }
  if (url.protocol !== protocol || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port === "0") throw new Error(`${name} must be a credential-free ${protocol.slice(0, -1).toUpperCase()} origin with a usable port`);
  return url;
}

export function resolveActionCacheNetworkConfiguration(env: Environment = Bun.env): ActionCacheNetworkConfiguration {
  const proxyPort = configuredPort(env.MARS_CACHE_PROXY_PORT, 8788, "cache proxy port");
  const dataPort = configuredPort(env.MARS_CACHE_DATA_PORT, 8789, "cache data port");
  const proxyOverride = env.MARS_CACHE_PROXY_URL?.trim();
  const dataOverride = env.MARS_CACHE_ADVERTISE_URL?.trim();
  if (Boolean(proxyOverride) !== Boolean(dataOverride)) throw new Error("cache proxy and advertise URL overrides must be configured together");
  if (!proxyOverride || !dataOverride) return { proxyPort, dataPort, overrideOrigins: null };
  const proxyUrl = parseAdvertiseOrigin(proxyOverride, "http:", "cache proxy URL");
  const dataUrl = parseAdvertiseOrigin(dataOverride, "https:", "cache advertise URL");
  const proxyHostname = normalizedHostname(proxyUrl).toLowerCase();
  const dataHostname = normalizedHostname(dataUrl).toLowerCase();
  if (proxyHostname !== dataHostname) throw new Error("cache proxy and advertise URLs must use the same hostname");
  if (proxyHostname === "::1") proxyUrl.hostname = "127.0.0.1";
  if (dataHostname === "::1") dataUrl.hostname = "127.0.0.1";
  return { proxyPort, dataPort, overrideOrigins: { proxyOrigin: proxyUrl.origin, cacheBaseUrl: dataUrl.origin } };
}

function validateControlPlaneOrigin(value: string): URL {
  let origin: URL;
  try { origin = new URL(value); } catch { throw new Error("control-plane origin must be an absolute HTTP(S) origin"); }
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("control-plane origin must be a credential-free HTTP(S) origin");
  return origin;
}

export function discoverActionCacheAdvertiseHost(controlPlaneOrigin: string): Promise<string> {
  const origin = validateControlPlaneOrigin(controlPlaneOrigin);
  const hostname = normalizedHostname(origin);
  const port = origin.port ? Number(origin.port) : origin.protocol === "https:" ? 443 : 80;
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let socket: Socket;
  const connected = () => {
    const address = socket.localAddress;
    socket.destroy();
    if (!address) reject(new Error("control-plane route did not expose a local address"));
    else resolve(address);
  };
  if (origin.protocol === "https:") {
    socket = tlsConnect({ host: hostname, port, ...(isIP(hostname) ? {} : { servername: hostname }) }, connected);
  } else {
    socket = netConnect({ host: hostname, port }, connected);
  }
  socket.setTimeout(10_000, () => socket.destroy(new Error("control-plane route discovery timed out")));
  socket.once("error", reject);
  return promise;
}

function listen(server: HttpServer | HttpsServer, port: number): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const failed = (error: Error) => reject(error);
  server.once("error", failed);
  server.listen(port, "0.0.0.0", () => {
    server.off("error", failed);
    resolve((server.address() as AddressInfo).port);
  });
  return promise;
}

function closeServer(server: HttpServer | HttpsServer | null): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : resolve());
  server.closeAllConnections();
  return promise;
}

function originFor(protocol: "http:" | "https:", hostname: string, port: number): string {
  const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return `${protocol}//${host}:${port}`;
}

function probeDataEndpoint(cacheBaseUrl: string, ca: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = httpsRequest(new URL("/healthz", cacheBaseUrl), { ca, timeout: 10_000 }, (response) => {
    response.resume();
    response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error(`cache data readiness probe returned ${response.statusCode ?? "no status"}`)));
  });
  request.once("timeout", () => request.destroy(new Error("cache data readiness probe timed out")));
  request.once("error", reject);
  request.end();
  return promise;
}


function scheduleCertificateRenewal(callback: () => Promise<void>, delayMs: number): CertificateRenewalHandle {
  const timer = setTimeout(() => { void callback(); }, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

function scheduleSweep(callback: () => Promise<void>, intervalMs: number): SweepHandle {
  const timer = setInterval(() => { void callback(); }, intervalMs);
  timer.unref();
  return { cancel: () => clearInterval(timer) };
}

const CACHE_RPC_PATHS = new Set([CREATE_CACHE_ENTRY_PATH, FINALIZE_CACHE_ENTRY_UPLOAD_PATH, GET_CACHE_ENTRY_DOWNLOAD_URL_PATH]);
const CACHE_RPC_PREFIX = "/twirp/github.actions.results.api.v1.CacheService/";
const CACHE_DATA_PREFIX = "/_apis/artifactcache/cache/";

function forwardResultsRequest(request: Parameters<NodeActionCacheHandler>[0], response: Parameters<NodeActionCacheHandler>[1]): Promise<void> {
  const authority = request.headers.host ?? "";
  let target: URL;
  try { target = new URL(`https://${authority}`); } catch {
    response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("invalid Results authority\n");
    return Promise.resolve();
  }
  const hostname = normalizedHostname(target).toLowerCase();
  if (!INTERCEPTED_CACHE_HOSTS.includes(hostname)) {
    response.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Results forwarding target rejected\n");
    return Promise.resolve();
  }
  const headers = { ...request.headers };
  delete headers["proxy-authorization"];
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const upstream = httpsRequest({
    hostname,
    port: target.port ? Number(target.port) : 443,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
    upstreamResponse.once("end", resolve);
  });
  upstream.once("error", reject);
  request.pipe(upstream);
  return promise;
}

function shouldHandleCacheLocally(host: string | undefined, path: string): boolean {
  const hostname = (() => {
    try { return normalizedHostname(new URL(`https://${host ?? ""}`)).toLowerCase(); } catch { return ""; }
  })();
  if (!INTERCEPTED_CACHE_HOSTS.includes(hostname)) return true;
  return CACHE_RPC_PATHS.has(path) || path.startsWith(CACHE_RPC_PREFIX) || path.startsWith(CACHE_DATA_PREFIX);
}

type LeaseProxyCredential = { leaseId: string; username: string; token: string; expiresAt: number };

class LeaseProxyCredentials {
  readonly #byLease = new Map<string, LeaseProxyCredential>();
  readonly #byUsername = new Map<string, LeaseProxyCredential>();
  readonly #now: Clock;

  constructor(now: Clock) {
    this.#now = now;
  }

  register(leaseId: string, expiresAt: number): LeaseProxyCredential {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseId)) throw new Error("cache transport lease ID must be a UUID");
    this.unregister(leaseId);
    const credential = {
      leaseId,
      username: randomBytes(18).toString("base64url"),
      token: randomBytes(32).toString("base64url"),
      expiresAt,
    };
    this.#byLease.set(leaseId, credential);
    this.#byUsername.set(credential.username, credential);
    return credential;
  }

  unregister(leaseId: string): void {
    const credential = this.#byLease.get(leaseId);
    if (!credential) return;
    this.#byLease.delete(leaseId);
    this.#byUsername.delete(credential.username);
  }

  authorize(header: string | undefined): boolean {
    if (!header?.startsWith("Basic ")) return false;
    let decoded: string;
    try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
    const separator = decoded.indexOf(":");
    if (separator < 1) return false;
    const username = decoded.slice(0, separator);
    const token = decoded.slice(separator + 1);
    const credential = this.#byUsername.get(username);
    if (!credential || credential.expiresAt <= this.#now().getTime()) {
      if (credential) this.unregister(credential.leaseId);
      return false;
    }
    const actual = Buffer.from(token);
    const expected = Buffer.from(credential.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  clear(): void {
    this.#byLease.clear();
    this.#byUsername.clear();
  }
}
class CacheGrantSigner {
  readonly #cacheBaseUrl: string;
  readonly #now: Clock;
  readonly #secret = randomBytes(32);

  constructor(cacheBaseUrl: string, now: Clock) {
    this.#cacheBaseUrl = cacheBaseUrl;
    this.#now = now;
  }

  #signature(operation: "upload" | "download", entryId: string, expiresAt: string): string {
    return createHmac("sha256", this.#secret).update(`${operation}\n${entryId}\n${expiresAt}`).digest("base64url");
  }

  signedUrl(entryId: string, operation: "upload" | "download"): string {
    const expiresAt = String(this.#now().getTime() + 15 * 60_000);
    const url = new URL(`/_apis/artifactcache/cache/${entryId}`, this.#cacheBaseUrl);
    url.searchParams.set("op", operation);
    url.searchParams.set("exp", expiresAt);
    url.searchParams.set("sig", this.#signature(operation, entryId, expiresAt));
    return url.toString();
  }

  verify(request: Request, entryId: string, operation: "upload" | "download"): boolean {
    const url = new URL(request.url);
    const expiresAt = url.searchParams.get("exp");
    const signature = url.searchParams.get("sig");
    if (url.searchParams.get("op") !== operation || !expiresAt || !/^\d+$/.test(expiresAt) || Number(expiresAt) <= this.#now().getTime() || !signature) return false;
    const expected = Buffer.from(this.#signature(operation, entryId, expiresAt));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}


class PersistentActionCacheService implements ActionCacheService {
  readonly #store: ActionCacheStore;
  readonly #proxyServer: HttpServer;
  #dataServer: HttpsServer;
  readonly #caCertificatePem: string;
  readonly #now: Clock;
  readonly #certificateAuthority: WorkerCertificateAuthority;
  readonly #advertiseHost: string;
  readonly #scheduleRenewal: CertificateRenewalScheduler;
  readonly #createDataServer: (certificate: IssuedLeafCertificate) => HttpsServer;
  readonly #dataPort: number;
  readonly #proxyOrigin: string;
  readonly #cacheBaseUrl: string;
  readonly #leaseCredentials: LeaseProxyCredentials;
  #ttlSeconds: number;
  #ready = true;
  #error: string | null = null;
  #closed = false;
  #renewal: CertificateRenewalHandle | null = null;
  readonly #sweepHandle: SweepHandle;
  #lastStoredStatus: { sizeBytes: string; entryCount: number };

  constructor(input: {
    store: ActionCacheStore;
    proxyServer: HttpServer;
    dataServer: HttpsServer;
    caCertificatePem: string;
    now: Clock;
    ttlSeconds: number;
    proxyOrigin: string;
    cacheBaseUrl: string;
    certificateAuthority: WorkerCertificateAuthority;
    advertiseHost: string;
    certificateExpiresAt: Date;
    scheduleRenewal: CertificateRenewalScheduler;
    createDataServer: (certificate: IssuedLeafCertificate) => HttpsServer;
    dataPort: number;
    leaseCredentials: LeaseProxyCredentials;
    sweepHandle: SweepHandle;
  }) {
    this.#store = input.store;
    this.#proxyServer = input.proxyServer;
    this.#dataServer = input.dataServer;
    this.#caCertificatePem = input.caCertificatePem;
    this.#now = input.now;
    this.#ttlSeconds = input.ttlSeconds;
    this.#proxyOrigin = input.proxyOrigin;
    this.#cacheBaseUrl = input.cacheBaseUrl;
    this.#certificateAuthority = input.certificateAuthority;
    this.#advertiseHost = input.advertiseHost;
    this.#scheduleRenewal = input.scheduleRenewal;
    this.#createDataServer = input.createDataServer;
    this.#dataPort = input.dataPort;
    this.#leaseCredentials = input.leaseCredentials;
    this.#sweepHandle = input.sweepHandle;
    this.#lastStoredStatus = input.store.status();
    this.#proxyServer.on("error", (error: Error) => this.#listenerFailed(error));
    this.#dataServer.on("error", (error: Error) => this.#listenerFailed(error));
    this.#scheduleCertificateRenewal(input.certificateExpiresAt);
  }


  #listenerFailed(error: Error): void {
    this.#ready = false;
    this.#error = `action cache listener failed: ${error.message}`;
  }
  #scheduleCertificateRenewal(expiresAt: Date): void {
    const delayMs = Math.max(1_000, expiresAt.getTime() - this.#now().getTime() - 60 * 60_000);
    this.#renewal?.cancel();
    this.#renewal = this.#scheduleRenewal(async () => {
      if (this.#closed) return;
      try {
        const certificate: IssuedLeafCertificate = await this.#certificateAuthority.issueLeaf(this.#advertiseHost, this.#now(), INTERCEPTED_CACHE_HOSTS);
        if (this.#closed) return;
        this.#ready = false;
        const previous = this.#dataServer;
        await closeServer(previous);
        if (this.#closed) return;
        const replacement = this.#createDataServer(certificate);
        await listen(replacement, this.#dataPort);
        replacement.on("error", (listenerError: Error) => this.#listenerFailed(listenerError));
        this.#dataServer = replacement;
        if (this.#closed) { await closeServer(replacement); return; }
        await probeDataEndpoint(this.#cacheBaseUrl, this.#caCertificatePem);
        if (this.#closed) return;
        this.#ready = true;
        this.#error = null;
        this.#scheduleCertificateRenewal(certificate.expiresAt);
      } catch (error) {
        if (this.#closed) return;
        this.#ready = false;
        this.#error = `action cache certificate renewal failed: ${error instanceof Error ? error.message : String(error)}`;
        this.#scheduleCertificateRenewal(new Date(this.#now().getTime() + 61 * 60_000));
      }
    }, delayMs);
  }

  status(): WorkerCacheStatus {
    if (!this.#closed) this.#lastStoredStatus = this.#store.status();
    const stored = this.#lastStoredStatus;
    return WorkerCacheStatusSchema.parse({
      generation: this.#store.generation,
      ready: this.#ready && !this.#closed,
      ttlSeconds: this.#ttlSeconds,
      proxyOrigin: this.#proxyOrigin,
      cacheBaseUrl: this.#cacheBaseUrl,
      sizeBytes: stored.sizeBytes,
      entryCount: stored.entryCount,
      observedAt: this.#now().toISOString(),
      error: this.#error,
    });
  }

  async applyTtl(ttlSeconds: number): Promise<void> {
    if (this.#closed) throw new Error("action cache service is closed");
    await this.#store.applyTtl(ttlSeconds);
    this.#ttlSeconds = ttlSeconds;
  }

  transport(leaseId: string, expiresAt: string): WorkerCacheProxy {
    if (this.#closed || !this.#ready) throw new Error("action cache service is not ready");
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt || expiry <= this.#now().getTime()) throw new Error("cache transport expiry must be in the future");
    const credential = this.#leaseCredentials.register(leaseId, expiry);
    const proxyUrl = new URL(this.#proxyOrigin);
    proxyUrl.username = credential.username;
    proxyUrl.password = credential.token;
    return WorkerCacheProxySchema.parse({ proxyUrl: proxyUrl.toString(), cacheBaseUrl: this.#cacheBaseUrl, caCertificatePem: this.#caCertificatePem, expiresAt });
  }

  unregisterLease(leaseId: string): void {
    this.#leaseCredentials.unregister(leaseId);
  }

  snapshotPages(pageSize: number): AsyncIterable<WorkerCacheEntryProjection[]> {
    return this.#store.snapshotPages(pageSize);
  }
  setTelemetrySink(sink: ((type: ActionCacheMutation["type"], payload: Record<string, unknown>) => void) | null): void {
    this.#store.setTelemetrySink(sink);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#lastStoredStatus = this.#store.status();
    this.#closed = true;
    this.#ready = false;
    this.#error = "action cache service is closed";
    this.#renewal?.cancel();
    this.#renewal = null;
    this.#sweepHandle.cancel();
    this.#leaseCredentials.clear();
    const listeners = await Promise.allSettled([closeServer(this.#proxyServer), closeServer(this.#dataServer)]);
    const listenerFailure = listeners.find((result): result is PromiseRejectedResult => result.status === "rejected");
    await this.#store.close();
    if (listenerFailure) throw listenerFailure.reason;
  }
}

export async function startActionCacheService(options: StartActionCacheServiceOptions): Promise<ActionCacheService> {
  const env = options.env ?? Bun.env;
  const controlPlane = validateControlPlaneOrigin(options.controlPlaneOrigin).origin;
  const network = resolveActionCacheNetworkConfiguration(env);
  const proxyPort = explicitPort(options.proxyPort, network.proxyPort, "cache proxy port");
  const dataPort = explicitPort(options.dataPort, network.dataPort, "cache data port");
  const now = options.now ?? (() => new Date());
  const leaseCredentials = new LeaseProxyCredentials(now);
  const authorizeCacheRequest = options.authorizeCacheRequest ?? createGitHubCacheTokenVerifier({
    issuer: env.MARS_CACHE_TOKEN_ISSUER,
    jwksUrl: env.MARS_CACHE_JWKS_URL,
  });
  const forwardResults = options.forwardResultsRequest ?? forwardResultsRequest;
  let store: ActionCacheStore | null = null;
  let proxyServer: HttpServer | null = null;
  let dataServer: HttpsServer | null = null;
  let sweepHandle: SweepHandle | null = null;
  try {
    store = await openActionCacheStore({ root: options.root, ttlSeconds: options.ttlSeconds, env, platform: options.platform, now });
    await store.probe();
    sweepHandle = (options.scheduleSweep ?? scheduleSweep)(async () => {
      try { await store!.sweep(); }
      catch (error) { console.error("Action cache sweep failed", error instanceof Error ? error.message : String(error)); }
    }, 60_000);
    const certificateAuthority = await loadOrCreateCertificateAuthority(store);
    const resolvedAdvertiseHost = network.overrideOrigins
      ? normalizedHostname(new URL(network.overrideOrigins.cacheBaseUrl))
      : await retryControlPlaneOperation("action-cache route discovery", () => (options.discoverAdvertiseHost ?? discoverActionCacheAdvertiseHost)(controlPlane));
    const advertiseHost = resolvedAdvertiseHost === "::1" ? "127.0.0.1" : resolvedAdvertiseHost;
    await certificateAuthority.issueLeaf("results-receiver.actions.githubusercontent.com", now());
    const dataCertificate = await certificateAuthority.issueLeaf(advertiseHost, now(), INTERCEPTED_CACHE_HOSTS);
    let handleCacheRequest: NodeActionCacheHandler | null = null;
    const createDataServer = (certificate: IssuedLeafCertificate): HttpsServer => createHttpsServer({ key: certificate.privateKeyPem, cert: certificate.certificatePem }, (request, response) => {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("ready\n");
        return;
      }
      if (!handleCacheRequest) {
        response.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("cache routes not ready\n");
        return;
      }
      const path = (() => { try { return new URL(request.url ?? "/", "https://cache.invalid").pathname; } catch { return "/"; } })();
      const handler = shouldHandleCacheLocally(request.headers.host, path) ? handleCacheRequest : forwardResults;
      void handler(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end(`cache transport request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    });
    dataServer = createDataServer(dataCertificate);
    proxyServer = createHttpServer((_, response) => {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end("CONNECT required\n");
    });
    const proxy = proxyServer;
    let localDataPort = 0;
    proxy.on("connect", (request, socket, head) => {
      if (!leaseCredentials.authorize(request.headers["proxy-authorization"])) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Mars Worker Cache\"\r\nConnection: close\r\n\r\n");
        return;
      }
      let target: URL;
      try { target = new URL(`http://${request.url ?? ""}`); } catch { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
      const targetHost = normalizedHostname(target).toLowerCase();
      const targetPort = target.port ? Number(target.port) : 443;
      const intercept = INTERCEPTED_CACHE_HOSTS.includes(targetHost) || targetHost === advertiseHost.toLowerCase();
      const upstream = netConnect({ host: intercept ? "127.0.0.1" : targetHost, port: intercept ? localDataPort : targetPort });
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.once("error", () => {
        if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
      socket.once("error", () => upstream.destroy());
    });
    const [boundProxyPort, boundDataPort] = await Promise.all([listen(proxyServer, proxyPort), listen(dataServer, dataPort)]);
    localDataPort = boundDataPort;
    const proxyOrigin = network.overrideOrigins?.proxyOrigin ?? originFor("http:", advertiseHost, boundProxyPort);
    const cacheBaseUrl = network.overrideOrigins?.cacheBaseUrl ?? originFor("https:", advertiseHost, boundDataPort);
    const grants = new CacheGrantSigner(cacheBaseUrl, now);
    handleCacheRequest = createNodeActionCacheHandler(createActionCacheRoutes({
      cacheBaseUrl,
      store,
      authorize: authorizeCacheRequest,
      signedUrl: (entryId, operation) => grants.signedUrl(entryId, operation),
      verifyGrant: (request, entryId, operation) => grants.verify(request, entryId, operation),
    }));
    await probeDataEndpoint(cacheBaseUrl, certificateAuthority.certificatePem);
    return new PersistentActionCacheService({
      store,
      proxyServer,
      dataServer,
      caCertificatePem: certificateAuthority.certificatePem,
      certificateAuthority,
      advertiseHost,
      certificateExpiresAt: dataCertificate.expiresAt,
      scheduleRenewal: options.scheduleCertificateRenewal ?? scheduleCertificateRenewal,
      now,
      createDataServer,
      dataPort: boundDataPort,
      ttlSeconds: store.ttlSeconds,
      proxyOrigin,
      cacheBaseUrl,
      leaseCredentials,
      sweepHandle,
    });
  } catch (error) {
    sweepHandle?.cancel();
    await Promise.allSettled([closeServer(proxyServer), closeServer(dataServer), store?.close() ?? Promise.resolve()]);
    throw error;
  }
}
