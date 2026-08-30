import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect, createServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverActionCacheAdvertiseHost, emitActionCacheSnapshot, resolveActionCacheNetworkConfiguration, startActionCacheService, type ActionCacheService } from "./service.ts";

const roots: string[] = [];
const services: ActionCacheService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "mars-cache-service-")); roots.push(value); return value; }
const leaseExpiry = (milliseconds = 60 * 60 * 1000): string => new Date(Date.now() + milliseconds).toISOString();

function connectProxy(proxyUrl: string): Promise<string> {
  const url = new URL(proxyUrl);
  const credentials = url.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}\r\n`
    : "";
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket = connect(Number(url.port), url.hostname);
  let response = "";
  socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("proxy timeout")); });
  socket.on("connect", () => socket.write(`CONNECT results-receiver.actions.githubusercontent.com:443 HTTP/1.1\r\nHost: results-receiver.actions.githubusercontent.com:443\r\n${credentials}\r\n`));
  socket.on("data", (chunk) => { response += chunk.toString("latin1"); if (response.includes("\r\n\r\n")) { socket.destroy(); resolve(response); } });
  socket.on("error", reject);
  return promise;
}

function requestThroughProxy(proxyUrl: string, targetHost: string, ca: string, input: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const proxy = new URL(proxyUrl);
  const credentials = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
    : "";
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: Record<string, string>; body: string }>();
  const socket = connect(Number(proxy.port), proxy.hostname);
  let connectResponse = "";
  socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error("proxy request timeout")); });
  socket.once("error", reject);
  socket.once("connect", () => socket.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n${credentials}\r\n`));
  const connected = (chunk: Buffer) => {
    connectResponse += chunk.toString("latin1");
    if (!connectResponse.includes("\r\n\r\n")) return;
    socket.off("data", connected);
    if (!connectResponse.startsWith("HTTP/1.1 200")) {
      socket.destroy();
      reject(new Error(`proxy CONNECT failed: ${connectResponse.split("\r\n", 1)[0]}`));
      return;
    }
    const secure = tlsConnect({ socket, servername: targetHost, ca });
    secure.once("secureConnect", () => {
      const request = httpsRequest({
        host: targetHost,
        servername: targetHost,
        path: input.path,
        method: input.method,
        headers: { host: targetHost, ...input.headers },
        agent: false,
        createConnection: () => secure,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value ?? ""])),
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.once("error", reject);
      if (input.body !== undefined) request.write(input.body);
      request.end();
    });
    secure.once("error", reject);
  };
  socket.on("data", connected);
  return promise;
}

function probeHttps(origin: string, ca: string): Promise<number | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<number | undefined>();
  const request = httpsRequest(new URL("/healthz", origin), { ca }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
  request.on("error", reject);
  request.end();
  return promise;
}

function probeHttpsBody(origin: string, path: string, ca: string, headers: Record<string, string> = {}): Promise<{ status: number | undefined; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number | undefined; body: string }>();
  const request = httpsRequest(new URL(path, origin), { ca, headers }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  request.on("error", reject);
  request.end();
  return promise;
}
function requestHttps(origin: string, ca: string, input: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number | undefined; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number | undefined; body: string }>();
  const request = httpsRequest(new URL(input.path, origin), { ca, method: input.method, headers: input.headers }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  request.on("error", reject);
  if (input.body !== undefined) request.write(input.body);
  request.end();
  return promise;
}


test("requires paired, credential-free HTTP(S) advertise overrides on one hostname", () => {
  expect(resolveActionCacheNetworkConfiguration({})).toMatchObject({ proxyPort: 8788, dataPort: 8789, overrideOrigins: null });
  expect(resolveActionCacheNetworkConfiguration({ MARS_CACHE_PROXY_PORT: "9000", MARS_CACHE_DATA_PORT: "9001", MARS_CACHE_PROXY_URL: "http://cache.example.test:80", MARS_CACHE_ADVERTISE_URL: "https://cache.example.test:443" })).toMatchObject({ proxyPort: 9000, dataPort: 9001, overrideOrigins: { proxyOrigin: "http://cache.example.test", cacheBaseUrl: "https://cache.example.test" } });
  for (const env of [
    { MARS_CACHE_PROXY_URL: "http://cache.example.test" },
    { MARS_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { MARS_CACHE_PROXY_URL: "https://cache.example.test", MARS_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { MARS_CACHE_PROXY_URL: "http://cache.example.test/path", MARS_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { MARS_CACHE_PROXY_URL: "http://user@cache.example.test", MARS_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { MARS_CACHE_PROXY_URL: "http://cache.example.test", MARS_CACHE_ADVERTISE_URL: "https://other.example.test" },
    { MARS_CACHE_PROXY_PORT: "0" },
    { MARS_CACHE_DATA_PORT: "65536" },
    { MARS_CACHE_PROXY_URL: "http://cache.example.test:0", MARS_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { MARS_CACHE_PROXY_URL: "http://cache.example.test", MARS_CACHE_ADVERTISE_URL: "https://cache.example.test:0" },
  ]) expect(() => resolveActionCacheNetworkConfiguration(env)).toThrow();
});
test("normalizes IPv6 loopback advertise overrides for IPv4 listeners", () => {
  expect(resolveActionCacheNetworkConfiguration({
    MARS_CACHE_PROXY_URL: "http://[::1]:19000",
    MARS_CACHE_ADVERTISE_URL: "https://[::1]:19001",
  })).toMatchObject({
    overrideOrigins: {
      proxyOrigin: "http://127.0.0.1:19000",
      cacheBaseUrl: "https://127.0.0.1:19001",
    },
  });
});

test("discovers the worker advertise address from the control-plane route", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as { port: number };
    await expect(discoverActionCacheAdvertiseHost(`http://127.0.0.1:${address.port}`)).resolves.toBe("127.0.0.1");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
test("keeps startup alive while route discovery is temporarily unavailable", async () => {
  let attempts = 0;
  const firstAttempt = Promise.withResolvers<void>();
  const startup = startActionCacheService({
    root: await root(),
    controlPlaneOrigin: "https://control.example.test",
    ttlSeconds: 3600,
    proxyPort: 0,
    dataPort: 0,
    discoverAdvertiseHost: async () => {
      attempts += 1;
      if (attempts === 1) {
        firstAttempt.resolve();
        throw new Error("connection refused");
      }
      return "127.0.0.1";
    },
  });
  let settled = false;
  startup.then(() => { settled = true; }, () => { settled = true; });
  await firstAttempt.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  const service = await startup;
  services.push(service);
  expect(service.status().ready).toBe(true);
  expect(attempts).toBe(2);
});
test("normalizes IPv6 loopback discovery to the IPv4 listener", async () => {
  const service = await startActionCacheService({
    root: await root(),
    controlPlaneOrigin: "https://control.example.test",
    ttlSeconds: 3600,
    proxyPort: 0,
    dataPort: 0,
    discoverAdvertiseHost: async () => "::1",
  });
  services.push(service);
  const status = service.status();
  expect(status.ready).toBe(true);
  expect(status.proxyOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(status.cacheBaseUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
  expect(await probeHttps(status.cacheBaseUrl, service.transport("11111111-1111-4111-8111-111111111111", leaseExpiry()).caCertificatePem)).toBe(200);
});



test("starts ready listeners and keeps credentials out of reported origins", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const status = service.status();
  expect(status).toMatchObject({ ready: true, ttlSeconds: 3600, error: null, entryCount: 0, sizeBytes: "0" });
  expect(status.proxyOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const transport = service.transport("11111111-1111-4111-8111-111111111111", leaseExpiry());
  expect(await probeHttps(status.cacheBaseUrl, transport.caCertificatePem)).toBe(200);
  expect(new URL(transport.proxyUrl).origin).toBe(status.proxyOrigin);
  expect(transport.proxyUrl).toContain("@");
  expect(await connectProxy(transport.proxyUrl)).toStartWith("HTTP/1.1 200");
  expect(await Array.fromAsync(service.snapshotPages(100))).toEqual([]);
});

test("emits a complete cache snapshot envelope for an empty cache", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
  await emitActionCacheSnapshot(service, (type, payload) => frames.push({ type, payload }));
  expect(frames.map((frame) => frame.type)).toEqual(["worker.cache_snapshot_begin", "worker.cache_snapshot_end"]);
  expect(frames[1]?.payload).toMatchObject({ pageCount: 0, entryCount: 0, sizeBytes: "0" });
});

test("requires active per-lease credentials for proxy CONNECT", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const transport = service.transport("11111111-1111-4111-8111-111111111111", leaseExpiry());
  await expect(connectProxy(service.status().proxyOrigin)).resolves.toStartWith("HTTP/1.1 407");
  await expect(connectProxy(transport.proxyUrl)).resolves.toStartWith("HTTP/1.1 200");
});

test("mounts the cache protocol router on the persistent HTTPS listener", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const transport = service.transport("11111111-1111-4111-8111-111111111111", leaseExpiry());
  const response = await probeHttpsBody(service.status().cacheBaseUrl, "/twirp/github.actions.results.api.v1.CacheService/Unknown", transport.caCertificatePem);
  expect(response.status).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ code: "unimplemented", msg: "unsupported cache-service method", meta: {} });
});
test("forwards non-cache Results methods instead of handling them locally", async () => {
  const service = await startActionCacheService({
    root: await root(),
    controlPlaneOrigin: "https://control.example.test",
    ttlSeconds: 3600,
    proxyPort: 0,
    dataPort: 0,
    discoverAdvertiseHost: async () => "127.0.0.1",
    forwardResultsRequest: async (_request, response) => {
      response.writeHead(204);
      response.end();
    },
  });
  services.push(service);
  const transport = service.transport("11111111-1111-4111-8111-111111111111", leaseExpiry());
  const response = await probeHttpsBody(service.status().cacheBaseUrl, "/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact", transport.caCertificatePem, { host: "results-receiver.actions.githubusercontent.com" });
  expect(response.status).toBe(204);
});
test("intercepts metadata-free cache requests through authenticated CONNECT", async () => {
  let authorizationCalls = 0;
  const service = await startActionCacheService({
    root: await root(),
    controlPlaneOrigin: "https://control.example.test",
    ttlSeconds: 3600,
    proxyPort: 0,
    dataPort: 0,
    discoverAdvertiseHost: async () => "127.0.0.1",
    authorizeCacheRequest: async () => {
      authorizationCalls += 1;
      return { githubRepositoryId: "1", scopes: new Map([["refs/heads/main", 2]]) };
    },
  });
  services.push(service);
  const transport = service.transport("11111111-1111-4111-8111-111111111111", leaseExpiry());
  const response = await requestThroughProxy(transport.proxyUrl, "results-receiver.actions.githubusercontent.com", transport.caCertificatePem, {
    method: "POST",
    path: "/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "proxy-key", version: "proxy-version" }),
  });
  expect(authorizationCalls).toBe(1);
  expect(response.status).toBe(200);
  const body: unknown = JSON.parse(response.body);
  expect(body).toMatchObject({ ok: true });
  if (!body || typeof body !== "object" || !("signed_upload_url" in body) || typeof body.signed_upload_url !== "string") throw new Error("cache create response missing upload URL");
  expect(new URL(body.signed_upload_url).origin).toBe(service.status().cacheBaseUrl);
});
test("reports live entry count and bytes after a cache fill", async () => {
  let now = new Date();
  let scheduledSweep: (() => Promise<void>) | undefined;
  const service = await startActionCacheService({
    root: await root(),
    controlPlaneOrigin: "https://control.example.test",
    ttlSeconds: 3600,
    proxyPort: 0,
    dataPort: 0,
    discoverAdvertiseHost: async () => "127.0.0.1",
    authorizeCacheRequest: async () => ({ githubRepositoryId: "1", scopes: new Map([["refs/heads/main", 3]]) }),
    now: () => now,
    scheduleSweep: (callback) => {
      scheduledSweep = callback;
      return { cancel() {} };
    },
  });
  services.push(service);
  const transport = service.transport("11111111-1111-4111-8111-111111111111", new Date(now.getTime() + 60 * 60 * 1000).toISOString());
  const create = await requestHttps(service.status().cacheBaseUrl, transport.caCertificatePem, {
    method: "POST",
    path: "/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "summary-key", version: "v1" }),
  });
  const createBody: unknown = JSON.parse(create.body);
  if (!createBody || typeof createBody !== "object" || !("signed_upload_url" in createBody) || typeof createBody.signed_upload_url !== "string") throw new Error("cache create response missing upload URL");
  const uploadUrl = new URL(createBody.signed_upload_url);
  const blockBytes = Buffer.alloc(48);
  Buffer.from("0").copy(blockBytes, 36);
  uploadUrl.searchParams.set("comp", "block");
  uploadUrl.searchParams.set("blockid", blockBytes.toString("base64"));
  await requestHttps(uploadUrl.origin, transport.caCertificatePem, { method: "PUT", path: `${uploadUrl.pathname}${uploadUrl.search}`, body: "abc" });
  uploadUrl.searchParams.set("comp", "blocklist");
  uploadUrl.searchParams.delete("blockid");
  await requestHttps(uploadUrl.origin, transport.caCertificatePem, { method: "PUT", path: `${uploadUrl.pathname}${uploadUrl.search}`, body: `<BlockList><Latest>${blockBytes.toString("base64")}</Latest></BlockList>` });
  expect(service.status()).toMatchObject({ entryCount: 1, sizeBytes: "3" });
  now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  await scheduledSweep!();
  expect(service.status()).toMatchObject({ entryCount: 0, sizeBytes: "0" });
  await service.close();
  services.splice(services.indexOf(service), 1);
});

test("rotates the advertised data certificate before expiry", async () => {
  const now = new Date();
  let renewal: (() => Promise<void>) | undefined;
  let delay = 0;
  let schedules = 0;
  const service = await startActionCacheService({
    root: await root(),
    controlPlaneOrigin: "https://control.example.test",
    ttlSeconds: 3600,
    proxyPort: 0,
    dataPort: 0,
    discoverAdvertiseHost: async () => "127.0.0.1",
    now: () => now,
    scheduleCertificateRenewal: (callback, delayMs) => {
      schedules += 1;
      renewal = callback;
      delay = delayMs;
      return { cancel() {} };
    },
  });
  services.push(service);
  expect(schedules).toBe(1);
  expect(delay).toBeLessThan(24 * 60 * 60 * 1000);
  await renewal!();
  expect(service.status()).toMatchObject({ ready: true, error: null });
  expect(schedules).toBe(2);
});

test("fails readiness when advertised certificate renewal cannot be probed", async () => {
  let now = new Date();
  let renewal: (() => Promise<void>) | undefined;
  const service = await startActionCacheService({
    root: await root(),
    controlPlaneOrigin: "https://control.example.test",
    ttlSeconds: 3600,
    proxyPort: 0,
    dataPort: 0,
    discoverAdvertiseHost: async () => "127.0.0.1",
    now: () => now,
    scheduleCertificateRenewal: (callback) => { renewal = callback; return { cancel() {} }; },
  });
  services.push(service);
  now = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  await renewal!();
  expect(service.status()).toMatchObject({ ready: false, error: expect.stringContaining("certificate renewal failed") });
});

test("isolates and revokes per-lease proxy credentials", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const first = service.transport("11111111-1111-4111-8111-111111111111", leaseExpiry());
  const second = service.transport("22222222-2222-4222-8222-222222222222", leaseExpiry(2 * 60 * 60 * 1000));
  expect(new URL(first.proxyUrl).username).not.toBe(new URL(second.proxyUrl).username);
  service.unregisterLease("11111111-1111-4111-8111-111111111111");
  expect(await connectProxy(first.proxyUrl)).toStartWith("HTTP/1.1 407");
  expect(await connectProxy(second.proxyUrl)).toStartWith("HTTP/1.1 200");
});

test("persists service generation and CA while applying TTL before resolving", async () => {
  const cacheRoot = await root();
  const first = await startActionCacheService({ root: cacheRoot, controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  const generation = first.status().generation;
  const firstCa = first.transport("11111111-1111-4111-8111-111111111111", leaseExpiry()).caCertificatePem;
  await first.applyTtl(7200);
  expect(first.status().ttlSeconds).toBe(7200);
  await first.close();

  const second = await startActionCacheService({ root: cacheRoot, controlPlaneOrigin: "https://control.example.test", ttlSeconds: 30, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(second);
  expect(second.status().generation).toBe(generation);
  expect(second.status().ttlSeconds).toBe(7200);
  expect(second.transport("11111111-1111-4111-8111-111111111111", leaseExpiry()).caCertificatePem).toBe(firstCa);
});

test("close revokes readiness and is idempotent", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  await service.close();
  await service.close();
  expect(service.status()).toMatchObject({ ready: false, error: "action cache service is closed" });
});
