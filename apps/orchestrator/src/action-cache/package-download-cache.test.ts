import { afterEach, expect, test } from "bun:test";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openPackageDownloadCache, forwardPublicNpmRequest, type PackageDownloadCache } from "./package-download-cache.ts";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mars-package-cache-"));
  roots.push(root);
  return root;
}

async function request(
  cache: PackageDownloadCache,
  path: string,
  headers: Record<string, string> = {},
  host = "registry.npmjs.org",
) {
  const server = createServer((incoming, outgoing) => void cache.handle(incoming, outgoing));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { host, ...headers } });
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

async function rawRequest(
  cache: PackageDownloadCache,
  path: string,
  headers: Record<string, string> = {},
  host = "cdn.playwright.dev",
) {
  const server = createServer((incoming, outgoing) => void cache.handle(incoming, outgoing));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return await new Promise<{ status: number; headers: Headers; bytes: Uint8Array }>((resolve, reject) => {
    const client = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      headers: { host, ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: new Headers(response.headers as Record<string, string>),
        bytes: new Uint8Array(Buffer.concat(chunks)),
      }));
      response.on("error", reject);
    });
    client.on("error", reject);
    client.end();
  });
}

test("publishes Playwright archives for each supported host as MISS then byte-identical HIT", async () => {
  const root = await temporaryRoot();
  const body = new Uint8Array([9, 8, 7, 6]);
  const requests: Array<{ host: string; path: string }> = [];
  const archives = [
    { host: "cdn.playwright.dev", path: "/builds/chromium/1187/chrome-linux.zip" },
    { host: "cdn.playwright.dev", path: "/builds/chromium-headless-shell/1187/chrome-headless-shell-linux.zip" },
    { host: "cdn.playwright.dev", path: "/builds/ffmpeg/1011/ffmpeg-linux.zip" },
    { host: "playwright.download.prss.microsoft.com", path: "/dbazure/download/playwright/builds/winldd/1011/winldd-win64.zip" },
  ];
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (request, response) => {
      requests.push({ host: String(request.headers.host), path: request.url ?? "" });
      response.writeHead(200, { "content-type": "application/zip", "content-length": String(body.byteLength), etag: '"archive"' });
      response.end(body);
    },
  });
  try {
    for (const archive of archives) {
      const first = await request(cache, archive.path, {}, archive.host);
      const second = await request(cache, archive.path, {}, archive.host);
      expect(first.bytes).toEqual(body);
      expect(second.bytes).toEqual(body);
      expect(first.response.headers.get("x-mars-package-cache")).toBe("MISS");
      expect(second.response.headers.get("x-mars-package-cache")).toBe("HIT");
    }
    expect(requests).toEqual(archives);
  } finally {
    await cache.close();
  }
});

test("bypasses non-archive, credentialed, and ranged Playwright requests", async () => {
  const root = await temporaryRoot();
  const body = new Uint8Array([1, 3, 3, 7]);
  const requests: Array<{ host: string; path: string }> = [];
  const bypasses: Array<{ host: string; path: string; headers: Record<string, string> }> = [
    { host: "cdn.playwright.dev", path: "/builds/chromium/1187/metadata.json", headers: {} },
    { host: "cdn.playwright.dev", path: "/builds/chromium/1187/chrome-linux.zip?download=1", headers: {} },
    { host: "cdn.playwright.dev", path: "/builds/chromium/1187/chrome-linux.zip", headers: { authorization: "Bearer token" } },
    { host: "cdn.playwright.dev", path: "/builds/chromium/1187/chrome-linux.zip", headers: { cookie: "session=secret" } },
    { host: "playwright.download.prss.microsoft.com", path: "/dbazure/download/playwright/builds/winldd/1011/winldd-win64.zip", headers: { range: "bytes=0-1" } },
  ];
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (request, response) => {
      requests.push({ host: String(request.headers.host), path: request.url ?? "" });
      response.writeHead(200, { "content-type": "application/zip", "content-length": String(body.byteLength) });
      response.end(body);
    },
  });
  try {
    for (const bypass of bypasses) {
      const first = await request(cache, bypass.path, bypass.headers, bypass.host);
      const second = await request(cache, bypass.path, bypass.headers, bypass.host);
      expect(first.bytes).toEqual(body);
      expect(second.bytes).toEqual(body);
      expect(first.response.headers.get("x-mars-package-cache")).toBeNull();
      expect(second.response.headers.get("x-mars-package-cache")).toBeNull();
    }
    expect(requests).toEqual(bypasses.flatMap(({ host, path }) => [{ host, path }, { host, path }]));
  } finally {
    await cache.close();
  }
});

test("bypasses empty query and fragment delimiters instead of canonicalizing them away", async () => {
  const root = await temporaryRoot();
  const body = new Uint8Array([5, 4, 3, 2]);
  const paths = ["/builds/chromium/1187/chrome-linux.zip?", "/builds/chromium/1187/chrome-linux.zip#fragment"];
  const requests: string[] = [];
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/zip", "content-length": String(body.byteLength) });
      response.end(body);
    },
  });
  try {
    for (const path of paths) {
      const first = await rawRequest(cache, path);
      const second = await rawRequest(cache, path);
      expect(first.bytes).toEqual(body);
      expect(second.bytes).toEqual(body);
      expect(first.headers.get("x-mars-package-cache")).toBeNull();
      expect(second.headers.get("x-mars-package-cache")).toBeNull();
    }
    expect(requests).toEqual(paths.flatMap((path) => [path, path]));
  } finally {
    await cache.close();
  }
});


test("does not forward unsupported hosts", async () => {
  let statusCode = 0;
  const response = {
    headersSent: false,
    writeHead(this: { headersSent: boolean }, status: number) {
      statusCode = status;
      this.headersSent = true;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  await forwardPublicNpmRequest(
    { method: "GET", url: "/package.tgz", headers: { host: "127.0.0.1" } } as unknown as IncomingMessage,
    response,
  );
  expect(statusCode).toBe(421);
});
test("publishes public tarballs as MISS then serves byte-identical HIT", async () => {
  const root = await temporaryRoot();
  let calls = 0;
  const body = new Uint8Array([0, 255, 1, 2, 3]);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (_request: IncomingMessage, response: ServerResponse) => {
      calls += 1;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.byteLength), etag: '"test"' });
      response.end(body);
    },
  });
  cache.setTelemetrySink((type, payload) => events.push({ type, payload }));
  try {
    const first = await request(cache, "/is-number/-/is-number-7.0.0.tgz");
    const second = await request(cache, "/is-number/-/is-number-7.0.0.tgz");
    expect(first.bytes).toEqual(body);
    expect(second.bytes).toEqual(body);
    expect(first.response.headers.get("x-mars-package-cache")).toBe("MISS");
    expect(second.response.headers.get("x-mars-package-cache")).toBe("HIT");
    expect(calls).toBe(1);
    expect(cache.status()).toEqual({ entryCount: 1, sizeBytes: String(body.byteLength) });
    expect(events).toEqual([{ type: "worker.runner_cache_status", payload: { entryCount: 1, sizeBytes: String(body.byteLength) } }]);
  } finally {
    await cache.close();
  }
});
 
test("telemetry sink failures do not discard a successfully published package", async () => {
  const root = await temporaryRoot();
  let calls = 0;
  const body = Buffer.from("package");
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (_request, response) => {
      calls += 1;
      response.writeHead(200, { "content-length": String(body.length) });
      response.end(body);
    },
  });
  cache.setTelemetrySink(() => { throw new Error("telemetry unavailable"); });
  try {
    const first = await request(cache, "/pkg/-/pkg-1.0.0.tgz");
    const second = await request(cache, "/pkg/-/pkg-1.0.0.tgz");
    expect(first.response.headers.get("x-mars-package-cache")).toBe("MISS");
    expect(second.response.headers.get("x-mars-package-cache")).toBe("HIT");
    expect(calls).toBe(1);
    expect(cache.status()).toEqual({ entryCount: 1, sizeBytes: String(body.length) });
  } finally {
    await cache.close();
  }
});

test("disabled requests pass through and re-enable reuses retained package object", async () => {
  const root = await temporaryRoot();
  let calls = 0;
  const body = new Uint8Array([4, 5, 6]);
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (_request, response) => {
      calls += 1;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.byteLength) });
      response.end(body);
    },
  });
  try {
    const first = await request(cache, "/pkg/-/pkg-1.0.0.tgz");
    cache.setEnabled(false);
    const disabled = await request(cache, "/pkg/-/pkg-1.0.0.tgz");
    cache.setEnabled(true);
    const reenabled = await request(cache, "/pkg/-/pkg-1.0.0.tgz");
    expect(first.response.headers.get("x-mars-package-cache")).toBe("MISS");
    expect(disabled.response.headers.get("x-mars-package-cache")).toBeNull();
    expect(reenabled.response.headers.get("x-mars-package-cache")).toBe("HIT");
    expect(disabled.bytes).toEqual(body);
    expect(reenabled.bytes).toEqual(body);
    expect(calls).toBe(2);
  } finally {
    await cache.close();
  }
});

test("purge removes package rows and objects, is idempotent, and preserves unrelated objects", async () => {
  const root = await temporaryRoot();
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (_request, response) => {
      response.writeHead(200, { "content-length": "3" });
      response.end("pkg");
    },
  });
  const unrelatedPath = join(root, "actions-object.blob");
  await Bun.write(unrelatedPath, "actions");
  try {
    await request(cache, "/pkg/-/pkg-1.0.0.tgz");
    expect(cache.status()).toEqual({ entryCount: 1, sizeBytes: "3" });
    expect(await readdir(join(root, "packages", "objects"))).toHaveLength(1);
    await cache.purge();
    await cache.purge();
    expect(await readdir(join(root, "packages", "objects"))).toHaveLength(0);
    expect(await Bun.file(unrelatedPath).text()).toBe("actions");
    const db = new Database(join(root, "packages", "cache.sqlite"), { readonly: true });
    try {
      expect(Number(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM package_entries").get()?.count ?? 0)).toBe(0);
      expect(cache.status()).toEqual({ entryCount: 0, sizeBytes: "0" });
    } finally {
      db.close();
    }
  } finally {
    await cache.close();
  }
});

test("a fill started before purge cannot publish after purge", async () => {
  const root = await temporaryRoot();
  let calls = 0;
  let started!: () => void;
  const fillStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const releaseFill = new Promise<void>((resolve) => { release = resolve; });
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (_request, response) => {
      calls += 1;
      started();
      await releaseFill;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "3" });
      response.end("old");
    },
  });
  try {
    const pending = request(cache, "/pkg/-/pkg-1.0.0.tgz");
    await fillStarted;
    await cache.purge();
    release();
    const first = await pending;
    const second = await request(cache, "/pkg/-/pkg-1.0.0.tgz");
    expect(first.response.headers.get("x-mars-package-cache")).toBeNull();
    expect(second.response.headers.get("x-mars-package-cache")).toBe("MISS");
    expect(calls).toBe(2);
  } finally {
    release();
    await cache.close();
  }
});
test("enforces the byte cap with least-recently-used ready eviction", async () => {
  const root = await temporaryRoot();
  const body = new Uint8Array([1, 2, 3]);
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.byteLength) });
      response.end(Buffer.from([Number(request.url?.includes("two") ? 2 : request.url?.includes("three") ? 3 : 1), ...body.slice(1)]));
    },
  });
  try {
    cache.setMaxBytes(6n);
    await request(cache, "/one/-/one-1.0.0.tgz");
    await request(cache, "/two/-/two-1.0.0.tgz");
    expect(await readdir(join(root, "packages", "objects"))).toHaveLength(2);
    expect((await request(cache, "/one/-/one-1.0.0.tgz")).response.headers.get("x-mars-package-cache")).toBe("HIT");
    await request(cache, "/three/-/three-1.0.0.tgz");
    expect((await request(cache, "/one/-/one-1.0.0.tgz")).response.headers.get("x-mars-package-cache")).toBe("HIT");
    expect((await request(cache, "/two/-/two-1.0.0.tgz")).response.headers.get("x-mars-package-cache")).toBe("MISS");
  } finally {
    await cache.close();
  }
});
test("sweep evicts expired package entries and resets the aggregate", async () => {
  const root = await temporaryRoot();
  let current = new Date("2025-01-01T00:00:00.000Z");
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    now: () => current,
    upstream: async (_request, response) => {
      response.writeHead(200, { "content-length": "3" });
      response.end("pkg");
    },
  });
  try {
    await request(cache, "/pkg/-/pkg-1.0.0.tgz");
    expect(cache.status()).toEqual({ entryCount: 1, sizeBytes: "3" });
    current = new Date("2025-01-01T00:01:01.000Z");
    await cache.sweep();
    expect(cache.status()).toEqual({ entryCount: 0, sizeBytes: "0" });
  } finally {
    await cache.close();
  }
});
