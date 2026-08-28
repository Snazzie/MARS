import { createControlPlaneApp } from "../apps/control-plane/src/http/app.ts";
import { fakeHttpDeps } from "../apps/control-plane/src/http/test-deps.ts";
import { createHmac } from "node:crypto";

const providerOrigin = "https://example-name.ts.net";
const organizationId = "00000000-0000-4000-8000-000000000001";
const deliveryId = "smoke-delivery-1";
const webhookSecret = "smoke-webhook-secret";

type SqlStub = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown[]>) & {
  begin: (callback: (tx: SqlStub) => Promise<unknown>) => Promise<unknown>;
  json: (value: unknown) => string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke assertion failed: ${message}`);
}

async function main(): Promise<void> {
  let webhookPayload: unknown;
  const db = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("insert into webhook_deliveries")) {
      webhookPayload = values[2];
      return [{ delivery_id: values[0] }];
    }
    if (query.includes("select admission_state from workers")) return [{ admission_state: "pending" }];
    return [];
  }) as SqlStub;
  db.begin = async callback => callback(db);
  db.json = value => JSON.stringify(value);

  const setupCalls: string[] = [];
  const app = createControlPlaneApp(fakeHttpDeps({
    db: db as never,
    setup: {
      publicOrigin: () => providerOrigin,
      publicOriginManaged: () => true,
      configure: async origin => {
        setupCalls.push(origin);
        assert(origin === providerOrigin, "first-run setup uses provider-style HTTPS origin");
        return origin;
      },
      authenticate: async () => ({ userId: "admin", firstAdmin: true }),
    },
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    githubApp: {
      createManifestLaunch: async () => ({
        action: "https://github.com/settings/apps/new?state=smoke",
        manifest: JSON.stringify({ url: providerOrigin, callback_urls: [`${providerOrigin}/api/auth/github/callback`] }),
      }),
      getWebhookSecret: async () => webhookSecret,
    } as never,
  }));

  let upstream!: ReturnType<typeof Bun.serve>;
  upstream = Bun.serve<{ actor: "browser" | "worker"; path: string }>({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && (url.pathname === "/api/browser/invalidations" || url.pathname === "/api/v1/workers/connect")) {
        const actor = url.pathname === "/api/browser/invalidations" ? "browser" : "worker";
        if (server.upgrade(request, { data: { actor, path: `${url.pathname}${url.search}` } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return app.fetch(request);
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "upstream-open", actor: ws.data.actor }));
        if (ws.data.actor === "worker") ws.send(JSON.stringify({ version: 1, type: "challenge", nonce: "smoke" }));
      },
      message() {},
    },
  });

  type ProxyData = { upstream?: WebSocket; queued: string[]; path: string };
  const proxy = Bun.serve<ProxyData>({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const path = `${url.pathname}${url.search}`;
        if (url.pathname !== "/api/browser/invalidations" && url.pathname !== "/api/v1/workers/connect") return new Response("not found", { status: 404 });
        if (server.upgrade(request, { data: { queued: [], path } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const upstreamResponse = await fetch(`http://127.0.0.1:${upstream.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body,
      });
      return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: upstreamResponse.headers });
    },
    websocket: {
      open(ws) {
        const upstreamSocket = new WebSocket(`ws://127.0.0.1:${upstream.port}${ws.data.path}`);
        ws.data.upstream = upstreamSocket;
        upstreamSocket.addEventListener("open", () => {
          for (const message of ws.data.queued) upstreamSocket.send(message);
          ws.data.queued = [];
        });
        upstreamSocket.addEventListener("message", event => ws.send(typeof event.data === "string" ? event.data : String(event.data)));
        upstreamSocket.addEventListener("close", () => ws.close());
        upstreamSocket.addEventListener("error", () => ws.close(1011, "upstream websocket failed"));
      },
      message(ws, message) {
        const text = typeof message === "string" ? message : String(message);
        if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(text);
        else ws.data.queued.push(text);
      },
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });

  const baseUrl = `http://127.0.0.1:${proxy.port}`;
  try {
    const manifestResponse = await fetch(`${baseUrl}/api/setup/github-app`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-manifest", host: "example-name.ts.net" },
      body: JSON.stringify({ publicBaseUrl: providerOrigin }),
    });
    const manifest = await manifestResponse.json() as { manifest?: string };
    assert(manifestResponse.status === 200, `first-run manifest status is ${manifestResponse.status}`);
    assert(setupCalls.length === 1 && setupCalls[0] === providerOrigin, "manifest setup origin reached control plane");
    assert(manifest.manifest?.includes(`${providerOrigin}/api/auth/github/callback`), "manifest callback uses provider origin");

    const webhookBody = '{"zen":"keep-byte-for-byte","installation":{"id":7}}';
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(webhookBody).digest("hex")}`;
    const webhookResponse = await fetch(`${baseUrl}/api/github/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-delivery": deliveryId, "x-github-event": "ping", host: "example-name.ts.net" },
      body: webhookBody,
    });
    assert(webhookResponse.status === 202, `signed webhook status is ${webhookResponse.status}`);
    assert(webhookPayload === JSON.stringify(JSON.parse(webhookBody)), "webhook payload and signature survived proxy forwarding");

    const browserSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/api/browser/invalidations?organizationId=${organizationId}`);
    const browserMessages: string[] = [];
    browserSocket.addEventListener("message", event => browserMessages.push(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("browser websocket upgrade timeout")), 5_000);
      browserSocket.addEventListener("message", event => {
        if (String(event.data).includes('"actor":"browser"')) {
          clearTimeout(timeout);
          browserSocket.close();
          resolve();
        }
      });
      browserSocket.addEventListener("error", () => reject(new Error("browser websocket upgrade failed")));
    });
    assert(browserMessages.some(message => message.includes('"actor":"browser"')), "browser invalidations websocket upgraded through proxy");

    const workerSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/api/v1/workers/connect?workerId=${organizationId}`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worker websocket upgrade timeout")), 5_000);
      workerSocket.addEventListener("message", event => {
        if (String(event.data).includes('"type":"challenge"')) {
          clearTimeout(timeout);
          workerSocket.close();
          resolve();
        }
      });
      workerSocket.addEventListener("error", () => reject(new Error("worker websocket upgrade failed")));
    });

    console.log("PASS first-run manifest at provider HTTPS origin");
    console.log("PASS signed webhook body/signature preservation");
    console.log("PASS /api/browser/invalidations WebSocket upgrade");
    console.log("PASS /api/v1/workers/connect WebSocket upgrade");
  } finally {
    proxy.stop(true);
    upstream.stop(true);
  }
}

await main();
