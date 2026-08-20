import { completeOnboardingIfReady, createDb, migrateDatabase, jsonParameter } from "@whitesmith/db";
import type { WorkerCommand } from "@whitesmith/contracts";
import { WorkerCommand as WorkerCommandSchema } from "@whitesmith/contracts";
import type { Server, ServerWebSocket } from "bun";
import { createSession, getSession, SecretBox } from "./auth.ts";
import { createPkce, githubAuthorizeUrl, exchangeOAuth, ensureBootstrapAdmin, syncGithubOrganizations } from "./github.ts";
import { applyWorkflowJobWebhook, configureRunLifecycle } from "./runs.ts";
import { discoverAvailableRepositoryJobs, discoverQueuedRepositoryJobs } from "./job-discovery.ts";
import { readBody, validSignature, acceptDelivery } from "./webhook.ts";
import { verifyWorkerSignature } from "./workers.ts";
import { createWorkerChallenge, decodeWorkerSignature } from "./worker-socket.ts";
import { WorkerCommandDispatcher, containsSecret, normalizeTimestamp } from "./worker-dispatch.ts";
import { applyWorkerConfigurationAcknowledgement, createRequestLimiter } from "./worker-requests.ts";
import { activateAuthenticatedWorkerConnection } from "./worker-connection.ts";
import { handleAuthenticatedWorkerEvent } from "./worker-lifecycle.ts";
import { GitHubAppService } from "./github-app.ts";
import { runQueuedJobReconciliation } from "./job-reconciler.ts";
import { reapPendingLeases } from "./lease-cleanup.ts";
import { reconcileExpiredLeasesWithGithub, reconcileWorkerInventory } from "./lease-reconciliation.ts";
import { startReconciliationScheduler } from "./reconcile-loop.ts";
import { pruneExpiredData } from "./retention.ts";
import { DiscoveryHealthMonitor, isDiscoveryCycleSuccessful } from "./discovery-health.ts";
import { createControlPlaneApp } from "./http/app.ts";
import type { ControlPlaneHttpDeps } from "./http/types.ts";
import { ensureDefaultPools } from "./default-pools.ts";
import { canSubscribeToOrganization, loadBrowserInvalidations } from "./browser-invalidations.ts";
import { GithubRateLimitGate } from "./github-rate-limit.ts";
import { httpOrigin } from "./http-origin.ts";
import { fileURLToPath } from "node:url";
const required = (name: string): string => { const value = Bun.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const baseUrl = httpOrigin("PUBLIC_BASE_URL", required("PUBLIC_BASE_URL"));
const browserBaseUrl = httpOrigin("BROWSER_BASE_URL", Bun.env.BROWSER_BASE_URL?.trim() || baseUrl);
const controlPlaneAdapterUrls = (Bun.env.CONTROL_PLANE_ADAPTER_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const developmentMasterKey = Bun.env.NODE_ENV === "production" ? undefined : Bun.env.APP_MASTER_KEY;
const masterFile = Bun.env.APP_MASTER_KEY_FILE;
const masterKey = masterFile ? (await Bun.file(masterFile).text()).trim() : developmentMasterKey;
if (!masterKey) throw new Error("APP_MASTER_KEY_FILE is required (or APP_MASTER_KEY in development)");
const env = { BASE: baseUrl, BROWSER_BASE: browserBaseUrl, WEBHOOK_URL: Bun.env.GITHUB_WEBHOOK_URL, DATABASE: required("DATABASE_URL"), WEBHOOK_SECRET: required("GITHUB_WEBHOOK_SECRET"), CLIENT_ID: required("GITHUB_OAUTH_CLIENT_ID"), CLIENT_SECRET: required("GITHUB_OAUTH_CLIENT_SECRET"), BOOTSTRAP: required("BOOTSTRAP_GITHUB_LOGIN"), MACOS_TART_BASE_IMAGE: Bun.env.WHITESMITH_TART_BASE_IMAGE, DEFAULT_IMAGES: { "linux-x64": Bun.env.DEFAULT_JOB_IMAGE_LINUX_X64, "windows-x64": Bun.env.DEFAULT_JOB_IMAGE_WINDOWS_X64, "macos-arm64": Bun.env.DEFAULT_JOB_IMAGE_MACOS_ARM64 }, TEMPLATE_MANIFESTS: { "windows-x64": Bun.env.WHITESMITH_WINDOWS_TEMPLATE_MANIFEST, "linux-x64": Bun.env.WHITESMITH_LINUX_TEMPLATE_MANIFEST }, TEMPLATE_ARTIFACTS: { "windows-x64": Bun.env.WHITESMITH_WINDOWS_TEMPLATE_ARTIFACT, "linux-x64": Bun.env.WHITESMITH_LINUX_TEMPLATE_ARTIFACT }, WORKER_TEMPLATE_PATHS: { "windows-x64": Bun.env.WHITESMITH_WINDOWS_TEMPLATE_PATH, "linux-x64": Bun.env.WHITESMITH_LINUX_TEMPLATE_PATH }, WORKER_TEMPLATE_DIGESTS: { "windows-x64": Bun.env.WHITESMITH_WINDOWS_TEMPLATE_DIGEST, "linux-x64": Bun.env.WHITESMITH_LINUX_TEMPLATE_DIGEST } };
const production = Bun.env.NODE_ENV === "production";
const webRoot = new URL(Bun.env.WEB_ROOT ?? "../../web/dist/", import.meta.url);
const workerInstallerRoot = new URL(production ? required("WORKER_INSTALLER_ROOT") : Bun.env.WORKER_INSTALLER_ROOT ?? "../../../deploy/workers/", import.meta.url);
const runtimeArtifact = (name: string, fallback: string): URL | undefined => {
  const configured = Bun.env[name];
  return configured ? new URL(configured, import.meta.url) : production ? undefined : new URL(fallback, import.meta.url);
};
const workerServiceHostExecutable = runtimeArtifact("WORKER_SERVICE_HOST_EXECUTABLE", "../../../apps/windows-service-host/target/release/whitesmith-service-host.exe");
const workerOrchestratorExecutables = {
  "linux-x64": runtimeArtifact("WORKER_ORCHESTRATOR_LINUX_X64", "../../../apps/orchestrator/dist/whitesmith-orchestrator"),
  "windows-x64": runtimeArtifact("WORKER_ORCHESTRATOR_WINDOWS_X64", "../../../apps/orchestrator/dist/whitesmith-orchestrator.exe"),
  "macos-arm64": runtimeArtifact("WORKER_ORCHESTRATOR_MACOS_ARM64", "../../../apps/orchestrator/dist/whitesmith-orchestrator-macos-arm64"),
};
const containerBuildArtifact = (name: string, fallback: string): string | undefined => {
  const artifact = runtimeArtifact(name, fallback);
  return artifact ? fileURLToPath(artifact) : undefined;
};
type WindowsContainerReleaseConfig = {
  baseImage: string;
  runnerUrl: string;
  runnerSha256: string;
  gitUrl: string;
  gitSha256: string;
  vcUrl: string;
  vcSha256: string;
};
const loadWindowsContainerBuild = async (): Promise<ControlPlaneHttpDeps["windowsContainerBuild"]> => {
  const manifestUrl = new URL(Bun.env.WHITESMITH_RELEASE_MANIFEST ?? (production ? "./release-manifest.json" : "../../../deploy/control-plane/release-manifest.json"), import.meta.url);
  const manifest = await Bun.file(manifestUrl).json().catch(() => null) as { windowsContainerBuild?: WindowsContainerReleaseConfig | null } | null;
  const release = manifest?.windowsContainerBuild;
  if (!release) return undefined;
  return {
    ...release,
    builderPath: containerBuildArtifact("WHITESMITH_WINDOWS_CONTAINER_BUILDER", "../../../deploy/workers/build-windows-container-image-local.ps1")!,
    verifierPath: containerBuildArtifact("WHITESMITH_WINDOWS_CONTAINER_VERIFIER", "../../../images/jobs/windows/verify-runtime.ps1")!,
    containerfilePath: containerBuildArtifact("WHITESMITH_WINDOWS_CONTAINERFILE", "../../../images/jobs/windows/Containerfile")!,
    entrypointPath: containerBuildArtifact("WHITESMITH_WINDOWS_CONTAINER_ENTRYPOINT", "../../../images/jobs/windows/entrypoint.ps1")!,
    jobAgentPath: containerBuildArtifact("WHITESMITH_WINDOWS_CONTAINER_JOB_AGENT", "../../../apps/job-agent/dist/whitesmith-job-agent.exe")!,
  };
};
const windowsContainerBuild = await loadWindowsContainerBuild();
if (production) {
  const requiredReleaseArtifacts = {
    webIndex: new URL("index.html", webRoot),
    webScript: new URL("index.js", webRoot),
    webStyles: new URL("index.css", webRoot),
    windowsInstaller: new URL("install-worker.ps1", workerInstallerRoot),
    windowsServiceHost: workerServiceHostExecutable,
    windowsOrchestrator: workerOrchestratorExecutables["windows-x64"],
  };
  for (const [name, artifact] of Object.entries(requiredReleaseArtifacts)) {
    if (!artifact || !await Bun.file(artifact).exists()) throw new Error(`release artifact is unavailable: ${name}`);
  }
}
const db = createDb(env.DATABASE); await migrateDatabase(db); await ensureDefaultPools(db, env.DEFAULT_IMAGES); const secretBox = new SecretBox(masterKey);
configureRunLifecycle(db);
const json = (data: unknown, status=200) => Response.json(data,{status,headers:{"cache-control":"no-store"}});
const cookie = (value:string, maxAge:number) => `whitesmith_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const sessions = new Map<string, {state:string; verifier:string; createdAt:number}>();
type WorkerSocketData = { actor: "worker"; workerId: string; challenge?: Buffer; authenticated: boolean; connectionEpoch?: number; authTimer?: ReturnType<typeof setTimeout> };
type BrowserSocketData = { actor: "browser"; organizationId: string; cursor: number };
type SocketData = WorkerSocketData | BrowserSocketData;
const workerSockets = new Map<string, ServerWebSocket<SocketData>>();
const browserSockets = new Set<ServerWebSocket<SocketData>>();
const replayingBrowserSockets = new WeakSet<ServerWebSocket<SocketData>>();
const workerConnectionEpochs = new Map<string, number>();
let nextWorkerConnectionEpoch = 0;
async function replayBrowserInvalidations(ws: ServerWebSocket<SocketData>): Promise<void> {
  if (ws.data.actor !== "browser" || replayingBrowserSockets.has(ws)) return;
  replayingBrowserSockets.add(ws);
  try {
    for (let page = 0; page < 10; page += 1) {
      const rows = await loadBrowserInvalidations(db, ws.data.organizationId, ws.data.cursor);
      for (const row of rows) {
        ws.send(JSON.stringify({ version: 1, type: "invalidate", ...row }));
        ws.data.cursor = row.sequence;
      }
      if (rows.length < 100) break;
    }
  } finally {
    replayingBrowserSockets.delete(ws);
  }
}
async function current(request: Request) { return getSession(db, request.headers.get("cookie")?.match(/whitesmith_session=([^;]+)/)?.[1]); }
const commandStore = {
  async save(command: WorkerCommand): Promise<void> {
    await db`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${command.id},${command.version},${command.type},${command.workerId},${command.leaseId},${command.occurredAt},${jsonParameter(db, command.payload)}) on conflict (id) do nothing`;
  },
  async listUnacknowledged(workerId: string): Promise<WorkerCommand[]> {
    const rows = await db`select c.id,c.version,c.type,c.worker_id as "workerId",c.lease_id as "leaseId",c.occurred_at as "occurredAt",c.payload from commands c left join runner_leases l on l.id=c.lease_id where c.worker_id=${workerId} and c.state in ('pending','sent') and (c.lease_id is null or l.state not in ('failed','reaped')) order by c.occurred_at asc,c.id asc`;
      return rows.map(row => WorkerCommandSchema.parse({
        ...row,
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
        occurredAt: normalizeTimestamp(row.occurredAt),
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
const reconciliationIntervalMs = Number(Bun.env.JOB_RECONCILIATION_INTERVAL_MS ?? 5_000);
const discoveryIntervalMs = Number(Bun.env.JOB_DISCOVERY_INTERVAL_MS ?? 30_000);
const queuedDiscoveryIntervalMs = Number(Bun.env.JOB_QUEUED_DISCOVERY_INTERVAL_MS ?? 30_000);
const startedAt = new Date().toISOString();
const discoveryHealth = new DiscoveryHealthMonitor(discoveryIntervalMs, Date.parse(startedAt));
const githubApp = new GitHubAppService({ db, secretBox, baseUrl: env.BASE, browserBaseUrl: env.BROWSER_BASE, webhookUrl: env.WEBHOOK_URL });
const githubRateLimits = new GithubRateLimitGate();
let triggerReconciliation = () => Promise.resolve();
const httpApp = createControlPlaneApp({ db, baseUrl: env.BASE, browserBaseUrl: env.BROWSER_BASE, workerControlPlaneUrls: controlPlaneAdapterUrls, githubClientId: env.CLIENT_ID, githubClientSecret: env.CLIENT_SECRET, bootstrapGithubLogin: env.BOOTSTRAP, secretBox, githubApp, githubWebhookSecret: env.WEBHOOK_SECRET, defaultJobImages: env.DEFAULT_IMAGES, windowsContainerBuild, templateManifestPaths: env.TEMPLATE_MANIFESTS, templateArtifactPaths: env.TEMPLATE_ARTIFACTS, workerTemplatePaths: env.WORKER_TEMPLATE_PATHS, workerTemplateDigests: env.WORKER_TEMPLATE_DIGESTS, macosTartBaseImage: env.MACOS_TART_BASE_IMAGE, currentUser: current, requestId: () => crypto.randomUUID(), requestSource: (request) => requestSources.get(request) ?? "unknown", webRoot, workerInstallerRoot, workerServiceHostExecutable, workerOrchestratorExecutables, workerRequestLimiter: createRequestLimiter(), workerDispatcher: dispatcher, onWorkerAdopted: (workerId) => { dispatcher.replayConnected(workerId); void triggerReconciliation(); }, health: () => ({ buildId: Bun.env.WHITESMITH_BUILD_ID ?? "development", startedAt, discovery: discoveryHealth.snapshot() }) });
const discoveryDeps = { db, installationToken: (installationId: number) => githubApp.getInstallationToken(installationId), githubFetchForInstallation: (installationId: number) => githubRateLimits.scopedFetch(installationId), repositoryFullName: Bun.env.JOB_DISCOVERY_REPOSITORY };
let lastQueuedDiscoveryAt = 0;
startReconciliationScheduler(async () => {
  discoveryHealth.markAttempt();
  try {
    const report = await discoverAvailableRepositoryJobs(discoveryDeps);
    if (isDiscoveryCycleSuccessful(report)) discoveryHealth.markSuccess();
    if (report.discovered || report.failed) console.log(`GitHub job discovery: repositories=${report.repositories} discovered=${report.discovered} updated=${report.updated} failed=${report.failed}`);
  } catch (error) {
    console.error("GitHub job discovery failed", error);
  }
}, discoveryIntervalMs);
const reconciliationScheduler = startReconciliationScheduler(async () => {
  try {
    if (Date.now() - lastQueuedDiscoveryAt >= queuedDiscoveryIntervalMs) {
      lastQueuedDiscoveryAt = Date.now();
      const pickup = await discoverQueuedRepositoryJobs(discoveryDeps);
      if (pickup.discovered || pickup.failed) console.log(`Queued GitHub job pickup: repositories=${pickup.repositories} discovered=${pickup.discovered} updated=${pickup.updated} failed=${pickup.failed}`);
    }
    const staleLeaseReport = await reconcileExpiredLeasesWithGithub({
      db,
      installationToken: (installationId) => githubApp.getInstallationToken(installationId),
      githubFetchForInstallation: (installationId) => githubRateLimits.scopedFetch(installationId),
    });
    if (staleLeaseReport.completed || staleLeaseReport.skipped) console.log(`GitHub stale lease reconciliation: inspected=${staleLeaseReport.inspected} completed=${staleLeaseReport.completed} stillActive=${staleLeaseReport.stillActive} skipped=${staleLeaseReport.skipped}`);
    const report = await runQueuedJobReconciliation({
      db,
      installationToken: (installationId) => githubApp.getInstallationToken(installationId),
      githubFetchForInstallation: (installationId) => githubRateLimits.scopedFetch(installationId),
      dispatcher,
      workerConnected: (workerId) => dispatcher.isConnected(workerId),
      repositoryFullName: Bun.env.JOB_DISCOVERY_REPOSITORY,
    });
    console.log(`Job reconciliation tick: reserved=${report.reserved} failed=${report.failed} skipped=${report.skipped}`);
  } catch (error) {
    console.error("Job reconciliation failed", error);
  } finally {
    try {
      const cleanup = await reapPendingLeases({ db, dispatch: dispatcher.dispatch.bind(dispatcher), workerConnected: (workerId) => dispatcher.isConnected(workerId) });
      if (cleanup.dispatched || cleanup.failed) console.log(`Lease cleanup tick: dispatched=${cleanup.dispatched} failed=${cleanup.failed} skipped=${cleanup.skipped}`);
      await completeOnboardingIfReady(db);
    } catch (error) {
      console.error("Lease cleanup failed", error);
    }
  }
}, reconciliationIntervalMs);
const retentionIntervalMs = 24 * 60 * 60 * 1_000;
const runRetention = async () => {
  try {
    console.log("Retention pruner", await pruneExpiredData(db));
  } catch (error) {
    console.error("Retention pruning failed", error);
  }
};
void runRetention();
setInterval(() => { void runRetention(); }, retentionIntervalMs);
triggerReconciliation = reconciliationScheduler.trigger;
setInterval(() => {
  for (const socket of browserSockets) void replayBrowserInvalidations(socket);
}, 1_000);
let server: Server<SocketData>;
server = Bun.serve<SocketData>({
  port: Number(Bun.env.PORT ?? 3000),
  websocket: {
    open(ws) {
      if (ws.data.actor === "worker") {
        const workerData = ws.data;
        workerData.authTimer = setTimeout(() => { if (!workerData.authenticated) ws.close(1008, "worker authentication timeout"); }, 10_000);
        const challenge = createWorkerChallenge(workerData.workerId);
        workerData.challenge = challenge.nonce;
        ws.send(JSON.stringify({ version: 1, type: "challenge", nonce: challenge.nonce.toString("base64url") }));
      } else {
        browserSockets.add(ws);
        void replayBrowserInvalidations(ws);
      }
    },
    async message(ws, message) {
      if (ws.data.actor === "worker") {
        const workerData = ws.data;
        try {
          if (typeof message === "string" ? message.length > 256 * 1024 : message.byteLength > 256 * 1024) return ws.close(1009, "worker frame too large");
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
            const activated = await activateAuthenticatedWorkerConnection({
              db,
              workerId: ws.data.workerId,
              encryptionPublicKey: frame.encryptionPublicKey,
              socket: ws,
              workerSockets,
              dispatcher,
              isCurrent: () => workerConnectionEpochs.get(workerData.workerId) === epoch,
              markAuthenticated: () => {
                workerData.authTimer && clearTimeout(workerData.authTimer);
                workerData.authTimer = undefined;
                workerData.authenticated = true;
              },
            });
            if (!activated) return ws.close(4001, "superseded");
            ws.send(JSON.stringify({ version: 1, type: "authenticated", workerId: ws.data.workerId, admissionState: worker.admission_state }));
          } else if (frame.type === "doctor" && ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && frame.workerId === ws.data.workerId && frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload) && !containsSecret(frame.payload)) {
            const epoch = ws.data.connectionEpoch;
            if (workerSockets.get(ws.data.workerId) !== ws || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return;
            const doctorPayload = frame.payload as Record<string, unknown>;
            await db`update workers set doctor=${jsonParameter(db, doctorPayload)}, doctor_observed_at=now(), last_heartbeat_at=now() where id=${ws.data.workerId}`;
            const activeLeases = doctorPayload.doctor && typeof doctorPayload.doctor === "object" && !Array.isArray(doctorPayload.doctor) ? (doctorPayload.doctor as Record<string, unknown>).activeLeases : undefined;
            if (Array.isArray(activeLeases) && activeLeases.every((value): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))) {
              const recovered = await reconcileWorkerInventory(db, ws.data.workerId, activeLeases);
              if (recovered) console.log(`Worker inventory cleanup: worker=${ws.data.workerId} recovered=${recovered}`);
            }
            if (workerSockets.get(ws.data.workerId) !== ws || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return;
            ws.send(JSON.stringify({ version: 1, type: "doctor_ack", workerId: ws.data.workerId }));
          } else if (frame.type === "pong" && ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && workerConnectionEpochs.get(ws.data.workerId) === ws.data.connectionEpoch) {
            await db`update workers set last_heartbeat_at=now() where id=${ws.data.workerId}`;
            ws.send(JSON.stringify({ version: 1, type: "ping" }));
          } else if (ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && workerConnectionEpochs.get(ws.data.workerId) === ws.data.connectionEpoch && frame.workerId === ws.data.workerId) {
            if (frame.type === "worker.configured") {
              const acknowledged = await applyWorkerConfigurationAcknowledgement(db, { workerId: ws.data.workerId, payload: frame.payload });
              if (!acknowledged) {
                const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
                const [state] = await db`SELECT configuration_command_id AS "commandId", configuration_revision AS revision, desired_configuration AS desired FROM workers WHERE id=${ws.data.workerId}`;
                console.error("Worker configuration acknowledgement rejected", { workerId: ws.data.workerId, commandId: payload.commandId, revision: payload.revision, expectedCommandId: state?.commandId, expectedRevision: state?.revision, observed: payload.observed, desired: state?.desired });
              }
              console.log(`Worker configuration acknowledgement: ${ws.data.workerId} accepted=${acknowledged}`);
              dispatcher.handleEvent(frame, ws);
              void triggerReconciliation();
            } else {
              const accepted = await handleAuthenticatedWorkerEvent(db, dispatcher, frame, ws);
              if (!accepted) throw new Error("invalid worker event");
              console.log(`Worker event: ${ws.data.workerId} type=${frame.type}`);
            }
          }
        } catch (error) {
          console.error("Worker websocket frame failed", { workerId: ws.data.workerId, error: error instanceof Error ? error.message : String(error) });
          ws.close(1008, "invalid worker frame");
        }
      } else if (String(message) === "ping") {
        ws.send("pong");
      }
    },
    close(ws) {
      if (ws.data.actor === "worker") {
        if (ws.data.authTimer) {
          clearTimeout(ws.data.authTimer);
          ws.data.authTimer = undefined;
        }
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
        browserSockets.delete(ws);
      }
    },
  },
  async fetch(request): Promise<Response | undefined> {
  const url=new URL(request.url);
    requestSources.set(request, server.requestIP(request)?.address ?? "unknown");
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname === "/api/browser/invalidations") {
      try {
        const user = await current(request);
        if (!user) return json({ code: "unauthorized", message: "Authentication required" }, 401);
        const organizationId = url.searchParams.get("organizationId") ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) return json({ code: "invalid_request", message: "A concrete organization is required" }, 400);
        const rawCursor = Number(url.searchParams.get("cursor") ?? 0);
        const cursor = Number.isSafeInteger(rawCursor) && rawCursor >= 0 ? rawCursor : 0;
        if (!await canSubscribeToOrganization(db, user, organizationId)) return json({ code: "not_found", message: "Organization not found" }, 404);
        if (server.upgrade(request, { data: { actor: "browser", organizationId, cursor } })) return undefined;
        return json({ code: "upgrade_failed", message: "WebSocket upgrade failed" }, 400);
      } catch (error) {
        console.error("Browser invalidation websocket upgrade failed", error);
        return json({ code: "internal_error", message: "WebSocket upgrade failed" }, 500);
      }
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname === "/api/v1/workers/connect") {
      const workerId = url.searchParams.get("workerId");
      if (!workerId) return json({ error: "workerId required" }, 400);
      const [worker] = await db`select admission_state from workers where id=${workerId}`;
      if (!worker || worker.admission_state === "revoked" || worker.admission_state === "rejected") return json({ code: "worker_unavailable", message: "Worker is unknown or revoked" }, 403);
      const previousEpoch = workerConnectionEpochs.get(workerId);
      const connectionEpoch = ++nextWorkerConnectionEpoch;
      workerConnectionEpochs.set(workerId, connectionEpoch);
      if (server.upgrade(request, { data: { actor: "worker", workerId, authenticated: false, connectionEpoch } })) return undefined;
      if (workerConnectionEpochs.get(workerId) === connectionEpoch) {
        if (previousEpoch === undefined) workerConnectionEpochs.delete(workerId); else workerConnectionEpochs.set(workerId, previousEpoch);
      }
      return json({ error: "websocket upgrade failed" }, 400);
    }
    return httpApp.fetch(request);
  },
});
console.log(`Whitesmith control plane listening on ${server.url}`);
