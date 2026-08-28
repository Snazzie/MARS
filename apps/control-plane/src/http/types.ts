import type { DashboardDb } from "@mars/db";
import type { SessionUser, SecretBox } from "../auth.ts";
import type { ControlPlaneSetup } from "../control-plane-setup.ts";
import type { RequestLimiter } from "../worker-requests.ts";
import type { WorkerCommandDispatcher } from "../worker-dispatch.ts";
import type { GitHubAppService } from "../github-app.ts";
import type { DiscoveryHealthSnapshot } from "../discovery-health.ts";

export type ControlPlaneEnv = { Variables: { user: SessionUser } };

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
  templateManifestPaths?: Partial<Record<"windows-x64" | "linux-x64", string>>;
  templateArtifactPaths?: Partial<Record<"windows-x64" | "linux-x64", string>>;
  workerTemplatePaths?: Partial<Record<"windows-x64" | "linux-x64", string>>;
  workerTemplateDigests?: Partial<Record<"windows-x64" | "linux-x64", string>>;
  macosTartBaseImage?: string;
  workerConnectionOrigins(): string[];
  currentUser(request: Request): Promise<SessionUser | null>;
  requestId(): string;
  requestSource(request: Request): string;
  webRoot: URL;
  workerInstallerRoot: URL;
  workerOrchestratorExecutables?: Partial<Record<"linux-x64" | "windows-x64" | "macos-arm64", URL>>;
  workerServiceHostExecutable?: URL;
  workerOrchestratorExecutable?: URL;
  workerRequestLimiter?: RequestLimiter;
  workerDispatcher?: WorkerCommandDispatcher;
  workerConnected?: (workerId: string) => boolean;
  onWorkerAdopted(workerId: string): void;
  health(): ControlPlaneHealth;
};
