import type { DashboardDb } from "@mars/db";
import type { SessionUser, SecretBox } from "../auth.ts";
import type { ControlPlaneSetup } from "../control-plane-setup.ts";
import type { RequestLimiter } from "../worker-requests.ts";
import type { WorkerCommandDispatcher } from "../worker-dispatch.ts";
import type { GitHubAppService } from "../github-app.ts";
import type { DiscoveryHealthSnapshot } from "../discovery-health.ts";
import type { WorkerReleaseManifest } from "@mars/contracts";
export type ControlPlaneEnv = { Variables: { user: SessionUser } };

export type DevelopmentArtifact = {
  path?: string;
  url?: string;
  sha256: string;
};

export type DevelopmentWindowsArtifacts = {
  orchestrator: DevelopmentArtifact;
  serviceHost: DevelopmentArtifact;
  container?: {
    baseImage: string;
    runner: DevelopmentArtifact;
    git: DevelopmentArtifact;
    vcRuntime: DevelopmentArtifact;
    buildScript?: DevelopmentArtifact;
    verifyScript?: DevelopmentArtifact;
    containerfile?: DevelopmentArtifact;
    entrypoint?: DevelopmentArtifact;
  };
};

export type DevelopmentLinuxArtifacts = {
  brokerImage?: string;
  goldenImage?: DevelopmentArtifact;
  compose?: DevelopmentArtifact;
  domainTemplate?: DevelopmentArtifact;
};

export type DevelopmentMacosArtifacts = {
  orchestrator?: DevelopmentArtifact;
  jobAgent?: DevelopmentArtifact;
  imagePreparationScript?: DevelopmentArtifact;
  tartImage?: string;
  tartImageDigest?: string;
};

export type DevelopmentArtifactFetchOptions = RequestInit & {
  tls?: {
    serverName?: string;
  };
};

export type DevelopmentArtifactProxyOptions = {
  fetch?: (input: string | URL | Request, init?: DevelopmentArtifactFetchOptions) => Promise<Response>;
  resolveHostname?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  headerTimeoutMs?: number;
  totalTimeoutMs?: number;
  downstreamTimeoutMs?: number;
  maxRedirects?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  maxFlightWaiters?: number;
  maxBytes?: Partial<Record<"template" | "archive" | "binary", number>>;
  maxCacheBytes?: number;
};

export type ControlPlaneHealth = {
  buildId: string;
  startedAt: string;
  discovery: DiscoveryHealthSnapshot;
};

export type ControlPlaneHttpDeps = {
  db: DashboardDb;
  setup: ControlPlaneSetup;
  browserOrigin(): string | null;
  secretBox: SecretBox;
  githubApp?: GitHubAppService;
  defaultJobImages: Partial<Record<"linux-x64" | "windows-x64" | "macos-arm64", string>>;
  workerReleaseManifest?: WorkerReleaseManifest;
  developmentWindowsArtifacts?: DevelopmentWindowsArtifacts;
  developmentLinuxArtifacts?: DevelopmentLinuxArtifacts;
  developmentMacosArtifacts?: DevelopmentMacosArtifacts;
  developmentArtifactProxy?: DevelopmentArtifactProxyOptions;
  /** Development-only local source for installer scripts. */
  workerInstallerRoot?: URL;
  /** Development-only image builder seam; never populated by production startup. */
  windowsContainerBuild?: {
    baseImage: string;
    runnerUrl: string;
    runnerSha256: string;
    gitUrl: string;
    gitSha256: string;
    vcUrl: string;
    vcSha256: string;
    builderPath: string;
    verifierPath: string;
    containerfilePath: string;
    entrypointPath: string;
    jobAgentPath: string;
  };
  windowsContainerArtifacts?: {
    builderPath: string;
    verifierPath: string;
    containerfilePath: string;
    entrypointPath: string;
    jobAgentPath: string;
  };
  /** Legacy local-only template seams retained for non-production tooling. */
  workerTemplateDigests?: Partial<Record<"windows-x64" | "linux-x64", string>>;
  workerConnectionOrigins(): string[];
  currentUser(request: Request): Promise<SessionUser | null>;
  requestId(): string;
  requestSource(request: Request): string;
  webRoot: URL;
  workerRequestLimiter?: RequestLimiter;
  workerDispatcher?: WorkerCommandDispatcher;
  workerConnected?: (workerId: string) => boolean;
  onWorkerAdopted(workerId: string): void;
  health(): ControlPlaneHealth;
};
