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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "whitesmith-cache-service-")); roots.push(value); return value; }

function connectProxy(proxyUrl: string): Promise<string> {
  const url = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let response = "";
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("proxy timeout")); });
    socket.on("connect", () => socket.write("CONNECT results-receiver.actions.githubusercontent.com:443 HTTP/1.1\r\nHost: results-receiver.actions.githubusercontent.com:443\r\n\r\n"));
    socket.on("data", (chunk) => { response += chunk.toString("latin1"); if (response.includes("\r\n\r\n")) { socket.destroy(); resolve(response); } });
    socket.on("error", reject);
  });
}

function requestThroughProxy(proxyUrl: string, targetHost: string, ca: string, path: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const socket = connect(Number(proxy.port), proxy.hostname);
  let response = "";
  socket.once("error", reject);
  socket.once("connect", () => socket.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\n\r\n`));
  const connected = (chunk: Buffer) => {
    response += chunk.toString("latin1");
    if (!response.includes("\r\n\r\n")) return;
    socket.off("data", connected);
    if (!response.startsWith("HTTP/1.1 200")) {
      socket.destroy();
      reject(new Error(`proxy CONNECT failed: ${response.split("\r\n", 1)[0]}`));
      return;
    }
    const secure = tlsConnect({ socket, servername: targetHost, ca }, () => {
      secure.write(`GET ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`, () => secure.end());
    });
    let encryptedResponse = "";
    secure.on("data", (data) => {
      encryptedResponse += data.toString("latin1");
      const status = /^HTTP\/\d\.\d (\d{3})/.exec(encryptedResponse)?.[1];
      if (status) { socket.destroy(); resolve(Number(status)); }
    });
    secure.on("end", () => { if (!socket.destroyed) socket.destroy(); });
    secure.once("error", reject);
  };
  socket.on("data", connected);
  return promise;
}

function probeHttps(origin: string, ca: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(new URL("/healthz", origin), { ca }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
    request.end();
  });
}

function probeHttpsBody(origin: string, path: string, ca: string): Promise<{ status: number | undefined; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number | undefined; body: string }>();
  const request = httpsRequest(new URL(path, origin), { ca }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  request.on("error", reject);
  request.end();
  return promise;
}


test("requires paired, credential-free HTTP(S) advertise overrides on one hostname", () => {
  expect(resolveActionCacheNetworkConfiguration({})).toMatchObject({ proxyPort: 8788, dataPort: 8789, overrideOrigins: null });
  expect(resolveActionCacheNetworkConfiguration({ WHITESMITH_CACHE_PROXY_PORT: "9000", WHITESMITH_CACHE_DATA_PORT: "9001", WHITESMITH_CACHE_PROXY_URL: "http://cache.example.test:80", WHITESMITH_CACHE_ADVERTISE_URL: "https://cache.example.test:443" })).toMatchObject({ proxyPort: 9000, dataPort: 9001, overrideOrigins: { proxyOrigin: "http://cache.example.test", cacheBaseUrl: "https://cache.example.test" } });
  for (const env of [
    { WHITESMITH_CACHE_PROXY_URL: "http://cache.example.test" },
    { WHITESMITH_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { WHITESMITH_CACHE_PROXY_URL: "https://cache.example.test", WHITESMITH_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { WHITESMITH_CACHE_PROXY_URL: "http://cache.example.test/path", WHITESMITH_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { WHITESMITH_CACHE_PROXY_URL: "http://user@cache.example.test", WHITESMITH_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { WHITESMITH_CACHE_PROXY_URL: "http://cache.example.test", WHITESMITH_CACHE_ADVERTISE_URL: "https://other.example.test" },
    { WHITESMITH_CACHE_PROXY_PORT: "0" },
    { WHITESMITH_CACHE_DATA_PORT: "65536" },
    { WHITESMITH_CACHE_PROXY_URL: "http://cache.example.test:0", WHITESMITH_CACHE_ADVERTISE_URL: "https://cache.example.test" },
    { WHITESMITH_CACHE_PROXY_URL: "http://cache.example.test", WHITESMITH_CACHE_ADVERTISE_URL: "https://cache.example.test:0" },
  ]) expect(() => resolveActionCacheNetworkConfiguration(env)).toThrow();
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


test("starts both ready listeners and reports effective origins without credentials", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const status = service.status();
  expect(status).toMatchObject({ ready: true, ttlSeconds: 3600, error: null, entryCount: 0, sizeBytes: "0" });
  expect(status.proxyOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(status.cacheBaseUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
  const transport = service.transport("2026-08-24T00:00:00.000Z");
  expect(await probeHttps(status.cacheBaseUrl, transport.caCertificatePem)).toBe(200);
  expect(transport.proxyUrl).toBe(status.proxyOrigin);
  expect(transport.proxyUrl).not.toContain("@");
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

test("accepts auth-free Results CONNECT transport", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const transport = service.transport("2026-08-24T00:00:00.000Z");
  await expect(connectProxy(transport.proxyUrl)).resolves.toStartWith("HTTP/1.1 200");
});

test("mounts the cache protocol router on the persistent HTTPS listener", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const transport = service.transport("2026-08-24T00:00:00.000Z");
  const response = await probeHttpsBody(service.status().cacheBaseUrl, "/twirp/github.actions.results.api.v1.CacheService/Unknown", transport.caCertificatePem);
  expect(response.status).toBe(404);
  expect(JSON.parse(response.body)).toEqual({ code: "unimplemented", msg: "unsupported cache-service method", meta: {} });
});

test("rotates the advertised data certificate before expiry", async () => {
  const now = new Date("2026-08-23T00:00:00.000Z");
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
  let now = new Date("2026-08-23T00:00:00.000Z");
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
  now = new Date("2099-01-01T00:00:00.000Z");
  await renewal!();
  expect(service.status()).toMatchObject({ ready: false, error: expect.stringContaining("certificate renewal failed") });
});

test("exposes one credential-free cache transport without lease auth state", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  const first = service.transport("2026-08-24T00:00:00.000Z");
  const second = service.transport("2026-08-25T00:00:00.000Z");
  expect(new URL(first.proxyUrl).username).toBe("");
  expect(second.proxyUrl).toBe(first.proxyUrl);
  expect(await connectProxy(first.proxyUrl)).toStartWith("HTTP/1.1 200");
});

test("persists service generation and CA while applying TTL before resolving", async () => {
  const cacheRoot = await root();
  const first = await startActionCacheService({ root: cacheRoot, controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  const generation = first.status().generation;
  const firstCa = first.transport("2026-08-24T00:00:00.000Z").caCertificatePem;
  await first.applyTtl(7200);
  expect(first.status().ttlSeconds).toBe(7200);
  await first.close();

  const second = await startActionCacheService({ root: cacheRoot, controlPlaneOrigin: "https://control.example.test", ttlSeconds: 30, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(second);
  expect(second.status().generation).toBe(generation);
  expect(second.status().ttlSeconds).toBe(7200);
  expect(second.transport("2026-08-24T00:00:00.000Z").caCertificatePem).toBe(firstCa);
});

test("close revokes readiness and is idempotent", async () => {
  const service = await startActionCacheService({ root: await root(), controlPlaneOrigin: "https://control.example.test", ttlSeconds: 3600, proxyPort: 0, dataPort: 0, discoverAdvertiseHost: async () => "127.0.0.1" });
  services.push(service);
  await service.close();
  await service.close();
  expect(service.status()).toMatchObject({ ready: false, error: "action cache service is closed" });
});
