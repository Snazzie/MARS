import { createDb, migrate, expireLeases } from "@whitesmith/db";
import type { WorkerCommand } from "@whitesmith/contracts";
import { WorkerCommand as WorkerCommandSchema } from "@whitesmith/contracts";
import type { Server, ServerWebSocket } from "bun";
import { createSession, getSession, SecretBox } from "./auth.ts";
import { createPkce, githubAuthorizeUrl, exchangeOAuth, ensureBootstrapAdmin, syncGithubOrganizations } from "./github.ts";
import { applyWorkflowJobWebhook, configureRunLifecycle } from "./runs.ts";
import { discoverAvailableRepositoryJobs } from "./job-discovery.ts";
import { readBody, validSignature, acceptDelivery } from "./webhook.ts";
import { verifyWorkerSignature } from "./workers.ts";
import { createWorkerChallenge, decodeWorkerSignature } from "./worker-socket.ts";
import { WorkerCommandDispatcher, containsSecret } from "./worker-dispatch.ts";
import { applyWorkerConfigurationAcknowledgement, createRequestLimiter } from "./worker-requests.ts";
import { handleAuthenticatedWorkerEvent } from "./worker-lifecycle.ts";
import { GitHubAppService } from "./github-app.ts";
import { runQueuedJobReconciliation } from "./job-reconciler.ts";
import { startReconciliationScheduler } from "./reconcile-loop.ts";
import { DiscoveryHealthMonitor } from "./discovery-health.ts";
import { createControlPlaneApp } from "./http/app.ts";
import { httpOrigin } from "./http-origin.ts";
const required = (name: string): string => { const value = Bun.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const baseUrl = httpOrigin("PUBLIC_BASE_URL", required("PUBLIC_BASE_URL"));
const browserBaseUrl = httpOrigin("BROWSER_BASE_URL", Bun.env.BROWSER_BASE_URL?.trim() || baseUrl);
const controlPlaneAdapterUrls = (Bun.env.CONTROL_PLANE_ADAPTER_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const developmentMasterKey = Bun.env.NODE_ENV === "production" ? undefined : Bun.env.APP_MASTER_KEY;
const masterFile = Bun.env.APP_MASTER_KEY_FILE;
const masterKey = masterFile ? (await Bun.file(masterFile).text()).trim() : developmentMasterKey;
if (!masterKey) throw new Error("APP_MASTER_KEY_FILE is required (or APP_MASTER_KEY in development)");
const env = { BASE: baseUrl, BROWSER_BASE: browserBaseUrl, WEBHOOK_URL: Bun.env.GITHUB_WEBHOOK_URL, DATABASE: required("DATABASE_URL"), WEBHOOK_SECRET: required("GITHUB_WEBHOOK_SECRET"), CLIENT_ID: required("GITHUB_OAUTH_CLIENT_ID"), CLIENT_SECRET: required("GITHUB_OAUTH_CLIENT_SECRET"), BOOTSTRAP: required("BOOTSTRAP_GITHUB_LOGIN"), MACOS_TART_BASE_IMAGE: Bun.env.WHITESMITH_TART_BASE_IMAGE, DEFAULT_IMAGES: { "linux-x64": Bun.env.DEFAULT_JOB_IMAGE_LINUX_X64, "windows-x64": Bun.env.DEFAULT_JOB_IMAGE_WINDOWS_X64, "macos-arm64": Bun.env.DEFAULT_JOB_IMAGE_MACOS_ARM64 }, TEMPLATE_MANIFESTS: { "windows-x64": Bun.env.WHITESMITH_WINDOWS_TEMPLATE_MANIFEST, "linux-x64": Bun.env.WHITESMITH_LINUX_TEMPLATE_MANIFEST }, TEMPLATE_ARTIFACTS: { "windows-x64": Bun.env.WHITESMITH_WINDOWS_TEMPLATE_VHDX, "linux-x64": Bun.env.WHITESMITH_LINUX_TEMPLATE_VHDX }, WORKER_TEMPLATE_PATHS: { "windows-x64": Bun.env.WHITESMITH_WINDOWS_TEMPLATE_PATH, "linux-x64": Bun.env.WHITESMITH_LINUX_TEMPLATE_PATH }, WORKER_TEMPLATE_DIGESTS: { "windows-x64": Bun.env.WHITESMITH_WINDOWS_TEMPLATE_DIGEST, "linux-x64": Bun.env.WHITESMITH_LINUX_TEMPLATE_DIGEST } };
const db = createDb(env.DATABASE); await migrate(db); const secretBox = new SecretBox(masterKey);
configureRunLifecycle(db);
const json = (data: unknown, status=200) => Response.json(data,{status,headers:{"cache-control":"no-store"}});
const cookie = (value:string, maxAge:number) => `whitesmith_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const sessions = new Map<string, {state:string; verifier:string; createdAt:number}>();
type SocketData = { actor: "browser" | "worker"; workerId: string; challenge?: Buffer; authenticated: boolean; connectionEpoch?: number };
const workerSockets = new Map<string, ServerWebSocket<SocketData>>();
const workerConnectionEpochs = new Map<string, number>();
let nextWorkerConnectionEpoch = 0;
async function current(request: Request) { return getSession(db, request.headers.get("cookie")?.match(/whitesmith_session=([^;]+)/)?.[1]); }
const commandStore = {
  async save(command: WorkerCommand): Promise<void> {
    await db`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${command.id},${command.version},${command.type},${command.workerId},${command.leaseId},${command.occurredAt},${JSON.stringify(command.payload)}) on conflict (id) do nothing`;
  },
  async listUnacknowledged(workerId: string): Promise<WorkerCommand[]> {
    const rows = await db`select c.id,c.version,c.type,c.worker_id as "workerId",c.lease_id as "leaseId",c.occurred_at as "occurredAt",c.payload from commands c left join runner_leases l on l.id=c.lease_id where c.worker_id=${workerId} and c.state in ('pending','sent') and (c.lease_id is null or l.state not in ('failed','reaped')) order by c.occurred_at asc,c.id asc`;
      return rows.map(row => WorkerCommandSchema.parse({
        ...row,
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
        occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
      }));
  },
  async markSent(commandId: string): Promise<void> {
    await db`update commands set state='sent' where id=${commandId} and state='pending'`;
  },
  async acknowledge(commandId: string): Promise<void> {
    await db`update commands set state='acknowledged' where id=${commandId} and state in ('pending','sent')`;
  },
};
const dispatcher = new WorkerCommandDispatcher(15_000, commandStore);
const requestSources = new WeakMap<Request, string>();
const webRoot = Bun.env.WEB_ROOT ? new URL(Bun.env.WEB_ROOT) : new URL("../../web/dist/", import.meta.url);
const reconciliationIntervalMs = Number(Bun.env.JOB_RECONCILIATION_INTERVAL_MS ?? 5_000);
const discoveryIntervalMs = Number(Bun.env.JOB_DISCOVERY_INTERVAL_MS ?? 30_000);
const startedAt = new Date().toISOString();
const discoveryHealth = new DiscoveryHealthMonitor(discoveryIntervalMs, Date.parse(startedAt));
const githubApp = new GitHubAppService({ db, secretBox, baseUrl: env.BASE, browserBaseUrl: env.BROWSER_BASE, webhookUrl: env.WEBHOOK_URL });
const httpApp = createControlPlaneApp({ db, baseUrl: env.BASE, browserBaseUrl: env.BROWSER_BASE, workerControlPlaneUrls: controlPlaneAdapterUrls, githubClientId: env.CLIENT_ID, githubClientSecret: env.CLIENT_SECRET, bootstrapGithubLogin: env.BOOTSTRAP, secretBox, githubApp, githubWebhookSecret: env.WEBHOOK_SECRET, defaultJobImages: env.DEFAULT_IMAGES, templateManifestPaths: env.TEMPLATE_MANIFESTS, templateArtifactPaths: env.TEMPLATE_ARTIFACTS, workerTemplatePaths: env.WORKER_TEMPLATE_PATHS, workerTemplateDigests: env.WORKER_TEMPLATE_DIGESTS, macosTartBaseImage: env.MACOS_TART_BASE_IMAGE, currentUser: current, requestId: () => crypto.randomUUID(), requestSource: (request) => requestSources.get(request) ?? "unknown", webRoot, workerInstallerRoot: new URL("../../../deploy/workers/", import.meta.url), workerServiceHostExecutable: new URL("../../../apps/windows-service-host/target/release/whitesmith-service-host.exe", import.meta.url), workerOrchestratorExecutables: { "linux-x64": new URL("../../../apps/orchestrator/dist/whitesmith-orchestrator", import.meta.url), "windows-x64": new URL("../../../apps/orchestrator/dist/whitesmith-orchestrator.exe", import.meta.url), "macos-arm64": new URL("../../../apps/orchestrator/dist/whitesmith-orchestrator-macos-arm64", import.meta.url) }, workerRequestLimiter: createRequestLimiter(), workerDispatcher: dispatcher, onWorkerAdopted: (workerId) => dispatcher.replayConnected(workerId), health: () => ({ buildId: Bun.env.WHITESMITH_BUILD_ID ?? "development", startedAt, discovery: discoveryHealth.snapshot() }) });
let nextDiscoveryAt = 0;
startReconciliationScheduler(async () => {
  try {
    if (Date.now() >= nextDiscoveryAt) {
      try {
        const report = await discoverAvailableRepositoryJobs({ db, installationToken: (installationId) => githubApp.getInstallationToken(installationId), repositoryFullName: Bun.env.JOB_DISCOVERY_REPOSITORY });
        if (report.discovered || report.failed) console.log(`GitHub job discovery: repositories=${report.repositories} discovered=${report.discovered} updated=${report.updated} failed=${report.failed}`);
      } catch (error) {
        console.error("GitHub job discovery failed", error);
      } finally {
        nextDiscoveryAt = Date.now() + discoveryIntervalMs;
      }
    }
    await expireLeases(db);
    const report = await runQueuedJobReconciliation({ db, installationToken: (installationId) => githubApp.getInstallationToken(installationId), dispatcher, workerConnected: (workerId) => dispatcher.isConnected(workerId) });
    console.log(`Job reconciliation tick: reserved=${report.reserved} failed=${report.failed} skipped=${report.skipped}`);
  } catch (error) {
    console.error("Job reconciliation failed", error);
  }
}, reconciliationIntervalMs);
let server: Server<SocketData>;
server = Bun.serve<SocketData>({
  port: Number(Bun.env.PORT ?? 3000),
  websocket: {
    open(ws) {
      if (ws.data.actor === "worker") {
        const challenge = createWorkerChallenge(ws.data.workerId);
        ws.data.challenge = challenge.nonce;
        ws.send(JSON.stringify({ version: 1, type: "challenge", nonce: challenge.nonce.toString("base64url") }));
      } else {
        ws.subscribe("browser");
      }
    },
    async message(ws, message) {
      if (ws.data.actor === "worker") {
        try {
          const frame = JSON.parse(String(message)) as { type?: string; signature?: string; workerId?: string; encryptionPublicKey?: string; payload?: Record<string, unknown> };
          if (frame.type === "authenticate" && frame.workerId === ws.data.workerId && frame.signature && typeof frame.encryptionPublicKey === "string") {
            const epoch = ws.data.connectionEpoch;
            if (!epoch || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return ws.close(4001, "superseded");
            if (!ws.data.challenge) return ws.close(1008, "worker authentication failed");
            const [worker] = await db`select public_key,encryption_public_key,admission_state from workers where id=${ws.data.workerId}`;
            const canonical = Buffer.from(`${ws.data.challenge.toString("base64url")}\n${ws.data.workerId}\n${frame.encryptionPublicKey}`);
            if (!worker || !verifyWorkerSignature(worker.public_key, canonical, decodeWorkerSignature(frame.signature))) return ws.close(1008, "worker authentication failed");
            if (worker.encryption_public_key && worker.encryption_public_key !== frame.encryptionPublicKey) return ws.close(1008, "worker encryption key mismatch");
            if (workerConnectionEpochs.get(ws.data.workerId) !== epoch) return ws.close(4001, "superseded");
            await db`update workers set encryption_public_key=COALESCE(encryption_public_key,${frame.encryptionPublicKey}), connection_state='online' where id=${ws.data.workerId}`;
            console.log(`Worker authenticated: ${ws.data.workerId}`);
            ws.data.authenticated = true;
            workerSockets.set(ws.data.workerId, ws);
            dispatcher.register(ws.data.workerId, ws);
            ws.send(JSON.stringify({ version: 1, type: "authenticated", workerId: ws.data.workerId, admissionState: worker.admission_state }));
          } else if (frame.type === "doctor" && ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && frame.workerId === ws.data.workerId && frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload) && !containsSecret(frame.payload)) {
            const epoch = ws.data.connectionEpoch;
            if (workerSockets.get(ws.data.workerId) !== ws || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return;
            await db`update workers set doctor=${JSON.stringify(frame.payload)} where id=${ws.data.workerId}`;
            if (workerSockets.get(ws.data.workerId) !== ws || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return;
            ws.send(JSON.stringify({ version: 1, type: "doctor_ack", workerId: ws.data.workerId }));
          } else if (frame.type === "pong" && ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && workerConnectionEpochs.get(ws.data.workerId) === ws.data.connectionEpoch) {
            ws.send(JSON.stringify({ version: 1, type: "ping" }));
          } else if (ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && workerConnectionEpochs.get(ws.data.workerId) === ws.data.connectionEpoch && frame.workerId === ws.data.workerId) {
            if (frame.type === "worker.configured") {
              const acknowledged = await applyWorkerConfigurationAcknowledgement(db, { workerId: ws.data.workerId, payload: frame.payload });
              console.log(`Worker configuration acknowledgement: ${ws.data.workerId} accepted=${acknowledged}`);
              dispatcher.handleEvent(frame, ws);
            } else {
              const accepted = await handleAuthenticatedWorkerEvent(db, dispatcher, frame, ws);
              if (!accepted) throw new Error("invalid worker event");
              console.log(`Worker event: ${ws.data.workerId} type=${frame.type}`);
            }
          } else {
            throw new Error("invalid worker frame");
          }
        } catch (error) {
          console.error("Worker websocket frame failed", { workerId: ws.data.workerId, error: error instanceof Error ? error.message : String(error) });
          ws.close(1008, "invalid worker frame");
        }
      } else if (message === "ping") {
        ws.send("pong");
      }
    },
    close(ws) {
      if (ws.data.actor === "worker") {
        dispatcher.unregister(ws.data.workerId, ws);
        const currentSocket = workerSockets.get(ws.data.workerId);
        if (currentSocket === ws) {
          workerSockets.delete(ws.data.workerId);
          if (ws.data.connectionEpoch === workerConnectionEpochs.get(ws.data.workerId)) {
            workerConnectionEpochs.delete(ws.data.workerId);
          }
          void db`update workers set connection_state='offline' where id=${ws.data.workerId}`;
        }
      } else {
        ws.unsubscribe("browser");
      }
    },
  },
  async fetch(request): Promise<Response | undefined> {
  const url=new URL(request.url);
    requestSources.set(request, server.requestIP(request)?.address ?? "unknown");
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname === "/api/v1/workers/connect") { const workerId = url.searchParams.get("workerId"); if (!workerId) return json({ error: "workerId required" }, 400); const previousEpoch = workerConnectionEpochs.get(workerId); const connectionEpoch = ++nextWorkerConnectionEpoch; workerConnectionEpochs.set(workerId, connectionEpoch); if (server.upgrade(request, { data: { actor: "worker", workerId, authenticated: false, connectionEpoch } })) return undefined; if (workerConnectionEpochs.get(workerId) === connectionEpoch) { if (previousEpoch === undefined) workerConnectionEpochs.delete(workerId); else workerConnectionEpochs.set(workerId, previousEpoch); } return json({ error: "websocket upgrade failed" }, 400); }
    return httpApp.fetch(request);
  },
});
console.log(`Whitesmith control plane listening on ${server.url}`);
