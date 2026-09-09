import { X509Certificate, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { openPackageDownloadCache, PUBLIC_DOWNLOAD_HOSTS, type PackageDownloadCache, type PackageUpstreamHandler } from "./package-download-cache.ts";
import { CREATE_CACHE_ENTRY_PATH, FINALIZE_CACHE_ENTRY_UPLOAD_PATH, GET_CACHE_ENTRY_DOWNLOAD_URL_PATH, createActionCacheRoutes, createNodeActionCacheHandler, type CacheAuthorization, type CacheTokenVerifier, type NodeActionCacheHandler } from "./routes.ts";

export type WorkerRunnerCacheStatus = {
  generation: string;
  enabled: boolean;
  maxGiB: number;
  sizeBytes: string;
  entryCount: number;
  observedAt: string;
};

type ActionCacheTelemetrySink = (type: ActionCacheMutation["type"] | "worker.runner_cache_status", payload: Record<string, unknown>) => void;

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
  runnerCacheEnabled?: boolean;
  runnerCacheMaxGiB?: number;
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
  forwardPackageRequest?: PackageUpstreamHandler;
  scheduleSweep?: SweepScheduler;
};

export interface ActionCacheService {
  status(): WorkerCacheStatus;
  runnerCacheStatus(): WorkerRunnerCacheStatus;
  applyTtl(ttlSeconds: number): Promise<void>;
  setRunnerCacheEnabled(enabled: boolean): void;
  setRunnerCacheMaxGiB(maxGiB: number): void;
  purgeRunnerCache(): Promise<void>;
  transport(leaseId: string, expiresAt: string): WorkerCacheProxy;
  unregisterLease(leaseId: string): void;
  snapshotPages(pageSize: number): AsyncIterable<WorkerCacheEntryProjection[]>;
  setTelemetrySink(sink: ActionCacheTelemetrySink | null): void;
  close(): Promise<void>;
}

export async function emitActionCacheSnapshot(service: Pick<ActionCacheService, "status" | "runnerCacheStatus" | "snapshotPages" | "setTelemetrySink">, send: (type: string, payload: Record<string, unknown>) => void): Promise<void> {
  const snapshotId = randomUUID();
  const queued: Array<{ type: string; payload: Record<string, unknown> }> = [];
  service.setTelemetrySink((type, payload) => queued.push({ type, payload }));
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
  send("worker.runner_cache_status", service.runnerCacheStatus());
  service.setTelemetrySink(send);
  for (const event of queued) send(event.type, event.payload);
}
const ACTION_CACHE_HOSTS = [
  "results-receiver.actions.githubusercontent.com",
  "artifactcache.actions.githubusercontent.com",
] as const;
const INTERCEPTED_TLS_HOSTS = [...ACTION_CACHE_HOSTS, ...PUBLIC_DOWNLOAD_HOSTS];
function runnerCacheMaxBytes(maxGiB: number): bigint {
  if (!Number.isSafeInteger(maxGiB) || maxGiB <= 0) throw new Error("runner cache size cap must be a positive safe integer GiB");
  return BigInt(maxGiB) * 1024n ** 3n;
}

function normalizedHostnameFromHeader(host: string | undefined): string {
  try { return normalizedHostname(new URL(`https://${host ?? ""}`)).toLowerCase(); } catch { return ""; }
}

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

function probeDataEndpoint(cacheBaseUrl: string, certificatePem: string): Promise<void> {
  const certificate = new X509Certificate(certificatePem);
  const currentTime = Date.now();
  if (Date.parse(certificate.validFrom) > currentTime || Date.parse(certificate.validTo) <= currentTime) {
    throw new Error("cache data certificate is not currently valid");
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = httpsRequest(new URL("/healthz", cacheBaseUrl), { rejectUnauthorized: false, timeout: 10_000 }, (response) => {
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
  if (!ACTION_CACHE_HOSTS.includes(hostname as (typeof ACTION_CACHE_HOSTS)[number])) {
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
  const hostname = host?.toLowerCase() ?? "";
  if (!ACTION_CACHE_HOSTS.includes(hostname as (typeof ACTION_CACHE_HOSTS)[number])) return false;
  return CACHE_RPC_PATHS.has(path) || path.startsWith(CACHE_RPC_PREFIX) || path.startsWith(CACHE_DATA_PREFIX);
}

type LeaseProxyCredential = {
  leaseId: string;
  username: string;
  token: string;
  registrationChallengeHash: string;
  expiresAt: number;
  runtimeTokenHash?: string;
  authorization?: CacheAuthorization;
  runnerJobId?: string;
  repository?: string;
};

function cacheAuthorizationFromRuntimeToken(runtimeToken: string): CacheAuthorization | null {
  const pieces = runtimeToken.split(".");
  if (pieces.length !== 3 || !pieces[1] || runtimeToken.length > 16 * 1024) return null;
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object" || !("repository_id" in payload) || !("ac" in payload)) return null;
  const repositoryId = payload.repository_id;
  const githubRepositoryId = typeof repositoryId === "number" && Number.isSafeInteger(repositoryId) && repositoryId > 0
    ? String(repositoryId)
    : typeof repositoryId === "string" && /^[1-9]\d*$/.test(repositoryId)
      ? repositoryId
      : null;
  if (!githubRepositoryId) return null;
  let access: unknown = payload.ac;
  if (typeof access === "string") {
    try { access = JSON.parse(access); } catch { return null; }
  }
  if (!Array.isArray(access) || access.length === 0) return null;
  const scopes = new Map<string, number>();
  for (const value of access) {
    if (!value || typeof value !== "object") return null;
    const scope = "Scope" in value ? value.Scope : "scope" in value ? value.scope : undefined;
    const rawPermission = "Permission" in value ? value.Permission : "permission" in value ? value.permission : undefined;
    const permission = Number(rawPermission);
    if (typeof scope !== "string" || scope.length < 1 || scope.length > 1024 || /[\0\r\n]/u.test(scope) || !Number.isSafeInteger(permission) || permission < 1 || permission > 3) return null;
    scopes.set(scope, (scopes.get(scope) ?? 0) | permission);
  }
  return { githubRepositoryId, scopes };
}

async function readCacheRegistration(request: Parameters<NodeActionCacheHandler>[0]): Promise<{ challenge: string; runtimeToken: string; runnerJobId: string; repository: string }> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("registration content type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("registration request is too large");
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { throw new Error("registration request JSON is invalid"); }
  if (!value || typeof value !== "object") throw new Error("registration request is invalid");
  const challenge = "challenge" in value ? value.challenge : undefined;
  const runtimeToken = "runtimeToken" in value ? value.runtimeToken : undefined;
  const runnerJobId = "jobId" in value ? value.jobId : undefined;
  const repository = "repository" in value ? value.repository : undefined;
  if (typeof challenge !== "string" || typeof runtimeToken !== "string" || typeof runnerJobId !== "string" || typeof repository !== "string") throw new Error("registration request is invalid");
  return { challenge, runtimeToken, runnerJobId, repository };
}

class LeaseProxyCredentials {
  readonly #byLease = new Map<string, LeaseProxyCredential>();
  readonly #byUsername = new Map<string, LeaseProxyCredential>();
  readonly #now: Clock;

  constructor(now: Clock) {
    this.#now = now;
  }

  register(leaseId: string, expiresAt: number): LeaseProxyCredential & { registrationChallenge: string } {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseId)) throw new Error("cache transport lease ID must be a UUID");
    this.unregister(leaseId);
    const registrationChallenge = randomBytes(32).toString("base64url");
    const credential: LeaseProxyCredential = {
      leaseId,
      username: randomBytes(18).toString("base64url"),
      token: randomBytes(32).toString("base64url"),
      registrationChallengeHash: createHash("sha256").update(registrationChallenge).digest("hex"),
      expiresAt,
    };
    this.#byLease.set(leaseId, credential);
    this.#byUsername.set(credential.username, credential);
    return { ...credential, registrationChallenge };
  }

  unregister(leaseId: string): void {
    const credential = this.#byLease.get(leaseId);
    if (!credential) return;
    this.#byLease.delete(leaseId);
    this.#byUsername.delete(credential.username);
  }

  authorize(header: string | undefined): LeaseProxyCredential | null {
    if (!header?.startsWith("Basic ")) return null;
    let decoded: string;
    try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return null; }
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    const username = decoded.slice(0, separator);
    const token = decoded.slice(separator + 1);
    const credential = this.#byUsername.get(username);
    if (!credential || credential.expiresAt <= this.#now().getTime()) {
      if (credential) this.unregister(credential.leaseId);
      return null;
    }
    const actual = Buffer.from(token);
    const expected = Buffer.from(credential.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? credential : null;
  }

  registerRuntime(credential: LeaseProxyCredential, input: { challenge: string; runtimeToken: string; runnerJobId: string; repository: string }): boolean {
    if (this.#byLease.get(credential.leaseId) !== credential || !credential.registrationChallengeHash) return false;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.runnerJobId) || !/^[^/\s]+\/[^/\s]+$/.test(input.repository)) return false;
    const challengeHash = createHash("sha256").update(input.challenge).digest("hex");
    const actual = Buffer.from(challengeHash);
    const expected = Buffer.from(credential.registrationChallengeHash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const authorization = cacheAuthorizationFromRuntimeToken(input.runtimeToken);
    if (!authorization) return false;
    credential.registrationChallengeHash = "";
    credential.runtimeTokenHash = createHash("sha256").update(input.runtimeToken).digest("hex");
    credential.authorization = authorization;
    credential.runnerJobId = input.runnerJobId;
    credential.repository = input.repository;
    return true;
  }

  authorizeRuntime(credential: LeaseProxyCredential | undefined, request: Request): CacheAuthorization | null {
    if (!credential || this.#byLease.get(credential.leaseId) !== credential || credential.expiresAt <= this.#now().getTime() || !credential.runtimeTokenHash || !credential.authorization) return null;
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(request.headers.get("authorization") ?? "");
    if (!match) return null;
    const actual = Buffer.from(createHash("sha256").update(match[1]!).digest("hex"));
    const expected = Buffer.from(credential.runtimeTokenHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? credential.authorization : null;
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
  readonly #packageDownloadCache: PackageDownloadCache;
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
  #runnerCacheEnabled: boolean;
  #runnerCacheMaxGiB: number;
  #ready = true;
  #error: string | null = null;
  #closed = false;
  #renewal: CertificateRenewalHandle | null = null;
  readonly #sweepHandle: SweepHandle;
  #telemetrySink: ActionCacheTelemetrySink | null = null;
  #lastStoredStatus: { sizeBytes: string; entryCount: number };

  constructor(input: {
    store: ActionCacheStore;
    packageDownloadCache: PackageDownloadCache;
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
    runnerCacheEnabled: boolean;
    runnerCacheMaxGiB: number;
  }) {
    this.#store = input.store;
    this.#packageDownloadCache = input.packageDownloadCache;
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
    this.#runnerCacheEnabled = input.runnerCacheEnabled;
    this.#runnerCacheMaxGiB = input.runnerCacheMaxGiB;
    this.#packageDownloadCache.setTelemetrySink((type, payload) => this.#emitRunnerCacheStatus(type, payload));
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
        const certificate: IssuedLeafCertificate = await this.#certificateAuthority.issueLeaf(this.#advertiseHost, this.#now(), INTERCEPTED_TLS_HOSTS);
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
        await probeDataEndpoint(this.#cacheBaseUrl, certificate.certificatePem);
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
  runnerCacheStatus(): WorkerRunnerCacheStatus {
    const stored = this.#packageDownloadCache.status();
    return {
      generation: this.#store.generation,
      enabled: this.#runnerCacheEnabled,
      maxGiB: this.#runnerCacheMaxGiB,
      sizeBytes: stored.sizeBytes,
      entryCount: stored.entryCount,
      observedAt: this.#now().toISOString(),
    };
  }
  #emitRunnerCacheStatus(type: "worker.runner_cache_status" = "worker.runner_cache_status", _payload?: Record<string, unknown>): void {
    this.#telemetrySink?.(type, this.runnerCacheStatus());
  }

  async applyTtl(ttlSeconds: number): Promise<void> {
    if (this.#closed) throw new Error("action cache service is closed");
    await Promise.all([this.#store.applyTtl(ttlSeconds), this.#packageDownloadCache.applyTtl(ttlSeconds)]);
    this.#ttlSeconds = ttlSeconds;
    this.#emitRunnerCacheStatus();
  }

  setRunnerCacheEnabled(enabled: boolean): void {
    if (this.#closed) throw new Error("action cache service is closed");
    this.#store.saveRunnerCachePolicy({ enabled, maxGiB: this.#runnerCacheMaxGiB });
    this.#packageDownloadCache.setEnabled(enabled);
    this.#runnerCacheEnabled = enabled;
    this.#emitRunnerCacheStatus();
  }

  setRunnerCacheMaxGiB(maxGiB: number): void {
    if (this.#closed) throw new Error("action cache service is closed");
    runnerCacheMaxBytes(maxGiB);
    this.#store.saveRunnerCachePolicy({ enabled: this.#runnerCacheEnabled, maxGiB });
    this.#packageDownloadCache.setMaxBytes(runnerCacheMaxBytes(maxGiB));
    this.#runnerCacheMaxGiB = maxGiB;
    this.#emitRunnerCacheStatus();
  }

  async purgeRunnerCache(): Promise<void> {
    if (this.#closed) throw new Error("action cache service is closed");
    await this.#packageDownloadCache.purge();
  }
  transport(leaseId: string, expiresAt: string): WorkerCacheProxy {
    if (this.#closed || !this.#ready) throw new Error("action cache service is not ready");
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt || expiry <= this.#now().getTime()) throw new Error("cache transport expiry must be in the future");
    const credential = this.#leaseCredentials.register(leaseId, expiry);
    const proxyUrl = new URL(this.#proxyOrigin);
    proxyUrl.username = credential.username;
    proxyUrl.password = credential.token;
    const registrationUrl = new URL("/_mars/register", this.#cacheBaseUrl).toString();
    return WorkerCacheProxySchema.parse({ proxyUrl: proxyUrl.toString(), cacheBaseUrl: this.#cacheBaseUrl, caCertificatePem: this.#caCertificatePem, expiresAt, registrationUrl, registrationChallenge: credential.registrationChallenge });
  }

  unregisterLease(leaseId: string): void {
    this.#leaseCredentials.unregister(leaseId);
  }

  snapshotPages(pageSize: number): AsyncIterable<WorkerCacheEntryProjection[]> {
    return this.#store.snapshotPages(pageSize);
  }
  setTelemetrySink(sink: ActionCacheTelemetrySink | null): void {
    this.#telemetrySink = sink;
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
    const stores = await Promise.allSettled([this.#store.close(), this.#packageDownloadCache.close()]);
    if (listenerFailure) throw listenerFailure.reason;
    const storeFailure = stores.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (storeFailure) throw storeFailure.reason;
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
  const forwardResults = options.forwardResultsRequest ?? forwardResultsRequest;
  let store: ActionCacheStore | null = null;
  let packageDownloadCache: PackageDownloadCache | null = null;
  let proxyServer: HttpServer | null = null;
  let dataServer: HttpsServer | null = null;
  let sweepHandle: SweepHandle | null = null;
  const principalByRequest = new WeakMap<Request, LeaseProxyCredential>();
  const principalByTunnelPort = new Map<number, LeaseProxyCredential>();
  try {
    store = await openActionCacheStore({ root: options.root, ttlSeconds: options.ttlSeconds, env, platform: options.platform, now });
    await store.probe();
    const runnerCachePolicy = store.runnerCachePolicy() ?? {
      enabled: options.runnerCacheEnabled ?? true,
      maxGiB: options.runnerCacheMaxGiB ?? 20,
    };
    store.saveRunnerCachePolicy(runnerCachePolicy);
    packageDownloadCache = await openPackageDownloadCache({
      root: store.root,
      ttlSeconds: store.ttlSeconds,
      now,
      upstream: options.forwardPackageRequest,
    });
    packageDownloadCache.setEnabled(runnerCachePolicy.enabled);
    packageDownloadCache.setMaxBytes(runnerCacheMaxBytes(runnerCachePolicy.maxGiB));
    await packageDownloadCache.probe();
    sweepHandle = (options.scheduleSweep ?? scheduleSweep)(async () => {
      try {
        await Promise.all([store!.sweep(), packageDownloadCache!.sweep()]);
      } catch (error) {
        console.error("Action cache sweep failed", error instanceof Error ? error.message : String(error));
      }
    }, 60_000);
    const certificateAuthority = await loadOrCreateCertificateAuthority(store);
    const resolvedAdvertiseHost = network.overrideOrigins
      ? normalizedHostname(new URL(network.overrideOrigins.cacheBaseUrl))
      : await retryControlPlaneOperation("action-cache route discovery", () => (options.discoverAdvertiseHost ?? discoverActionCacheAdvertiseHost)(controlPlane));
    const advertiseHost = resolvedAdvertiseHost === "::1" ? "127.0.0.1" : resolvedAdvertiseHost;
    await certificateAuthority.issueLeaf("results-receiver.actions.githubusercontent.com", now());
    const dataCertificate = await certificateAuthority.issueLeaf(advertiseHost, now(), INTERCEPTED_TLS_HOSTS);
    let handleCacheRequest: NodeActionCacheHandler | null = null;
    let cacheBaseUrl = "";
    const authorizeCacheRequest = options.authorizeCacheRequest ?? (async (request: Request) => leaseCredentials.authorizeRuntime(principalByRequest.get(request), request));
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
      if (path === "/_mars/register") {
        const credential = request.socket.remotePort === undefined ? undefined : principalByTunnelPort.get(request.socket.remotePort);
        if (request.method !== "POST") {
          response.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "method_not_allowed" }));
          return;
        }
        if (!credential || normalizedHostnameFromHeader(request.headers.host) !== advertiseHost.toLowerCase()) {
          response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "registration_not_authorized" }));
          return;
        }
        void readCacheRegistration(request).then((input) => {
          if (!leaseCredentials.registerRuntime(credential, input)) {
            response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({ error: "registration_not_authorized" }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ cacheBaseUrl, protocolVersion: "v2" }));
        }).catch((error) => {
          response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : "registration request is invalid" }));
        });
        return;
      }
      const hostname = normalizedHostnameFromHeader(request.headers.host);
      const handler = PUBLIC_DOWNLOAD_HOSTS.includes(hostname as (typeof PUBLIC_DOWNLOAD_HOSTS)[number])
        ? packageDownloadCache!.handle.bind(packageDownloadCache)
        : hostname === advertiseHost.toLowerCase() || shouldHandleCacheLocally(hostname, path)
          ? handleCacheRequest
          : ACTION_CACHE_HOSTS.includes(hostname as (typeof ACTION_CACHE_HOSTS)[number])
            ? forwardResults
            : null;
      if (!handler) {
        response.writeHead(421, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("Misdirected Request\n");
        return;
      }
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
      const credential = leaseCredentials.authorize(request.headers["proxy-authorization"]);
      if (!credential) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Mars Worker Cache\"\r\nConnection: close\r\n\r\n");
        return;
      }
      let target: URL;
      try { target = new URL(`http://${request.url ?? ""}`); } catch { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
      const targetHost = normalizedHostname(target).toLowerCase();
      const targetPort = target.port ? Number(target.port) : 443;
      const intercept = INTERCEPTED_TLS_HOSTS.includes(targetHost as (typeof INTERCEPTED_TLS_HOSTS)[number]) || targetHost === advertiseHost.toLowerCase();
      const upstream = netConnect({ host: intercept ? "127.0.0.1" : targetHost, port: intercept ? localDataPort : targetPort });
      upstream.once("connect", () => {
        const tunnelPort = upstream.localPort;
        if (intercept && tunnelPort !== undefined) {
          principalByTunnelPort.set(tunnelPort, credential);
          upstream.once("close", () => principalByTunnelPort.delete(tunnelPort));
        }
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
    cacheBaseUrl = network.overrideOrigins?.cacheBaseUrl ?? originFor("https:", advertiseHost, boundDataPort);
    const grants = new CacheGrantSigner(cacheBaseUrl, now);
    handleCacheRequest = createNodeActionCacheHandler(createActionCacheRoutes({
      cacheBaseUrl,
      store,
      authorize: authorizeCacheRequest,
      signedUrl: (entryId, operation) => grants.signedUrl(entryId, operation),
      verifyGrant: (request, entryId, operation) => principalByRequest.has(request) && grants.verify(request, entryId, operation),
    }), (incoming, request) => {
      const credential = incoming.socket.remotePort === undefined ? undefined : principalByTunnelPort.get(incoming.socket.remotePort);
      if (credential) principalByRequest.set(request, credential);
    });
    await probeDataEndpoint(cacheBaseUrl, dataCertificate.certificatePem);
    return new PersistentActionCacheService({
      store,
      packageDownloadCache,
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
      runnerCacheEnabled: runnerCachePolicy.enabled,
      runnerCacheMaxGiB: runnerCachePolicy.maxGiB,
    });
  } catch (error) {
    sweepHandle?.cancel();
    await Promise.allSettled([closeServer(proxyServer), closeServer(dataServer), store?.close() ?? Promise.resolve(), packageDownloadCache?.close() ?? Promise.resolve()]);
    throw error;
  }
}
