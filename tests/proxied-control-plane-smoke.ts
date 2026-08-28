import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { GitHubAppService } from "../apps/control-plane/src/github-app.ts";
import { SecretBox } from "../apps/control-plane/src/auth.ts";
import { startControlPlane } from "../apps/control-plane/src/index.ts";
import type { ControlPlaneStartOptions } from "../apps/control-plane/src/index.ts";

type MemorySetupState = { purpose: "oauth" | "manifest" | "install" | "organization_install"; userId: string | null; organizationId: string | null; idempotencyKey: string | null; encryptedState?: string; encryptedPkceVerifier?: string; expiresAt: number; consumedAt?: number };
type MemoryInstallation = { organizationId: string; githubInstallationId: number; state: "pending" | "approved" | "suspended"; repositorySelection: "all" | "selected" | null; githubAccountId?: number };
type MemoryRepository = { id: string; installationId: number; organizationId?: string; fullName: string; visibility: "private" | "internal" | "public"; available: boolean };
type MemoryAppConfig = { id: number; slug: string; clientId?: string; pem: string; clientSecret: string; webhookSecret: string };
type MemoryDb = { setupStates: Map<string, MemorySetupState>; installations: Map<number, MemoryInstallation>; repositories: Map<string, MemoryRepository>; appConfig?: MemoryAppConfig };

const providerOrigin = "https://example-name.ts.net";
const organizationId = "00000000-0000-4000-8000-000000000001";
const workerId = "11111111-1111-4111-8111-111111111111";
const deliveryId = "smoke-delivery-1";
const webhookSecret = "smoke-webhook-secret";

type SqlStub = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown[]>) & { begin: (callback: (tx: SqlStub) => Promise<unknown>) => Promise<unknown>; json: (value: unknown) => string };
type Delivery = { installationId: number; payload: string; eventName: string; state: "received" | "processing" | "completed" | "failed" };

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`smoke assertion failed: ${message}`); }
function waitForSocketMessage(socket: WebSocket, predicate: (message: string) => boolean, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timeout`)), 5_000);
    socket.addEventListener("message", event => { const message = String(event.data); if (!predicate(message)) return; clearTimeout(timeout); resolve(message); });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error(`${label} failed`)); });
  });
}

async function main(): Promise<void> {
  const memoryDb: MemoryDb = { setupStates: new Map(), installations: new Map(), repositories: new Map() };
  const deliveries = new Map<string, Delivery>();
  let persistedPayload = "";
  let persistedDelivery = "";
  let persistedEvent = "";
  let forwardedWebhookBody = "";
  let workerEnrollmentActivated = false;
  const workerKeys = generateKeyPairSync("ed25519");
  const workerPublicKey = workerKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const sqlDb = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("insert into webhook_deliveries")) {
      const id = String(values[0]); persistedDelivery = id; persistedPayload = String(values[2]); persistedEvent = String(values[3]);
      deliveries.set(id, { installationId: Number(values[1]), payload: persistedPayload, eventName: persistedEvent, state: "received" });
      return [{ delivery_id: id }];
    }
    if (query.includes("update webhook_deliveries set state='processing'")) { const id = String(values[0]); const delivery = deliveries.get(id); if (delivery) delivery.state = "processing"; return delivery ? [{ delivery_id: id }] : []; }
    if (query.includes("update webhook_deliveries set state='completed'")) { const delivery = deliveries.get(String(values[0])); if (delivery) delivery.state = "completed"; return []; }
    if (query.includes("update webhook_deliveries set state='failed'")) { const delivery = deliveries.get(String(values[0])); if (delivery) delivery.state = "failed"; return []; }
    if (query.includes("update workers set encryption_public_key") || query.includes("update workers set enrollment_authenticated_at")) workerEnrollmentActivated = true;
    if (query.includes("select admission_state from workers") || query.includes("select public_key,encryption_public_key,admission_state from workers")) return [{ id: workerId, public_key: workerPublicKey, encryption_public_key: null, admission_state: "pending" }];
    if (query.includes("select desired_configuration")) return [{ desiredConfiguration: null, configurationRevision: null, appliedConfigurationRevision: null, configurationCommandId: null }];
    return [];
  }) as SqlStub;
  sqlDb.begin = async callback => callback(sqlDb);
  sqlDb.json = value => JSON.stringify(value);
  const secretBox = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
  memoryDb.appConfig = { id: 7, slug: "mars", pem: secretBox.encrypt("unused-pem"), clientId: "client-id", clientSecret: secretBox.encrypt("unused-client-secret"), webhookSecret: secretBox.encrypt(webhookSecret) };
  const githubApp = new GitHubAppService({ db: memoryDb, secretBox, publicOrigin: () => providerOrigin });
  const setupCalls: string[] = [];
  const started = await startControlPlane({
    publicOrigin: providerOrigin,
    db: sqlDb as unknown as NonNullable<ControlPlaneStartOptions["db"]>,
    setupOverride: {
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      setup: { publicOrigin: () => providerOrigin, publicOriginManaged: () => true, configure: async origin => { setupCalls.push(origin); assert(origin === providerOrigin, "setup route receives provider HTTPS origin"); return origin; }, authenticate: async () => ({ userId: "admin", firstAdmin: true }) },
    },
    secretBox,
    githubApp,
    currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }),
    skipBackgroundTasks: true,
    port: 0,
  });
  const upstream = started.server;
  type ProxyData = { upstream?: WebSocket; queued: Array<string | ArrayBuffer>; path: string };
  const proxy = Bun.serve<ProxyData>({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        assert(url.pathname === "/api/browser/invalidations" || url.pathname === "/api/v1/workers/connect", "proxy only upgrades the two control-plane socket paths");
        if (server.upgrade(request, { data: { queued: [], path: `${url.pathname}${url.search}` } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      if (url.pathname === "/api/github/webhooks" && body) forwardedWebhookBody = new TextDecoder().decode(body);
      const upstreamResponse = await fetch(`http://127.0.0.1:${upstream.port}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body });
      return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: upstreamResponse.headers });
    },
    websocket: {
      open(ws) {
        const upstreamSocket = new WebSocket(`ws://127.0.0.1:${upstream.port}${ws.data.path}`); ws.data.upstream = upstreamSocket;
        upstreamSocket.addEventListener("open", () => { for (const message of ws.data.queued) upstreamSocket.send(String(message)); ws.data.queued = []; });
        upstreamSocket.addEventListener("message", event => ws.send(String(event.data))); upstreamSocket.addEventListener("close", event => ws.close(event.code, event.reason)); upstreamSocket.addEventListener("error", () => ws.close(1011, "upstream websocket failed"));
      },
      message(ws, message) { if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(String(message)); else ws.data.queued.push(String(message)); },
      close(ws) { ws.data.upstream?.close(); },
    },
  });
  const baseUrl = `http://127.0.0.1:${proxy.port}`;
  try {
    const gatewayError = await started.gateway.fetch(new Request(`${baseUrl}/api/v1/workers/connect`, { headers: { upgrade: "websocket" } }), upstream);
    assert(gatewayError !== undefined && gatewayError.status === 400, "gateway rejected missing worker id");
    assert(gatewayError.headers.get("cache-control") === "no-store", "gateway JSON errors disable caching");
    const setupResponse = await fetch(`${baseUrl}/api/setup/github-app`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "smoke-manifest" }, body: JSON.stringify({ publicBaseUrl: providerOrigin }) });
    const setupResult = await setupResponse.json() as { manifest?: string; action?: string };
    assert(setupResponse.status === 200, `real setup route status is ${setupResponse.status}`); assert(setupCalls.length === 1 && setupCalls[0] === providerOrigin, "setup route reached the real control-plane setup object");
    assert(Boolean(setupResult.manifest && setupResult.action?.startsWith("https://github.com/settings/apps/new?state=")), "real GitHub manifest launch returned");
    const manifest = JSON.parse(setupResult.manifest!);
    assert(manifest.callback_urls?.[0] === `${providerOrigin}/api/auth/github/callback`, "manifest callback route uses provider origin"); assert(manifest.redirect_url === `${providerOrigin}/api/github/app/manifest/callback` && manifest.setup_url === `${providerOrigin}/api/github/app/setup`, "manifest setup and conversion routes are real routes");

    const rawBody = '{"zen":"keep-byte-for-byte","installation":{"id":7},"extra":"\\u0061"}';
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(Buffer.from(rawBody)).digest("hex")}`;
    const invalidResponse = await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `${signature.slice(0, -1)}0`, "x-github-delivery": "smoke-invalid", "x-github-event": "ping" }, body: rawBody });
    assert(invalidResponse.status === 401, `invalid webhook signature rejected with ${invalidResponse.status}`); assert(!deliveries.has("smoke-invalid"), "invalid signature did not create a delivery");
    const webhookResponse = await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-delivery": deliveryId, "x-github-event": "ping" }, body: rawBody });
    assert(webhookResponse.status === 202, `signed webhook status is ${webhookResponse.status}`); assert(forwardedWebhookBody === rawBody, "reverse proxy forwarded webhook bytes unchanged"); assert(deliveries.get(deliveryId)?.state === "completed", "signed webhook delivery reached completed state"); assert(persistedPayload === JSON.stringify(JSON.parse(rawBody)), "signed webhook payload persisted after exact-byte HMAC verification"); assert(persistedDelivery === deliveryId && persistedEvent === "ping" && deliveries.get(deliveryId)?.installationId === 7, "webhook delivery and event headers survived proxy forwarding");

    const browserSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/api/browser/invalidations?organizationId=${organizationId}`); const browserPong = waitForSocketMessage(browserSocket, message => message === "pong", "browser websocket upgrade"); browserSocket.addEventListener("open", () => browserSocket.send("ping")); await browserPong; browserSocket.close();
    const workerSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/api/v1/workers/connect?workerId=${workerId}`); const challengeMessage = await waitForSocketMessage(workerSocket, message => message.includes('"type":"challenge"'), "worker challenge"); const challenge = JSON.parse(challengeMessage) as { nonce: string }; const encryptionPublicKey = "smoke-encryption-public-key"; const canonical = Buffer.from(`${challenge.nonce}\n${workerId}\n${encryptionPublicKey}`); const signatureBytes = sign(null, canonical, workerKeys.privateKey).toString("base64url"); const authenticated = waitForSocketMessage(workerSocket, message => message.includes('"type":"authenticated"'), "worker authentication"); workerSocket.send(JSON.stringify({ version: 1, type: "authenticate", workerId, signature: signatureBytes, encryptionPublicKey })); await authenticated; assert(workerEnrollmentActivated, "worker challenge authentication atomically persisted authenticated enrollment"); workerSocket.close();

    console.log("PASS real manifest/setup route flow at provider HTTPS origin"); console.log("PASS invalid signature rejected without delivery"); console.log("PASS signed webhook raw-byte HMAC, headers, and completed delivery state"); console.log("PASS browser invalidations WebSocket upgrade through reverse proxy"); console.log("PASS worker challenge/signature authentication through reverse proxy");
  } finally { proxy.stop(true); upstream.stop(true); }
}

await main();
