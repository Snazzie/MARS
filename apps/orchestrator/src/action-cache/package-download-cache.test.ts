import { afterEach, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openPackageDownloadCache, type PackageDownloadCache } from "./package-download-cache.ts";

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

async function request(cache: PackageDownloadCache, path: string, headers: Record<string, string> = {}) {
  const server = createServer((incoming, outgoing) => void cache.handle(incoming, outgoing));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { host: "registry.npmjs.org", ...headers } });
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

test("publishes public tarballs as MISS then serves byte-identical HIT", async () => {
  const root = await temporaryRoot();
  let calls = 0;
  const body = new Uint8Array([0, 255, 1, 2, 3]);
  const cache = await openPackageDownloadCache({
    root,
    ttlSeconds: 60,
    upstream: async (_request: IncomingMessage, response: ServerResponse) => {
      calls += 1;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.byteLength), etag: '"test"' });
      response.end(body);
    },
  });
  try {
    const first = await request(cache, "/is-number/-/is-number-7.0.0.tgz");
    const second = await request(cache, "/is-number/-/is-number-7.0.0.tgz");
    expect(first.bytes).toEqual(body);
    expect(second.bytes).toEqual(body);
    expect(first.response.headers.get("x-mars-package-cache")).toBe("MISS");
    expect(second.response.headers.get("x-mars-package-cache")).toBe("HIT");
    expect(calls).toBe(1);
  } finally {
    await cache.close();
  }
});
