import type { DashboardDb } from "@whitesmith/db";
import type { SessionUser } from "../auth.ts";

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
  onWorkerAdopted(workerId: string): void;
};
