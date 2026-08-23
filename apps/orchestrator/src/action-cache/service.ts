import { randomUUID } from "node:crypto";
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
} from "@whitesmith/contracts";
import { loadOrCreateCertificateAuthority, type IssuedLeafCertificate, type WorkerCertificateAuthority } from "./certificates.ts";
import { openActionCacheStore, type ActionCacheMutation, type ActionCacheStore } from "./store.ts";
import { createActionCacheRoutes, createNodeActionCacheHandler, type NodeActionCacheHandler } from "./routes.ts";

type Environment = Record<string, string | undefined>;
type Clock = () => Date;
type CertificateRenewalHandle = { cancel(): void };
type CertificateRenewalScheduler = (callback: () => Promise<void>, delayMs: number) => CertificateRenewalHandle;

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
};

export interface ActionCacheService {
  status(): WorkerCacheStatus;
  applyTtl(ttlSeconds: number): Promise<void>;
  transport(expiresAt: string): WorkerCacheProxy;
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
  const proxyPort = configuredPort(env.WHITESMITH_CACHE_PROXY_PORT, 8788, "cache proxy port");
  const dataPort = configuredPort(env.WHITESMITH_CACHE_DATA_PORT, 8789, "cache data port");
  const proxyOverride = env.WHITESMITH_CACHE_PROXY_URL?.trim();
  const dataOverride = env.WHITESMITH_CACHE_ADVERTISE_URL?.trim();
  if (Boolean(proxyOverride) !== Boolean(dataOverride)) throw new Error("cache proxy and advertise URL overrides must be configured together");
  if (!proxyOverride || !dataOverride) return { proxyPort, dataPort, overrideOrigins: null };
  const proxyUrl = parseAdvertiseOrigin(proxyOverride, "http:", "cache proxy URL");
  const dataUrl = parseAdvertiseOrigin(dataOverride, "https:", "cache advertise URL");
  if (normalizedHostname(proxyUrl).toLowerCase() !== normalizedHostname(dataUrl).toLowerCase()) throw new Error("cache proxy and advertise URLs must use the same hostname");
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
  #ttlSeconds: number;
  #entryCount: number;
  #sizeBytes: string;
  #ready = true;
  #error: string | null = null;
  #closed = false;
  #renewal: CertificateRenewalHandle | null = null;

  constructor(input: {
    store: ActionCacheStore;
    proxyServer: HttpServer;
    dataServer: HttpsServer;
    caCertificatePem: string;
    now: Clock;
    ttlSeconds: number;
    proxyOrigin: string;
    cacheBaseUrl: string;
    entryCount: number;
    sizeBytes: string;
    certificateAuthority: WorkerCertificateAuthority;
    advertiseHost: string;
    certificateExpiresAt: Date;
    scheduleRenewal: CertificateRenewalScheduler;
    createDataServer: (certificate: IssuedLeafCertificate) => HttpsServer;
    dataPort: number;
  }) {
    this.#store = input.store;
    this.#proxyServer = input.proxyServer;
    this.#dataServer = input.dataServer;
    this.#caCertificatePem = input.caCertificatePem;
    this.#now = input.now;
    this.#ttlSeconds = input.ttlSeconds;
    this.#proxyOrigin = input.proxyOrigin;
    this.#cacheBaseUrl = input.cacheBaseUrl;
    this.#entryCount = input.entryCount;
    this.#sizeBytes = input.sizeBytes;
    this.#certificateAuthority = input.certificateAuthority;
    this.#advertiseHost = input.advertiseHost;
    this.#scheduleRenewal = input.scheduleRenewal;
    this.#createDataServer = input.createDataServer;
    this.#dataPort = input.dataPort;
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
    return WorkerCacheStatusSchema.parse({
      generation: this.#store.generation,
      ready: this.#ready && !this.#closed,
      ttlSeconds: this.#ttlSeconds,
      proxyOrigin: this.#proxyOrigin,
      cacheBaseUrl: this.#cacheBaseUrl,
      sizeBytes: this.#sizeBytes,
      entryCount: this.#entryCount,
      observedAt: this.#now().toISOString(),
      error: this.#error,
    });
  }

  async applyTtl(ttlSeconds: number): Promise<void> {
    if (this.#closed) throw new Error("action cache service is closed");
    await this.#store.applyTtl(ttlSeconds);
    const status = await this.#store.status();
    this.#ttlSeconds = ttlSeconds;
    this.#entryCount = status.entryCount;
    this.#sizeBytes = status.sizeBytes;
  }

  transport(expiresAt: string): WorkerCacheProxy {
    if (this.#closed || !this.#ready) throw new Error("action cache service is not ready");
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt || expiry <= this.#now().getTime()) throw new Error("cache transport expiry must be in the future");
    return WorkerCacheProxySchema.parse({ proxyUrl: this.#proxyOrigin, cacheBaseUrl: this.#cacheBaseUrl, caCertificatePem: this.#caCertificatePem, expiresAt });
  }

  snapshotPages(pageSize: number): AsyncIterable<WorkerCacheEntryProjection[]> {
    return this.#store.snapshotPages(pageSize);
  }
  setTelemetrySink(sink: ((type: ActionCacheMutation["type"], payload: Record<string, unknown>) => void) | null): void {
    this.#store.setTelemetrySink(sink);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    this.#error = "action cache service is closed";
    this.#renewal?.cancel();
    this.#renewal = null;
    const results = await Promise.allSettled([closeServer(this.#proxyServer), closeServer(this.#dataServer), this.#store.close()]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}

export async function startActionCacheService(options: StartActionCacheServiceOptions): Promise<ActionCacheService> {
  const env = options.env ?? Bun.env;
  const controlPlane = validateControlPlaneOrigin(options.controlPlaneOrigin).origin;
  const network = resolveActionCacheNetworkConfiguration(env);
  const proxyPort = explicitPort(options.proxyPort, network.proxyPort, "cache proxy port");
  const dataPort = explicitPort(options.dataPort, network.dataPort, "cache data port");
  const now = options.now ?? (() => new Date());
  let store: ActionCacheStore | null = null;
  let proxyServer: HttpServer | null = null;
  let dataServer: HttpsServer | null = null;
  try {
    store = await openActionCacheStore({ root: options.root, ttlSeconds: options.ttlSeconds, env, platform: options.platform, now });
    await store.probe();
    const certificateAuthority = await loadOrCreateCertificateAuthority(store);
    const advertiseHost = network.overrideOrigins ? normalizedHostname(new URL(network.overrideOrigins.cacheBaseUrl)) : await (options.discoverAdvertiseHost ?? discoverActionCacheAdvertiseHost)(controlPlane);
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
      void handleCacheRequest(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end(`cache request failed: ${error instanceof Error ? error.message : String(error)}\n`);
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
    handleCacheRequest = createNodeActionCacheHandler(createActionCacheRoutes({ cacheBaseUrl, store }));
    await probeDataEndpoint(cacheBaseUrl, certificateAuthority.certificatePem);
    const storedStatus = await store.status();
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
      ...storedStatus,
    });
  } catch (error) {
    await Promise.allSettled([closeServer(proxyServer), closeServer(dataServer), store?.close() ?? Promise.resolve()]);
    throw error;
  }
}
