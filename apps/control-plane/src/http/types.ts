import type { DashboardDb } from "@whitesmith/db";
import type { SessionUser, SecretBox } from "../auth.ts";
import type { RequestLimiter } from "../worker-requests.ts";
import type { WorkerCommandDispatcher } from "../worker-dispatch.ts";
import type { GitHubAppService } from "../github-app.ts";

export type ControlPlaneEnv = { Variables: { user: SessionUser } };

export type ControlPlaneHttpDeps = {
  db: DashboardDb;
  baseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  bootstrapGithubLogin: string;
  secretBox: SecretBox;
  githubWebhookSecret?: string;
  githubApp?: GitHubAppService;
  defaultJobImages: Partial<Record<"linux-x64" | "windows-x64" | "macos-arm64", string>>;
  macosTartBaseImage?: string;
  workerControlPlaneUrls?: string[];
  currentUser(request: Request): Promise<SessionUser | null>;
  requestId(): string;
  requestSource(request: Request): string;
  webRoot: URL;
  workerInstallerRoot: URL;
  workerOrchestratorExecutables?: Partial<Record<"linux-x64" | "windows-x64" | "macos-arm64", URL>>;
  workerOrchestratorExecutable?: URL;
  workerRequestLimiter?: RequestLimiter;
  workerDispatcher?: WorkerCommandDispatcher;
  onWorkerAdopted(workerId: string): void;
};
