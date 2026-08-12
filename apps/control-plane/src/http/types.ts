import type { DashboardDb } from "@whitesmith/db";
import type { SessionUser } from "../auth.ts";
import type { RequestLimiter } from "../worker-requests.ts";
import type { WorkerCommandDispatcher } from "../worker-dispatch.ts";

export type ControlPlaneEnv = { Variables: { user: SessionUser } };

export type ControlPlaneHttpDeps = {
  db: DashboardDb;
  baseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  bootstrapGithubLogin: string;
  githubWebhookSecret: string;
  currentUser(request: Request): Promise<SessionUser | null>;
  requestId(): string;
  requestSource(request: Request): string;
  webRoot: URL;
  workerInstallerRoot: URL;
  workerRequestLimiter?: RequestLimiter;
  workerDispatcher?: WorkerCommandDispatcher;
  onWorkerAdopted(workerId: string): void;
};
