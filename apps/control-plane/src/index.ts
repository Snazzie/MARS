import { processPipelineFailureAnalyses } from "./pipeline-failure-analysis.ts";
import { processPrReviews } from "./pr-review.ts";
import { LlmProvidersService, generatePrReview, type LlmProviderConfig } from "./llm-providers.ts";
import { and, asc, eq, ne, inArray, sql } from "drizzle-orm";
import { defineQueries, schema, completeOnboardingIfReady, createDb, ensureDatabase, migrateDatabase, type DashboardDb } from "@mars/db";
import { CURRENT_WORKER_CONTRACT_VERSION, WorkerReleaseOciDigest, sanitizeDiagnosticText, type WorkerBuildImagePayload, type WorkerCommand, type WorkerReleaseManifest } from "@mars/contracts";
import type { Server } from "bun";
import { getSession, SecretBox, type SessionUser } from "./auth.ts";
import { configureRunLifecycle } from "./runs.ts";
import { discoverAvailableRepositoryJobs, discoverQueuedRepositoryJobs } from "./job-discovery.ts";
import { retryFailedGithubJobs } from "./job-retry.ts";
import { WorkerCommandDispatcher, listReplayableWorkerCommands } from "./worker-dispatch.ts";
import { createRequestLimiter } from "./worker-requests.ts";
import { GitHubAppService } from "./github-app.ts";
import { runQueuedJobReconciliation } from "./job-reconciler.ts";
import type { ReconcileReport } from "./reconcile.ts";
import { reconcileExpiredLeasesWithGithub } from "./lease-reconciliation.ts";
import { reapPendingLeases } from "./lease-cleanup.ts";
import { cleanGithubRunners } from "./github-runner-cleanup.ts";
import { startImmediateCron, startReconciliationScheduler } from "./reconcile-loop.ts";
import { pruneExpiredData } from "./retention.ts";
import { DiscoveryHealthMonitor, isDiscoveryCycleSuccessful } from "./discovery-health.ts";
import { DispatchHealthMonitor, type DispatchDecision } from "./dispatch-health.ts";
import { createControlPlaneApp } from "./http/app.ts";
import type { ControlPlaneHttpDeps, ControlPlaneLogLevel, ControlPlaneLogSource, DevelopmentArtifact, DevelopmentLinuxArtifacts, DevelopmentLinuxArm64Artifacts, DevelopmentMacosArtifacts, DevelopmentWindowsArtifacts } from "./http/types.ts";
import type { ControlPlaneSetup } from "./control-plane-setup.ts";
import { ensureDefaultPools } from "./default-pools.ts";
import { GithubRateLimitGate } from "./github-rate-limit.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initializeControlPlaneSetup } from "./control-plane-setup.ts";
import { httpOrigin, publicHttpOrigin } from "./http-origin.ts";
import { loadWorkerReleaseManifest, WorkerReleaseCatalog } from "./worker-release.ts";
import { WorkerUpgradeService } from "./worker-upgrade.ts";
import { createControlPlaneGateway, type ControlPlaneSocketData } from "./control-plane-gateway.ts";
const startupQueries = defineQueries(db => ({
  developmentAdmin: db.select({ id: schema.users.id, githubUserId: schema.users.githubUserId, login: schema.users.login, isGlobalAdmin: schema.users.isGlobalAdmin }).from(schema.users).where(eq(schema.users.isGlobalAdmin, true)).orderBy(asc(schema.users.createdAt)).limit(1).prepare("control_plane_development_admin"),
  saveCommand: db.insert(schema.commands).values({ id: sql.placeholder("id"), version: sql.placeholder("version"), type: sql.placeholder("type"), workerId: sql.placeholder("workerId"), leaseId: sql.placeholder("leaseId"), occurredAt: sql.placeholder("occurredAt"), payload: sql.placeholder("payload") }).onConflictDoNothing({ target: schema.commands.id }).prepare("control_plane_save_command"),
  markCommandSent: db.update(schema.commands).set({ state: "sent" }).where(and(eq(schema.commands.id, sql.placeholder("id")), eq(schema.commands.state, "pending"))).prepare("control_plane_command_sent"),
  acknowledgeCommand: db.update(schema.commands).set({ state: "acknowledged" }).where(and(eq(schema.commands.id, sql.placeholder("id")), inArray(schema.commands.state, ["pending", "sent"]))).prepare("control_plane_command_acknowledged"),
  offlineWorkers: db.update(schema.workers).set({ connectionState: "offline" }).where(ne(schema.workers.connectionState, "offline")).prepare("control_plane_workers_offline"),
  llmList: db.select().from(schema.llmProviders).orderBy(asc(schema.llmProviders.name)).prepare("control_plane_llm_list"),
  llmGet: db.select().from(schema.llmProviders).where(eq(schema.llmProviders.id, sql.placeholder("id"))).prepare("control_plane_llm_get"),
  llmInsert: db.insert(schema.llmProviders).values({ name: sql.placeholder("name"), kind: sql.placeholder("kind"), baseUrl: sql.placeholder("baseUrl"), model: sql.placeholder("model"), inputUsdPerMillionTokens: sql.placeholder("inputUsdPerMillionTokens"), outputUsdPerMillionTokens: sql.placeholder("outputUsdPerMillionTokens"), encryptedApiKey: sql.placeholder("encryptedApiKey") }).returning().prepare("control_plane_llm_insert"),
  llmUpdate: db.update(schema.llmProviders).set({ name: sql`${sql.placeholder("name")}`, kind: sql`${sql.placeholder("kind")}`, baseUrl: sql`${sql.placeholder("baseUrl")}`, model: sql`${sql.placeholder("model")}`, inputUsdPerMillionTokens: sql`${sql.placeholder("inputUsdPerMillionTokens")}`, outputUsdPerMillionTokens: sql`${sql.placeholder("outputUsdPerMillionTokens")}`, encryptedApiKey: sql`${sql.placeholder("encryptedApiKey")}`, updatedAt: sql`now()` }).where(eq(schema.llmProviders.id, sql.placeholder("id"))).returning().prepare("control_plane_llm_update"),
  llmDelete: db.delete(schema.llmProviders).where(eq(schema.llmProviders.id, sql.placeholder("id"))).returning({ id: schema.llmProviders.id }).prepare("control_plane_llm_delete"),
  llmUseCount: db.select({ count: sql<number>`count(*)::int + (SELECT count(*)::int FROM ${schema.globalFailureAnalysisSettings} WHERE ${schema.globalFailureAnalysisSettings.providerId}=${sql.placeholder("id")}) + (SELECT count(*)::int FROM ${schema.repositoryPrReviewSettings} WHERE ${schema.repositoryPrReviewSettings.providerId}=${sql.placeholder("id")})` }).from(schema.repositoryFailureAnalysisSettings).where(eq(schema.repositoryFailureAnalysisSettings.providerId, sql.placeholder("id"))).prepare("control_plane_llm_use_count"),
  githubAppId: db.select({ appId: schema.githubAppConfig.appId, slug: schema.githubAppConfig.slug }).from(schema.githubAppConfig).where(eq(schema.githubAppConfig.singleton, true)).prepare("control_plane_github_app_id"),
}));

export function formatJobReconciliationReport(report: ReconcileReport): string | undefined {
  if (report.reserved === 0 && report.failed === 0) return undefined;
  return `Job reconciliation tick: reserved=${report.reserved} deferred=${report.deferred} failed=${report.failed} skipped=${report.skipped}`;
}

type ConsoleMethod = (...args: unknown[]) => void;

const timestampedConsoleMethod = (original: ConsoleMethod): ConsoleMethod => (...args) => {
  const timestamp = new Date().toISOString();
  const [first, ...remaining] = args;
  if (typeof first === "string") original(`[${timestamp}] ${first}`, ...remaining);
  else if (args.length === 0) original(`[${timestamp}] `);
  else original(`[${timestamp}]`, first, ...remaining);
};

export function configureTimestampedConsoleLogging(): () => void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = timestampedConsoleMethod(originalLog.bind(console));
  console.warn = timestampedConsoleMethod(originalWarn.bind(console));
  console.error = timestampedConsoleMethod(originalError.bind(console));
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

export function configureErrorFileLogging(dataRoot: string): string {
  const logDirectory = `${dataRoot.replace(/[\\/]+$/, "")}/logs`;
  mkdirSync(logDirectory, { recursive: true });
  const logPath = `${logDirectory}/control-plane-error.log`;
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args);
    try {
      const message = args.map(value => value instanceof Error ? value.stack ?? value.message : typeof value === "string" ? value : JSON.stringify(value)).join(" ");
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
    } catch {
      // Logging must not hide the original control-plane error.
    }
  };
  return logPath;
}
export function configureControlPlaneLogBuffer(capacity = 2_000): { source: ControlPlaneLogSource; restore(): void } {
  const entries: Array<{ sequence: number; occurredAt: string; level: ControlPlaneLogLevel; message: string }> = [];
  let sequence = 0;
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const serialize = (value: unknown): string => {
    if (value instanceof Error) return value.stack ?? value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      originals[level](...args);
      entries.push({
        sequence: sequence += 1,
        occurredAt: new Date().toISOString(),
        level,
        message: sanitizeDiagnosticText(args.map(serialize).join(" "), 128 * 1024),
      });
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    };
  }
  return {
    source: {
      list(input) {
        const contains = input.contains?.toLocaleLowerCase();
        const matching = entries.filter(entry =>
          (input.after === undefined || entry.sequence > input.after)
          && (input.level === undefined || entry.level === input.level)
          && (contains === undefined || entry.message.toLocaleLowerCase().includes(contains))
        );
        const items = input.after === undefined ? matching.slice(-input.limit) : matching.slice(0, input.limit);
        return { items, nextCursor: items.at(-1)?.sequence ?? null };
      },
    },
    restore() {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}
type DevelopmentEnvironment = Readonly<Record<string, string | undefined>>;

const trimmedEnvironmentValue = (environment: DevelopmentEnvironment, names: string[]): string | undefined => {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

const developmentArtifactUrl = (value: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return true;
};

const normalizeDevelopmentFilesystemPath = (value: string): string => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "file:" ? fileURLToPath(parsed) : value;
  } catch {
    // Raw drive-letter and UNC paths are filesystem paths, not URLs.
    return value;
  }
};

const developmentArtifact = (
  environment: DevelopmentEnvironment,
  paths: string[],
  urls: string[],
  hashes: string[],
): DevelopmentArtifact | undefined => {
  const configuredPath = trimmedEnvironmentValue(environment, paths);
  const path = configuredPath ? normalizeDevelopmentFilesystemPath(configuredPath) : undefined;
  const url = trimmedEnvironmentValue(environment, urls);
  const sha256 = trimmedEnvironmentValue(environment, hashes)?.replace(/^sha256:/, "");
  if ((url && !developmentArtifactUrl(url)) || (!path && !url) || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return { ...(path ? { path } : {}), ...(url ? { url } : {}), sha256 };
};

export function createDevelopmentWindowsArtifacts(environment: DevelopmentEnvironment = Bun.env): DevelopmentWindowsArtifacts | undefined {
  if (environment.NODE_ENV === "production") return undefined;
  const orchestrator = developmentArtifact(environment, ["MARS_WINDOWS_ORCHESTRATOR_PATH", "WORKER_ORCHESTRATOR_WINDOWS_X64"], ["MARS_WINDOWS_ORCHESTRATOR_URL"], ["MARS_WINDOWS_ORCHESTRATOR_SHA256", "WORKER_ORCHESTRATOR_WINDOWS_X64_SHA256"]);
  const serviceHost = developmentArtifact(environment, ["MARS_WINDOWS_SERVICE_HOST_PATH", "WORKER_SERVICE_HOST_EXECUTABLE"], ["MARS_WINDOWS_SERVICE_HOST_URL"], ["MARS_WINDOWS_SERVICE_HOST_SHA256", "WORKER_SERVICE_HOST_SHA256"]);
  const jobAgent = developmentArtifact(environment, ["MARS_WINDOWS_JOB_AGENT_PATH"], ["MARS_WINDOWS_JOB_AGENT_URL"], ["MARS_WINDOWS_JOB_AGENT_SHA256"]);
  const checkpoint = developmentArtifact(environment, ["MARS_WINDOWS_CHECKPOINT_PATH"], ["MARS_WINDOWS_CHECKPOINT_URL"], ["MARS_WINDOWS_CHECKPOINT_SHA256", "MARS_WINDOWS_CHECKPOINT_DIGEST"]);
  const provisioner = developmentArtifact(environment, ["MARS_WINDOWS_VM_PROVISIONER_PATH"], ["MARS_WINDOWS_VM_PROVISIONER_URL"], ["MARS_WINDOWS_VM_PROVISIONER_SHA256"]);
  const trayScript = developmentArtifact(environment, ["MARS_WINDOWS_TRAY_SCRIPT_PATH"], ["MARS_WINDOWS_TRAY_SCRIPT_URL"], ["MARS_WINDOWS_TRAY_SCRIPT_SHA256"]);
  const runner = developmentArtifact(environment, ["MARS_WINDOWS_RUNNER_PATH"], ["MARS_WINDOWS_RUNNER_URL"], ["MARS_WINDOWS_RUNNER_SHA256"]);
  const git = developmentArtifact(environment, ["MARS_WINDOWS_GIT_PATH"], ["MARS_WINDOWS_GIT_URL"], ["MARS_WINDOWS_GIT_SHA256"]);
  const vcRuntime = developmentArtifact(environment, ["MARS_WINDOWS_VC_RUNTIME_PATH"], ["MARS_WINDOWS_VC_RUNTIME_URL"], ["MARS_WINDOWS_VC_RUNTIME_SHA256"]);
  const baseImage = trimmedEnvironmentValue(environment, ["MARS_WINDOWS_CONTAINER_BASE_IMAGE"]);
  if (!orchestrator || !serviceHost) return undefined;
  const container = baseImage ? { baseImage } : undefined;
  const vm = checkpoint || provisioner ? { ...(checkpoint ? { checkpoint } : {}), ...(provisioner ? { provisioner } : {}) } : undefined;
  return { orchestrator, serviceHost, ...(jobAgent ? { jobAgent } : {}), ...(runner ? { runner } : {}), ...(git ? { git } : {}), ...(vcRuntime ? { vcRuntime } : {}), ...(trayScript ? { trayScript } : {}), ...(vm ? { vm } : {}), ...(container ? { container } : {}) };
}
const developmentDefaultArtifactPaths = {
  windowsOrchestrator: "../../../apps/orchestrator/dist/mars-orchestrator.exe",
  windowsServiceHost: "../../../apps/windows-service-host/target/release/mars-service-host.exe",
  windowsJobAgent: "../../../apps/job-agent/dist/mars-job-agent.exe",
  windowsContainerBuilder: "../../../deploy/workers/build-windows-container-image-local.ps1",
  windowsContainerVerifier: "../../../images/jobs/windows/verify-runtime.ps1",
  windowsContainerfile: "../../../images/jobs/windows/Containerfile",
  windowsTrayScript: "../../../deploy/workers/mars-worker-tray.ps1",
  windowsContainerEntrypoint: "../../../images/jobs/windows/entrypoint.ps1",
  linuxCompose: "../../../deploy/workers/linux-broker-compose.yaml",
  linuxArm64Compose: "../../../deploy/workers/linux-arm64-broker-compose.yaml",
  linuxDomainTemplate: "../../../deploy/workers/worker-domain.xml",
  macosOrchestrator: "../../../apps/orchestrator/dist/mars-orchestrator-macos-arm64",
} as const;

const localArtifactSha256 = async (path: string): Promise<string | undefined> => {
  const file = Bun.file(path);
  if (!await file.exists()) return undefined;
  return createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
};

const resolveDevelopmentArtifact = async (
  environment: DevelopmentEnvironment,
  paths: string[],
  urls: string[],
  hashes: string[],
  fallbackPath?: string,
): Promise<DevelopmentArtifact | undefined> => {
  const configuredPath = trimmedEnvironmentValue(environment, paths);
  const url = trimmedEnvironmentValue(environment, urls);
  const candidatePath = configuredPath
    ? normalizeDevelopmentFilesystemPath(configuredPath)
    : !url && fallbackPath ? fileURLToPath(new URL(fallbackPath, import.meta.url)) : undefined;
  const path = candidatePath && await Bun.file(candidatePath).exists() ? candidatePath : undefined;
  const configuredHash = trimmedEnvironmentValue(environment, hashes)?.replace(/^sha256:/, "");
  const sha256 = path ? await localArtifactSha256(path) : configuredHash;
  if ((url && !developmentArtifactUrl(url)) || (!path && !url) || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return { ...(path ? { path } : {}), ...(url ? { url } : {}), sha256 };
};
 
export async function resolveDevelopmentWindowsArtifacts(environment: DevelopmentEnvironment = Bun.env): Promise<DevelopmentWindowsArtifacts | undefined> {
  if (environment.NODE_ENV === "production") return undefined;
  const [orchestrator, serviceHost, jobAgent, trayScript, checkpoint, provisioner, runner, git, vcRuntime, buildScript, verifyScript, containerfile, entrypoint] = await Promise.all([
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_ORCHESTRATOR_PATH", "WORKER_ORCHESTRATOR_WINDOWS_X64"], ["MARS_WINDOWS_ORCHESTRATOR_URL"], ["MARS_WINDOWS_ORCHESTRATOR_SHA256", "WORKER_ORCHESTRATOR_WINDOWS_X64_SHA256"], developmentDefaultArtifactPaths.windowsOrchestrator),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_SERVICE_HOST_PATH", "WORKER_SERVICE_HOST_EXECUTABLE"], ["MARS_WINDOWS_SERVICE_HOST_URL"], ["MARS_WINDOWS_SERVICE_HOST_SHA256", "WORKER_SERVICE_HOST_SHA256"], developmentDefaultArtifactPaths.windowsServiceHost),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_JOB_AGENT_PATH"], ["MARS_WINDOWS_JOB_AGENT_URL"], ["MARS_WINDOWS_JOB_AGENT_SHA256"], developmentDefaultArtifactPaths.windowsJobAgent),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_TRAY_SCRIPT_PATH"], ["MARS_WINDOWS_TRAY_SCRIPT_URL"], ["MARS_WINDOWS_TRAY_SCRIPT_SHA256"], developmentDefaultArtifactPaths.windowsTrayScript),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_CHECKPOINT_PATH"], ["MARS_WINDOWS_CHECKPOINT_URL"], ["MARS_WINDOWS_CHECKPOINT_SHA256", "MARS_WINDOWS_CHECKPOINT_DIGEST"]),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_VM_PROVISIONER_PATH"], ["MARS_WINDOWS_VM_PROVISIONER_URL"], ["MARS_WINDOWS_VM_PROVISIONER_SHA256"]),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_RUNNER_PATH"], ["MARS_WINDOWS_RUNNER_URL"], ["MARS_WINDOWS_RUNNER_SHA256"]),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_GIT_PATH"], ["MARS_WINDOWS_GIT_URL"], ["MARS_WINDOWS_GIT_SHA256"]),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_VC_RUNTIME_PATH"], ["MARS_WINDOWS_VC_RUNTIME_URL"], ["MARS_WINDOWS_VC_RUNTIME_SHA256"]),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_CONTAINER_BUILDER_PATH"], ["MARS_WINDOWS_CONTAINER_BUILDER_URL"], ["MARS_WINDOWS_CONTAINER_BUILDER_SHA256"], developmentDefaultArtifactPaths.windowsContainerBuilder),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_CONTAINER_VERIFIER_PATH"], ["MARS_WINDOWS_CONTAINER_VERIFIER_URL"], ["MARS_WINDOWS_CONTAINER_VERIFIER_SHA256"], developmentDefaultArtifactPaths.windowsContainerVerifier),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_CONTAINERFILE_PATH"], ["MARS_WINDOWS_CONTAINERFILE_URL"], ["MARS_WINDOWS_CONTAINERFILE_SHA256"], developmentDefaultArtifactPaths.windowsContainerfile),
    resolveDevelopmentArtifact(environment, ["MARS_WINDOWS_CONTAINER_ENTRYPOINT_PATH"], ["MARS_WINDOWS_CONTAINER_ENTRYPOINT_URL"], ["MARS_WINDOWS_CONTAINER_ENTRYPOINT_SHA256"], developmentDefaultArtifactPaths.windowsContainerEntrypoint),
  ]);
  const baseImage = trimmedEnvironmentValue(environment, ["MARS_WINDOWS_CONTAINER_BASE_IMAGE"]);
  if (!orchestrator || !serviceHost) return undefined;
  const container = baseImage ? { baseImage, ...(buildScript ? { buildScript } : {}), ...(verifyScript ? { verifyScript } : {}), ...(containerfile ? { containerfile } : {}), ...(entrypoint ? { entrypoint } : {}) } : undefined;
  const vm = checkpoint || provisioner ? { ...(checkpoint ? { checkpoint } : {}), ...(provisioner ? { provisioner } : {}) } : undefined;
  return { orchestrator, serviceHost, ...(jobAgent ? { jobAgent } : {}), ...(runner ? { runner } : {}), ...(git ? { git } : {}), ...(vcRuntime ? { vcRuntime } : {}), ...(trayScript ? { trayScript } : {}), ...(vm ? { vm } : {}), ...(container ? { container } : {}) };
}

export async function resolveDevelopmentLinuxArtifacts(environment: DevelopmentEnvironment = Bun.env): Promise<DevelopmentLinuxArtifacts | undefined> {
  if (environment.NODE_ENV === "production") return undefined;
  const [goldenImage, compose, domainTemplate] = await Promise.all([
    resolveDevelopmentArtifact(environment, ["MARS_LINUX_GOLDEN_IMAGE_PATH", "MARS_LINUX_GOLDEN_PATH"], ["MARS_LINUX_GOLDEN_IMAGE_URL"], ["MARS_LINUX_GOLDEN_IMAGE_SHA256"]),
    resolveDevelopmentArtifact(environment, ["MARS_LINUX_COMPOSE_PATH"], ["MARS_LINUX_COMPOSE_URL"], ["MARS_LINUX_COMPOSE_SHA256"], developmentDefaultArtifactPaths.linuxCompose),
    resolveDevelopmentArtifact(environment, ["MARS_LINUX_DOMAIN_TEMPLATE_PATH"], ["MARS_LINUX_DOMAIN_TEMPLATE_URL"], ["MARS_LINUX_DOMAIN_TEMPLATE_SHA256"], developmentDefaultArtifactPaths.linuxDomainTemplate),
  ]);
  const brokerImage = trimmedEnvironmentValue(environment, ["MARS_LINUX_BROKER_IMAGE", "MARS_BROKER_IMAGE"]);
  if (!brokerImage && !goldenImage && !compose && !domainTemplate) return undefined;
  return { ...(brokerImage ? { brokerImage } : {}), ...(goldenImage ? { goldenImage } : {}), ...(compose ? { compose } : {}), ...(domainTemplate ? { domainTemplate } : {}) };
}
export async function resolveDevelopmentLinuxArm64Artifacts(environment: DevelopmentEnvironment = Bun.env): Promise<DevelopmentLinuxArm64Artifacts | undefined> {
  if (environment.NODE_ENV === "production") return undefined;
  const compose = await resolveDevelopmentArtifact(environment, ["MARS_LINUX_ARM64_COMPOSE_PATH"], ["MARS_LINUX_ARM64_COMPOSE_URL"], ["MARS_LINUX_ARM64_COMPOSE_SHA256"], developmentDefaultArtifactPaths.linuxArm64Compose);
  const brokerImage = trimmedEnvironmentValue(environment, ["MARS_LINUX_ARM64_BROKER_IMAGE"]);
  const jobImage = trimmedEnvironmentValue(environment, ["MARS_LINUX_ARM64_JOB_IMAGE"]);
  if (!brokerImage && !jobImage && !compose) return undefined;
  return { ...(brokerImage ? { brokerImage } : {}), ...(jobImage ? { jobImage } : {}), ...(compose ? { compose } : {}) };
}

const developmentDigest = (environment: DevelopmentEnvironment, names: string[]): string | undefined => {
  const match = trimmedEnvironmentValue(environment, names)?.match(/^(?:[^@\s]+@sha256:|sha256:)?([0-9a-f]{64})$/);
  return match?.[1];
};
export async function resolveDevelopmentMacosArtifacts(environment: DevelopmentEnvironment = Bun.env): Promise<DevelopmentMacosArtifacts | undefined> {
  if (environment.NODE_ENV === "production") return undefined;
  const [orchestrator, jobAgent, imagePreparationScript] = await Promise.all([
    resolveDevelopmentArtifact(environment, ["MARS_MACOS_ORCHESTRATOR_PATH", "WORKER_ORCHESTRATOR_MACOS_ARM64"], ["MARS_MACOS_ORCHESTRATOR_URL"], ["MARS_MACOS_ORCHESTRATOR_SHA256", "WORKER_ORCHESTRATOR_MACOS_ARM64_SHA256"], developmentDefaultArtifactPaths.macosOrchestrator),
    resolveDevelopmentArtifact(environment, ["MARS_MACOS_JOB_AGENT_PATH"], ["MARS_MACOS_JOB_AGENT_URL"], ["MARS_MACOS_JOB_AGENT_SHA256"]),
    resolveDevelopmentArtifact(environment, ["MARS_MACOS_IMAGE_PREPARATION_PATH"], ["MARS_MACOS_IMAGE_PREPARATION_URL"], ["MARS_MACOS_IMAGE_PREPARATION_SHA256"]),
  ]);
  const tartImage = trimmedEnvironmentValue(environment, ["MARS_TART_BASE_IMAGE", "MARS_TART_IMAGE"]);
  const tartImageDigest = developmentDigest(environment, ["MARS_TART_IMAGE_DIGEST", "MARS_TART_BASE_IMAGE_DIGEST"]);
  if (!orchestrator && !jobAgent && !imagePreparationScript && !tartImage && !tartImageDigest) return undefined;
  // A development installer must be as complete and immutable as a released
  // one. Partial local configuration is deliberately surfaced as unavailable.
  if (!tartImage || !WorkerReleaseOciDigest.safeParse(tartImage).success) return undefined;
  const sourceDigest = tartImage.split("@sha256:")[1];
  if (!orchestrator || !jobAgent || !imagePreparationScript || !tartImageDigest || !sourceDigest || tartImageDigest !== sourceDigest) return undefined;
  return { orchestrator, jobAgent, imagePreparationScript, tartImage, tartImageDigest };
}


const windowsContainerBaseImagePattern = /^mcr\.microsoft\.com\/windows\/server:ltsc2025@sha256:[0-9a-f]{64}$/;

export function createDevelopmentWindowsContainerBuild(input: {
  publicOrigin: string | null;
  artifacts?: Pick<DevelopmentWindowsArtifacts, "container" | "runner" | "git" | "vcRuntime">;
  buildArtifacts?: NonNullable<ControlPlaneHttpDeps["windowsContainerArtifacts"]>;
}): NonNullable<ControlPlaneHttpDeps["windowsContainerBuild"]> | undefined {
  const container = input.artifacts?.container;
  const runner = input.artifacts?.runner;
  const git = input.artifacts?.git;
  const vcRuntime = input.artifacts?.vcRuntime;
  const buildArtifacts = input.buildArtifacts;
  if (!input.publicOrigin || !container || !runner || !git || !vcRuntime || !buildArtifacts || !windowsContainerBaseImagePattern.test(container.baseImage)) return undefined;
  return {
    baseImage: container.baseImage,
    runnerUrl: new URL("/api/workers/windows-runner", input.publicOrigin).toString(),
    runnerSha256: runner.sha256,
    gitUrl: new URL("/api/workers/windows-git", input.publicOrigin).toString(),
    gitSha256: git.sha256,
    vcUrl: new URL("/api/workers/windows-vc-runtime", input.publicOrigin).toString(),
    vcSha256: vcRuntime.sha256,
    builderPath: normalizeDevelopmentFilesystemPath(buildArtifacts.builderPath),
    verifierPath: normalizeDevelopmentFilesystemPath(buildArtifacts.verifierPath),
    containerfilePath: normalizeDevelopmentFilesystemPath(buildArtifacts.containerfilePath),
    entrypointPath: normalizeDevelopmentFilesystemPath(buildArtifacts.entrypointPath),
    jobAgentPath: normalizeDevelopmentFilesystemPath(buildArtifacts.jobAgentPath),
  };
}

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
  controlPlaneLogs?: ControlPlaneLogSource;
  webRoot?: URL;
  workerInstallerRoot?: URL;
  workerJoin?: ControlPlaneHttpDeps["workerJoin"];
  devWindowsImageBuild?: (build: ControlPlaneHttpDeps["windowsContainerBuild"], publicOrigin: string | null) => Promise<WorkerBuildImagePayload | null>;
  disableWorkerBootstrapManagement?: boolean;
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

export function controlPlaneBuildId(value = Bun.env.MARS_BUILD_ID): string {
  return value?.trim() || "unknown";
}

export async function resolveWorkerReleaseManifest(
  production: boolean,
  source?: string,
  provided?: WorkerReleaseManifest,
  loader: typeof loadWorkerReleaseManifest = loadWorkerReleaseManifest,
): Promise<WorkerReleaseManifest | undefined> {
  if (provided) return provided;
  if (!production) return undefined;
  return await loader(source);
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
  const webRoot = options.webRoot ?? new URL(Bun.env.WEB_ROOT ?? "../../web/dist/", import.meta.url);
  // Production never resolves worker binaries from the application image.
  const workerInstallerRoot = options.workerInstallerRoot ?? new URL(production ? "file:///var/empty/" : Bun.env.WORKER_INSTALLER_ROOT ?? "../../../deploy/workers/", import.meta.url);
  const [developmentWindowsArtifacts, developmentLinuxArtifacts, developmentLinuxArm64Artifacts, developmentMacosArtifacts] = await Promise.all([
    resolveDevelopmentWindowsArtifacts(Bun.env),
    resolveDevelopmentLinuxArtifacts(Bun.env),
    resolveDevelopmentLinuxArm64Artifacts(Bun.env),
    resolveDevelopmentMacosArtifacts(Bun.env),
  ]);
  const developmentContainer = developmentWindowsArtifacts?.container;
  const developmentJobAgentPath = developmentWindowsArtifacts?.jobAgent?.path;
  const windowsContainerArtifacts = developmentContainer?.buildScript?.path
    && developmentContainer.verifyScript?.path
    && developmentContainer.containerfile?.path
    && developmentContainer.entrypoint?.path
    && developmentJobAgentPath
    ? {
      builderPath: developmentContainer.buildScript.path,
      verifierPath: developmentContainer.verifyScript.path,
      containerfilePath: developmentContainer.containerfile.path,
      entrypointPath: developmentContainer.entrypoint.path,
      jobAgentPath: developmentJobAgentPath,
    }
    : undefined;
  const workerReleaseContractVersion = Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() || (!production ? CURRENT_WORKER_CONTRACT_VERSION : undefined);
  const workerReleaseManifestUrl = Bun.env.MARS_WORKER_RELEASE_MANIFEST_URL?.trim();
  if (production && !workerReleaseContractVersion) throw new Error("MARS_WORKER_CONTRACT_VERSION is required");
  const workerReleaseCatalog = new WorkerReleaseCatalog({ controlPlaneContractVersion: workerReleaseContractVersion });
  const workerReleaseManifest = await resolveWorkerReleaseManifest(production, workerReleaseManifestUrl, options.workerReleaseManifest);
  const ubuntuVersion = Bun.env.DEFAULT_JOB_UBUNTU_VERSION?.trim() || "24";
  if (!["22", "24", "26"].includes(ubuntuVersion)) throw new Error("DEFAULT_JOB_UBUNTU_VERSION must be 22, 24, or 26");
  if (ubuntuVersion !== "24" && !Bun.env.DEFAULT_JOB_IMAGE_LINUX_X64) throw new Error("DEFAULT_JOB_IMAGE_LINUX_X64 is required for a non-24 Ubuntu version");
  const env = {
    // This must describe the installed golden image, not merely the requested workflow label.
    DEFAULT_IMAGES: {
      ubuntuVersion: ubuntuVersion as "22" | "24" | "26",
      "linux-x64": Bun.env.DEFAULT_JOB_IMAGE_LINUX_X64 ?? (workerReleaseManifest?.platforms["linux-x64"]?.goldenImage ? `sha256:${workerReleaseManifest.platforms["linux-x64"].goldenImage.sha256}` : undefined),
      "linux-arm64": Bun.env.DEFAULT_JOB_IMAGE_LINUX_ARM64 ?? workerReleaseManifest?.platforms["linux-arm64"]?.jobImage,
      "windows-x64": Bun.env.DEFAULT_JOB_IMAGE_WINDOWS_X64,
      "macos-arm64": Bun.env.DEFAULT_JOB_IMAGE_MACOS_ARM64,
    },
  };
  if (production && !options.skipArtifactChecks) {
    const requiredReleaseArtifacts = {
      webIndex: new URL("index.html", webRoot),
      webScript: new URL("index.js", webRoot),
      webStyles: new URL("index.css", webRoot),
    };
    for (const [name, artifact] of Object.entries(requiredReleaseArtifacts)) {
      if (!await Bun.file(artifact).exists()) throw new Error(`release artifact is unavailable: ${name}`);
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
  const windowsContainerBuild = !production
    ? createDevelopmentWindowsContainerBuild({
      publicOrigin: initialized.setup.publicOrigin() ?? configuredPublicOrigin ?? null,
      artifacts: developmentWindowsArtifacts,
      buildArtifacts: windowsContainerArtifacts,
    })
    : undefined;
  const workerConnectionOrigins = (): string[] => {
    const canonical = initialized.setup.publicOrigin() ?? configuredPublicOrigin;
    return [...new Set([canonical, ...configuredWorkerOrigins].filter((origin): origin is string => Boolean(origin)))];
  };
  const secretBox = options.secretBox ?? new SecretBox(initialized.masterKey);
  const llmProviders = new LlmProvidersService(secretBox, {
    list: async () => await startupQueries(db).llmList.execute({}) as unknown as LlmProviderConfig[],
    get: async (id) => ((await startupQueries(db).llmGet.execute({ id }))[0] as unknown as LlmProviderConfig | undefined) ?? null,
    save: async (input, id) => {
      const values = { name: input.name, kind: input.kind, baseUrl: input.baseUrl, model: input.model, inputUsdPerMillionTokens: input.inputUsdPerMillionTokens ?? null, outputUsdPerMillionTokens: input.outputUsdPerMillionTokens ?? null, encryptedApiKey: input.encryptedApiKey ?? null };
      const rows = id ? await startupQueries(db).llmUpdate.execute({ id, ...values }) : await startupQueries(db).llmInsert.execute(values);
      return rows[0] as unknown as LlmProviderConfig;
    },
    delete: async (id) => {
      const [provider] = await startupQueries(db).llmGet.execute({ id });
      if (!provider) throw new Error("llm_provider_not_found");
      const [{ count }] = await startupQueries(db).llmUseCount.execute({ id });
      if (count) throw new Error("llm_provider_in_use");
      const rows = await startupQueries(db).llmDelete.execute({ id });
      if (!rows.length) throw new Error("llm_provider_not_found");
    },
  });
  const devToken = !production ? Bun.env.MARS_DEV_TOKEN?.trim() : undefined;
  const workerUpgradeService = new WorkerUpgradeService(workerReleaseCatalog, secretBox);
  const current = options.currentUser ?? (async (request: Request) => {
    const authorization = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const supplied = authorization || request.headers.get("x-mars-dev-token")?.trim();
    if (devToken && supplied === devToken) {
      const [admin] = await startupQueries(db).developmentAdmin.execute({});
      if (admin) return { id: admin.id, githubUserId: Number(admin.githubUserId), login: admin.login, isGlobalAdmin: true };
      return { id: "00000000-0000-4000-8000-000000000001", githubUserId: 0, login: "dev-admin", isGlobalAdmin: true };
    }
    return getSession(db, request.headers.get("cookie")?.match(/mars_session=([^;]+)/)?.[1]);
  });
  const commandStore = {
    async save(command: WorkerCommand): Promise<void> {
      await startupQueries(db).saveCommand.execute({ id: command.id, version: command.version, type: command.type, workerId: command.workerId, leaseId: command.leaseId, occurredAt: command.occurredAt, payload: command.payload });
    },
    async listUnacknowledged(workerId: string): Promise<WorkerCommand[]> {
      return listReplayableWorkerCommands(db, workerId);
    },
    async markSent(commandId: string): Promise<void> { await startupQueries(db).markCommandSent.execute({ id: commandId }); },
    async acknowledge(commandId: string): Promise<void> { await startupQueries(db).acknowledgeCommand.execute({ id: commandId }); },
  };
  await startupQueries(db).offlineWorkers.execute({});
  const dispatcher = options.dispatcher ?? new WorkerCommandDispatcher(15_000, commandStore);
  const requestSources = new WeakMap<Request, string>();
  const startedAt = new Date().toISOString();
  const discoveryIntervalMs = Number(Bun.env.DISCOVERY_INTERVAL_MS ?? 300_000);
  const reconciliationIntervalMs = Number(Bun.env.JOB_RECONCILIATION_INTERVAL_MS ?? 5_000);
  const discoveryHealth = new DiscoveryHealthMonitor(discoveryIntervalMs, Date.parse(startedAt));
  const dispatchHealth = new DispatchHealthMonitor(reconciliationIntervalMs);
  const githubApp = options.githubApp ?? new GitHubAppService({ db, secretBox, publicOrigin: initialized.setup.publicOrigin, webhookOrigin: () => configuredWebhookOrigin });
  const githubRateLimits = new GithubRateLimitGate();
  let triggerAiProcessing = () => {};
  const httpApp = createControlPlaneApp({ onBackgroundWorkCommitted: () => { void triggerReconciliation(); triggerAiProcessing(); }, db, setup: initialized.setup, browserOrigin: () => Bun.env.NODE_ENV !== "production" ? (Bun.env.BROWSER_BASE_URL?.trim() || initialized.setup.publicOrigin()) : initialized.setup.publicOrigin(), workerConnectionOrigins, currentUser: current, requestId: () => crypto.randomUUID(), requestSource: request => requestSources.get(request) ?? "unknown", webRoot, secretBox, githubApp, llmProviders, defaultJobImages: env.DEFAULT_IMAGES, workerReleaseManifest, workerReleaseCatalog, workerUpgradeService, developmentWindowsArtifacts, developmentLinuxArtifacts, developmentLinuxArm64Artifacts, developmentMacosArtifacts, windowsContainerBuild, windowsContainerArtifacts, workerInstallerRoot, workerJoin: options.workerJoin, devWindowsImageBuild: options.devWindowsImageBuild ? () => options.devWindowsImageBuild!(windowsContainerBuild, initialized.setup.publicOrigin() ?? configuredPublicOrigin ?? null) : undefined, disableWorkerBootstrapManagement: options.disableWorkerBootstrapManagement, controlPlaneLogs: options.controlPlaneLogs, workerDispatcher: dispatcher, workerConnected: workerId => dispatcher.isConnected(workerId), onWorkerChanged: workerId => dispatcher.replayConnected(workerId), health: () => ({ buildId: controlPlaneBuildId(), startedAt, discovery: discoveryHealth.snapshot() }), dispatchHealth: organizationIds => dispatchHealth.snapshot(organizationIds) });
  let triggerReconciliation = () => Promise.resolve();
  const gateway = createControlPlaneGateway({ db, httpFetch: async request => await httpApp.fetch(request), current, requestSource: (request, activeServer) => { requestSources.set(request, activeServer.requestIP(request)?.address ?? "unknown"); return requestSources.get(request) ?? "unknown"; }, dispatcher, refreshDefaultPools: () => ensureDefaultPools(db, env.DEFAULT_IMAGES), triggerReconciliation: () => triggerReconciliation(), requestId: () => crypto.randomUUID() });
  let server!: Server<ControlPlaneSocketData>;
  server = Bun.serve<ControlPlaneSocketData>({ port: options.port ?? Number(Bun.env.PORT ?? 3000), websocket: gateway.websocket, fetch: request => gateway.fetch(request, server) });
  console.log(`Mars control plane listening on ${server.url}`);
  if (!options.skipBackgroundTasks) {
    const discoveryDeps = {
      db,
      installationToken: (installationId: number) => githubApp.getInstallationToken(installationId),
      githubFetchForInstallation: (installationId: number) => githubRateLimits.scopedFetch(installationId, "background"),
      installationBlocked: (installationId: number) => githubRateLimits.isBackgroundBlocked(installationId),
    };
    let lastGithubLeaseReconciliationAt = 0;
    let lastDispatchStatusLogAt = 0;
    let lastDispatchStatusSignature = "";
    const reconciliationScheduler = startReconciliationScheduler(async () => {
      const decisions: DispatchDecision[] = [];
      let inspected = 0;
      let dispatchSucceeded = false;
      dispatchHealth.markStarted();
      try {
        const report = await runQueuedJobReconciliation({
          db,
          installationToken: installationId => githubApp.getInstallationToken(installationId),
          githubFetchForInstallation: installationId => githubRateLimits.scopedFetch(installationId, "dispatch"),
          dispatcher,
          contractVersion: workerReleaseContractVersion ?? CURRENT_WORKER_CONTRACT_VERSION,
          installationBlocked: installationId => githubRateLimits.isCoolingDown(installationId),
          workerConnected: workerId => dispatcher.isConnected(workerId),
          onDecision: decision => decisions.push(decision),
          onQueueSize: size => { inspected = size; },
        });
        dispatchHealth.markSuccess(decisions);
        dispatchSucceeded = true;
        const status = dispatchHealth.snapshot(null);
        const signature = JSON.stringify({ inspected, reserved: report.reserved, reasons: status.reasons });
        if (signature !== lastDispatchStatusSignature || Date.now() - lastDispatchStatusLogAt >= 60_000) {
          console.log("Control plane dispatch status", { inspected, ...status });
          lastDispatchStatusSignature = signature;
          lastDispatchStatusLogAt = Date.now();
        }
        const reconciliationMessage = formatJobReconciliationReport(report);
        if (reconciliationMessage) console.log(reconciliationMessage);
        if (Date.now() - lastGithubLeaseReconciliationAt >= 60_000) {
          lastGithubLeaseReconciliationAt = Date.now();
          dispatchHealth.markPhase("github_lease_reconciliation");
          const staleLeaseReport = await reconcileExpiredLeasesWithGithub({
            db,
            installationToken: installationId => githubApp.getInstallationToken(installationId),
            githubFetchForInstallation: installationId => githubRateLimits.scopedFetch(installationId, "background"),
          });
          if (staleLeaseReport.completed || staleLeaseReport.released || staleLeaseReport.skipped) console.log(`GitHub stale lease reconciliation: inspected=${staleLeaseReport.inspected} completed=${staleLeaseReport.completed} released=${staleLeaseReport.released} stillActive=${staleLeaseReport.stillActive} skipped=${staleLeaseReport.skipped}`);
        }
      } catch (error) {
        if (!dispatchSucceeded) {
          dispatchHealth.markFailure(error);
          console.error("Control plane dispatch status", dispatchHealth.snapshot(null));
        }
        console.error(dispatchSucceeded ? "Background lease reconciliation failed" : "Job reconciliation failed", error);
      } finally {
        try {
          dispatchHealth.markPhase("lease_cleanup");
          const cleanup = await reapPendingLeases({ db, dispatch: dispatcher.dispatch.bind(dispatcher), workerConnected: workerId => dispatcher.isConnected(workerId) });
          if (cleanup.dispatched || cleanup.failed) console.log(`Lease cleanup tick: dispatched=${cleanup.dispatched} failed=${cleanup.failed} skipped=${cleanup.skipped}`);
          dispatchHealth.markPhase("onboarding");
          await completeOnboardingIfReady(db);
        } catch (error) { console.error("Lease cleanup failed", error); } finally { dispatchHealth.markIdle(); }
      }
    }, reconciliationIntervalMs);
    dispatchHealth.setSchedulerStatus(() => reconciliationScheduler.status());
    startImmediateCron(Bun.env.JOB_QUEUED_DISCOVERY_CRON ?? "*/5 * * * *", async () => {
      const started = Date.now();
      console.log("Queued GitHub job discovery started", { at: new Date(started).toISOString() });
      try {
        const pickup = await discoverQueuedRepositoryJobs(discoveryDeps);
        console.log("Queued GitHub job discovery finished", { ...pickup, durationMs: Date.now() - started });
        if (pickup.updated > 0) await reconciliationScheduler.trigger();
        triggerAiProcessing();
      } catch (error) {
        console.error("Queued GitHub job discovery failed", error);
      }
    });
    startReconciliationScheduler(async () => {
      discoveryHealth.markAttempt();
      try {
        const report = await discoverAvailableRepositoryJobs(discoveryDeps);
        triggerAiProcessing();
        if (isDiscoveryCycleSuccessful(report)) discoveryHealth.markSuccess();
        if (report.failed) console.error(`GitHub job discovery: repositories=${report.repositories} discovered=${report.discovered} updated=${report.updated} failed=${report.failed}`);
      } catch (error) { console.error("GitHub job discovery failed", error); }
      try {
        const retry = await retryFailedGithubJobs(discoveryDeps);
        if (retry.requested || retry.failed) console.log(`GitHub job retries: requested=${retry.requested} skipped=${retry.skipped} failed=${retry.failed}`);
      } catch (error) { console.error("GitHub job retry cycle failed", error); }
    }, discoveryIntervalMs, false);
    startReconciliationScheduler(async () => {
      try {
        const cleanup = await cleanGithubRunners({
          db,
          installationToken: installationId => githubApp.getInstallationToken(installationId),
          githubFetchForInstallation: installationId => githubRateLimits.scopedFetch(installationId, "background"),
          installationBlocked: installationId => githubRateLimits.isBackgroundBlocked(installationId),
        });
        if (cleanup.deleted || cleanup.failed) console.log("GitHub runner cleanup", cleanup);
      } catch (error) { console.error("GitHub runner cleanup failed", error); }
    }, 15_000, false);
    const pipelineAnalysisScheduler = startReconciliationScheduler(async () => {
      try {
        const [app] = await startupQueries(db).githubAppId.execute({});
        await processPipelineFailureAnalyses({
          db,
          secretBox,
          generatePipelineAnalysis: input => llmProviders.analyze(input.provider, input.context, input.onUsage, input.onRequest),
          installationToken: installationId => githubApp.getInstallationToken(installationId),
          githubFetchForInstallation: installationId => githubRateLimits.scopedFetch(installationId, "background") as unknown as typeof fetch,
          installationBlocked: installationId => githubRateLimits.isBackgroundBlocked(installationId),
          githubAppId: app?.appId == null ? undefined : Number(app.appId),
        });
      } catch (error) { console.error("Pipeline failure analysis processing failed", error); }
    }, 15_000);
    const prReviewScheduler = startReconciliationScheduler(async () => {
      try {
        const [app] = await startupQueries(db).githubAppId.execute({});
        await processPrReviews({
          db, secretBox,
          providerConfig: id => llmProviders.config(id),
          generate: input => generatePrReview(input),
          installationToken: id => githubApp.getInstallationToken(id),
          githubFetchForInstallation: id => githubRateLimits.scopedFetch(id, "background") as unknown as typeof fetch,
          installationBlocked: id => githubRateLimits.isBackgroundBlocked(id),
          githubAppId: app?.appId == null ? undefined : Number(app.appId),
          githubAppSlug: app?.slug ?? undefined,
        });
      } catch (error) { console.error("PR review processing failed", error); }
    }, 15_000);
    triggerReconciliation = reconciliationScheduler.trigger;
    triggerAiProcessing = () => {
      void pipelineAnalysisScheduler.trigger();
      void prReviewScheduler.trigger();
    };
    const runRetention = async () => { try { console.log("Retention pruner", await pruneExpiredData(db)); } catch (error) { console.error("Retention pruning failed", error); } };
    void runRetention();
    setInterval(() => { void runRetention(); }, 24 * 60 * 60 * 1_000);
    setInterval(() => { for (const socket of gateway.browserSockets) void gateway.replayBrowserInvalidations(socket); }, 1_000);
  }
  return { server, gateway, httpApp, db, setup: initialized.setup };
}

if (import.meta.main) {
  configureTimestampedConsoleLogging();
  configureErrorFileLogging(Bun.env.DATA_ROOT?.trim() || "/var/lib/mars");
  const controlPlaneLogs = configureControlPlaneLogBuffer();
  try {
    await startControlPlane({ controlPlaneLogs: controlPlaneLogs.source });
  } catch (error) {
    console.error("Control plane startup failed", error);
    process.exitCode = 1;
  }
}
