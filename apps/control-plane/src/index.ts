import { completeOnboardingIfReady, createDb, ensureDatabase, migrateDatabase, jsonParameter, type DashboardDb } from "@mars/db";
import { WorkerCommand as WorkerCommandSchema, type WorkerCommand, type WorkerReleaseManifest } from "@mars/contracts";
import type { Server } from "bun";
import { getSession, SecretBox, type SessionUser } from "./auth.ts";
import { configureRunLifecycle } from "./runs.ts";
import { discoverAvailableRepositoryJobs, discoverQueuedRepositoryJobs } from "./job-discovery.ts";
import { WorkerCommandDispatcher, normalizeTimestamp } from "./worker-dispatch.ts";
import { createRequestLimiter } from "./worker-requests.ts";
import { GitHubAppService } from "./github-app.ts";
import { runQueuedJobReconciliation } from "./job-reconciler.ts";
import { reapPendingLeases } from "./lease-cleanup.ts";
import { reconcileExpiredLeasesWithGithub } from "./lease-reconciliation.ts";
import { startReconciliationScheduler } from "./reconcile-loop.ts";
import { pruneExpiredData } from "./retention.ts";
import { DiscoveryHealthMonitor, isDiscoveryCycleSuccessful } from "./discovery-health.ts";
import { createControlPlaneApp } from "./http/app.ts";
import type { ControlPlaneHttpDeps } from "./http/types.ts";
import type { ControlPlaneSetup } from "./control-plane-setup.ts";
import { ensureDefaultPools } from "./default-pools.ts";
import { GithubRateLimitGate } from "./github-rate-limit.ts";
import { fileURLToPath } from "node:url";
import { initializeControlPlaneSetup } from "./control-plane-setup.ts";
import { httpOrigin, publicHttpOrigin } from "./http-origin.ts";
import { loadWorkerReleaseManifest } from "./worker-release.ts";
import { createControlPlaneGateway, type ControlPlaneSocketData } from "./control-plane-gateway.ts";

export function resolveWebhookOrigin(raw: string | undefined = Bun.env.GITHUB_WEBHOOK_URL): string {
  if (!raw?.trim()) throw new Error("GITHUB_WEBHOOK_URL is required");
  return publicHttpOrigin("GITHUB_WEBHOOK_URL", raw);
}

export type ControlPlaneStartOptions = {
  /** Test seams; production uses the normal environment-backed implementations. */
  db?: DashboardDb;
  setupOverride?: { setup: ControlPlaneSetup; masterKey: string };
  /** Optional canonical browser origin seam; production uses PUBLIC_BASE_URL. */
  publicOrigin?: string;
  /** Optional public GitHub webhook origin seam; production uses GITHUB_WEBHOOK_URL. */
  webhookOrigin?: string;
  workerOrigin?: string;
  /** Legacy test/internal seam; production uses WORKER_BASE_URL. */
  adapterUrls?: string[];
  port?: number;
  skipBackgroundTasks?: boolean;
  skipArtifactChecks?: boolean;
  secretBox?: SecretBox;
  githubApp?: GitHubAppService;
  workerReleaseManifest?: WorkerReleaseManifest;
  currentUser?: (request: Request) => Promise<SessionUser | null>;
  dispatcher?: WorkerCommandDispatcher;
  webRoot?: URL;
  workerInstallerRoot?: URL;
};

type DatabaseBootstrapDependencies = {
  ensureDatabase: (url: string) => Promise<void>;
  createDb: (url: string) => DashboardDb;
  migrateDatabase: (db: DashboardDb) => Promise<void>;
};

export async function initializeDatabase(url: string, dependencies: DatabaseBootstrapDependencies = { ensureDatabase, createDb, migrateDatabase }): Promise<DashboardDb> {
  await dependencies.ensureDatabase(url);
  const db = dependencies.createDb(url);
  await dependencies.migrateDatabase(db);
  return db;
}

export async function startControlPlane(options: ControlPlaneStartOptions = {}) {
  const required = (name: string): string => { const value = Bun.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
  const production = Bun.env.NODE_ENV === "production";
  const dataRoot = Bun.env.DATA_ROOT?.trim() || "/var/lib/mars";
  const configuredPublicOriginRaw = options.publicOrigin?.trim() || Bun.env.PUBLIC_BASE_URL?.trim() || undefined;
  const configuredPublicOrigin = configuredPublicOriginRaw ? httpOrigin("PUBLIC_BASE_URL", configuredPublicOriginRaw) : undefined;
  const configuredWebhookOrigin = options.webhookOrigin?.trim()
    ? publicHttpOrigin("GITHUB_WEBHOOK_URL", options.webhookOrigin)
    : resolveWebhookOrigin();
  const configuredWorkerOriginRaw = options.workerOrigin?.trim() || Bun.env.WORKER_BASE_URL?.trim();
  const configuredWorkerOrigins = configuredWorkerOriginRaw
    ? [httpOrigin("WORKER_BASE_URL", configuredWorkerOriginRaw)]
    : options.adapterUrls?.map(value => httpOrigin("CONTROL_PLANE_ADAPTER_URLS", value)) ?? [];
  const env = {
    MACOS_TART_BASE_IMAGE: Bun.env.MARS_TART_BASE_IMAGE,
    DEFAULT_IMAGES: { "linux-x64": Bun.env.DEFAULT_JOB_IMAGE_LINUX_X64, "windows-x64": Bun.env.DEFAULT_JOB_IMAGE_WINDOWS_X64, "macos-arm64": Bun.env.DEFAULT_JOB_IMAGE_MACOS_ARM64 },
    TEMPLATE_MANIFESTS: { "windows-x64": Bun.env.MARS_WINDOWS_TEMPLATE_MANIFEST, "linux-x64": Bun.env.MARS_LINUX_TEMPLATE_MANIFEST },
    TEMPLATE_ARTIFACTS: { "windows-x64": Bun.env.MARS_WINDOWS_TEMPLATE_ARTIFACT, "linux-x64": Bun.env.MARS_LINUX_TEMPLATE_ARTIFACT },
    WORKER_TEMPLATE_PATHS: { "windows-x64": Bun.env.MARS_WINDOWS_TEMPLATE_PATH, "linux-x64": Bun.env.MARS_LINUX_TEMPLATE_PATH },
    WORKER_TEMPLATE_DIGESTS: { "windows-x64": Bun.env.MARS_WINDOWS_TEMPLATE_DIGEST, "linux-x64": Bun.env.MARS_LINUX_TEMPLATE_DIGEST },
  };
  const webRoot = options.webRoot ?? new URL(Bun.env.WEB_ROOT ?? "../../web/dist/", import.meta.url);
  const workerInstallerRoot = options.workerInstallerRoot ?? new URL(production ? required("WORKER_INSTALLER_ROOT") : Bun.env.WORKER_INSTALLER_ROOT ?? "../../../deploy/workers/", import.meta.url);
  const runtimeArtifact = (name: string, fallback: string): URL | undefined => {
    const configured = Bun.env[name];
    return configured ? new URL(configured, import.meta.url) : production ? undefined : new URL(fallback, import.meta.url);
  };
  const workerServiceHostExecutable = runtimeArtifact("WORKER_SERVICE_HOST_EXECUTABLE", "../../../apps/windows-service-host/target/release/mars-service-host.exe");
  const workerOrchestratorExecutables = {
    "linux-x64": runtimeArtifact("WORKER_ORCHESTRATOR_LINUX_X64", "../../../apps/orchestrator/dist/mars-orchestrator"),
    "windows-x64": runtimeArtifact("WORKER_ORCHESTRATOR_WINDOWS_X64", "../../../apps/orchestrator/dist/mars-orchestrator.exe"),
    "macos-arm64": runtimeArtifact("WORKER_ORCHESTRATOR_MACOS_ARM64", "../../../apps/orchestrator/dist/mars-orchestrator-macos-arm64"),
  };
  const containerBuildArtifact = (name: string, fallback: string): string | undefined => {
    const artifact = runtimeArtifact(name, fallback);
    return artifact ? fileURLToPath(artifact) : undefined;
  };
  const loadWindowsContainerArtifacts = (): ControlPlaneHttpDeps["windowsContainerArtifacts"] => {
    const artifacts = {
      builderPath: containerBuildArtifact("MARS_WINDOWS_CONTAINER_BUILDER", "../../../deploy/workers/build-windows-container-image-local.ps1"),
      verifierPath: containerBuildArtifact("MARS_WINDOWS_CONTAINER_VERIFIER", "../../../images/jobs/windows/verify-runtime.ps1"),
      containerfilePath: containerBuildArtifact("MARS_WINDOWS_CONTAINERFILE", "../../../images/jobs/windows/Containerfile"),
      entrypointPath: containerBuildArtifact("MARS_WINDOWS_CONTAINER_ENTRYPOINT", "../../../images/jobs/windows/entrypoint.ps1"),
      jobAgentPath: containerBuildArtifact("MARS_WINDOWS_CONTAINER_JOB_AGENT", "../../../apps/job-agent/dist/mars-job-agent.exe"),
    };
    return Object.values(artifacts).every(Boolean) ? artifacts as NonNullable<ControlPlaneHttpDeps["windowsContainerArtifacts"]> : undefined;
  };
  const windowsContainerArtifacts = loadWindowsContainerArtifacts();
  const workerReleaseManifest = options.workerReleaseManifest ?? await loadWorkerReleaseManifest();
  if (production && !options.skipArtifactChecks) {
    const requiredReleaseArtifacts = {
      webIndex: new URL("index.html", webRoot),
      webScript: new URL("index.js", webRoot),
      webStyles: new URL("index.css", webRoot),
      releaseManifest: Bun.env.WORKER_RELEASE_MANIFEST?.trim() || "/app/release-manifest.json",
      linuxInstaller: new URL("install-worker.sh", workerInstallerRoot),
      windowsInstaller: new URL("install-worker.ps1", workerInstallerRoot),
      macosInstaller: new URL("install-worker-macos.sh", workerInstallerRoot),
      linuxCompose: new URL("linux-broker-compose.yaml", workerInstallerRoot),
      linuxDomainTemplate: new URL("worker-domain.xml", workerInstallerRoot),
      linuxOrchestrator: workerOrchestratorExecutables["linux-x64"],
      windowsServiceHost: workerServiceHostExecutable,
      windowsOrchestrator: workerOrchestratorExecutables["windows-x64"],
      macosOrchestrator: workerOrchestratorExecutables["macos-arm64"],
      windowsContainerBuilder: windowsContainerArtifacts?.builderPath,
      windowsContainerVerifier: windowsContainerArtifacts?.verifierPath,
      windowsContainerfile: windowsContainerArtifacts?.containerfilePath,
      windowsContainerEntrypoint: windowsContainerArtifacts?.entrypointPath,
      windowsContainerJobAgent: windowsContainerArtifacts?.jobAgentPath,
    };
    for (const [name, artifact] of Object.entries(requiredReleaseArtifacts)) {
      if (!artifact || !await Bun.file(artifact).exists()) throw new Error(`release artifact is unavailable: ${name}`);
    }
  }
  let db: DashboardDb;
  if (options.db) {
    db = options.db;
  } else {
    db = await initializeDatabase(required("DATABASE_URL"));
    await ensureDefaultPools(db, env.DEFAULT_IMAGES);
    configureRunLifecycle(db);
  }
  const initialized = options.setupOverride ?? await initializeControlPlaneSetup(db, dataRoot, configuredPublicOrigin);
  const workerConnectionOrigins = (): string[] => {
    const canonical = initialized.setup.publicOrigin() ?? configuredPublicOrigin;
    return [...new Set([canonical, ...configuredWorkerOrigins].filter((origin): origin is string => Boolean(origin)))];
  };
  const secretBox = options.secretBox ?? new SecretBox(initialized.masterKey);
  const sessions = new Map<string, { state: string; verifier: string; createdAt: number }>();
  const current = options.currentUser ?? (async (request: Request) => getSession(db, request.headers.get("cookie")?.match(/mars_session=([^;]+)/)?.[1]));
  const commandStore = {
    async save(command: WorkerCommand): Promise<void> {
      await db`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${command.id},${command.version},${command.type},${command.workerId},${command.leaseId},${command.occurredAt},${jsonParameter(db, command.payload)}) on conflict (id) do nothing`;
    },
    async listUnacknowledged(workerId: string): Promise<WorkerCommand[]> {
      const rows = await db`select c.id,c.version,c.type,c.worker_id as "workerId",c.lease_id as "leaseId",c.occurred_at as "occurredAt",c.payload from commands c left join runner_leases l on l.id=c.lease_id where c.worker_id=${workerId} and c.state in ('pending','sent') and (c.lease_id is null or l.state not in ('failed','reaped')) order by c.occurred_at asc,c.id asc`;
      return rows.map(row => WorkerCommandSchema.parse({ ...row, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload, occurredAt: normalizeTimestamp(row.occurredAt) }));
    },
    async markSent(commandId: string): Promise<void> { await db`update commands set state='sent' where id=${commandId} and state='pending'`; },
    async acknowledge(commandId: string): Promise<void> { await db`update commands set state='acknowledged' where id=${commandId} and state in ('pending','sent')`; },
  };
  const dispatcher = options.dispatcher ?? new WorkerCommandDispatcher(15_000, commandStore);
  const requestSources = new WeakMap<Request, string>();
  const startedAt = new Date().toISOString();
  const discoveryIntervalMs = Number(Bun.env.DISCOVERY_INTERVAL_MS ?? 30_000);
  const reconciliationIntervalMs = Number(Bun.env.JOB_RECONCILIATION_INTERVAL_MS ?? 5_000);
  const discoveryHealth = new DiscoveryHealthMonitor(discoveryIntervalMs, Date.parse(startedAt));
  const githubApp = options.githubApp ?? new GitHubAppService({ db, secretBox, publicOrigin: initialized.setup.publicOrigin, webhookOrigin: () => configuredWebhookOrigin });
  const githubRateLimits = new GithubRateLimitGate();
  let triggerReconciliation = () => Promise.resolve();
  const httpApp = createControlPlaneApp({ db, setup: initialized.setup, browserOrigin: () => Bun.env.NODE_ENV !== "production" ? (Bun.env.BROWSER_BASE_URL?.trim() || initialized.setup.publicOrigin()) : initialized.setup.publicOrigin(), workerConnectionOrigins, secretBox, githubApp, defaultJobImages: env.DEFAULT_IMAGES, workerReleaseManifest, templateManifestPaths: env.TEMPLATE_MANIFESTS, templateArtifactPaths: env.TEMPLATE_ARTIFACTS, workerTemplatePaths: env.WORKER_TEMPLATE_PATHS, workerTemplateDigests: env.WORKER_TEMPLATE_DIGESTS, macosTartBaseImage: env.MACOS_TART_BASE_IMAGE, currentUser: current, requestId: () => crypto.randomUUID(), requestSource: request => requestSources.get(request) ?? "unknown", webRoot, workerInstallerRoot, workerOrchestratorExecutables, workerServiceHostExecutable, workerRequestLimiter: createRequestLimiter(), workerDispatcher: dispatcher, workerConnected: workerId => dispatcher.isConnected(workerId), onWorkerAdopted: workerId => void dispatcher.replayConnected(workerId), health: () => ({ buildId: Bun.env.MARS_BUILD_ID ?? "dev", startedAt, discovery: discoveryHealth.snapshot() }) });
  let server!: Server<ControlPlaneSocketData>;
  const gateway = createControlPlaneGateway({ db, httpFetch: async request => await httpApp.fetch(request), current, requestSource: (request, activeServer) => { requestSources.set(request, activeServer.requestIP(request)?.address ?? "unknown"); return requestSources.get(request) ?? "unknown"; }, dispatcher, triggerReconciliation: () => triggerReconciliation(), requestId: () => crypto.randomUUID() });
  server = Bun.serve<ControlPlaneSocketData>({ port: options.port ?? Number(Bun.env.PORT ?? 3000), websocket: gateway.websocket, fetch: request => gateway.fetch(request, server) });
  console.log(`Mars control plane listening on ${server.url}`);
  if (!options.skipBackgroundTasks) {
    const discoveryDeps = { db, installationToken: (installationId: number) => githubApp.getInstallationToken(installationId), githubFetchForInstallation: (installationId: number) => githubRateLimits.scopedFetch(installationId), repositoryFullName: Bun.env.JOB_DISCOVERY_REPOSITORY };
    let lastQueuedDiscoveryAt = 0;
    let lastGithubLeaseReconciliationAt = 0;
    startReconciliationScheduler(async () => {
      discoveryHealth.markAttempt();
      try {
        const report = await discoverAvailableRepositoryJobs(discoveryDeps);
        if (isDiscoveryCycleSuccessful(report)) discoveryHealth.markSuccess();
        if (report.discovered || report.failed) console.log(`GitHub job discovery: repositories=${report.repositories} discovered=${report.discovered} updated=${report.updated} failed=${report.failed}`);
      } catch (error) { console.error("GitHub job discovery failed", error); }
    }, discoveryIntervalMs);
    const reconciliationScheduler = startReconciliationScheduler(async () => {
      try {
        if (Date.now() - lastQueuedDiscoveryAt >= Number(Bun.env.JOB_QUEUED_DISCOVERY_INTERVAL_MS ?? 30_000)) { lastQueuedDiscoveryAt = Date.now(); const pickup = await discoverQueuedRepositoryJobs(discoveryDeps); if (pickup.discovered || pickup.failed) console.log(`Queued GitHub job pickup: repositories=${pickup.repositories} discovered=${pickup.discovered} updated=${pickup.updated} failed=${pickup.failed}`); }
        if (Date.now() - lastGithubLeaseReconciliationAt >= 60_000) { lastGithubLeaseReconciliationAt = Date.now(); const staleLeaseReport = await reconcileExpiredLeasesWithGithub({ db, installationToken: installationId => githubApp.getInstallationToken(installationId), githubFetchForInstallation: installationId => githubRateLimits.scopedFetch(installationId) }); if (staleLeaseReport.completed || staleLeaseReport.released || staleLeaseReport.skipped) console.log(`GitHub stale lease reconciliation: inspected=${staleLeaseReport.inspected} completed=${staleLeaseReport.completed} released=${staleLeaseReport.released} stillActive=${staleLeaseReport.stillActive} skipped=${staleLeaseReport.skipped}`); }
        const report = await runQueuedJobReconciliation({ db, installationToken: installationId => githubApp.getInstallationToken(installationId), githubFetchForInstallation: installationId => githubRateLimits.scopedFetch(installationId), dispatcher, installationBlocked: installationId => githubRateLimits.isCoolingDown(installationId), workerConnected: workerId => dispatcher.isConnected(workerId), repositoryFullName: Bun.env.JOB_DISCOVERY_REPOSITORY });
        console.log(`Job reconciliation tick: reserved=${report.reserved} failed=${report.failed} skipped=${report.skipped}`);
      } catch (error) { console.error("Job reconciliation failed", error); } finally {
        try { const cleanup = await reapPendingLeases({ db, dispatch: dispatcher.dispatch.bind(dispatcher), workerConnected: workerId => dispatcher.isConnected(workerId) }); if (cleanup.dispatched || cleanup.failed) console.log(`Lease cleanup tick: dispatched=${cleanup.dispatched} failed=${cleanup.failed} skipped=${cleanup.skipped}`); await completeOnboardingIfReady(db); } catch (error) { console.error("Lease cleanup failed", error); }
      }
    }, reconciliationIntervalMs);
    triggerReconciliation = reconciliationScheduler.trigger;
    const runRetention = async () => { try { console.log("Retention pruner", await pruneExpiredData(db)); } catch (error) { console.error("Retention pruning failed", error); } };
    void runRetention();
    setInterval(() => { void runRetention(); }, 24 * 60 * 60 * 1_000);
    setInterval(() => { for (const socket of gateway.browserSockets) void gateway.replayBrowserInvalidations(socket); }, 1_000);
  }
  return { server, gateway, httpApp, db, setup: initialized.setup };
}

if (import.meta.main) await startControlPlane();
