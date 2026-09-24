import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "../packages/db/src/index.ts";
import { requestPendingWorker, type WorkerRequestResult } from "../apps/control-plane/src/worker-requests.ts";
import { WorkerBootstrapRequest } from "../packages/contracts/src/index.ts";
import { createWorkerImageBuildPayload } from "../apps/control-plane/src/windows-image-build.ts";
import type { ControlPlaneStartOptions } from "../apps/control-plane/src/index.ts";

export function deriveDevWorkerCode(token: string): string {
  if (!token.trim()) throw new Error("MARS_DEV_TOKEN is required");
  return createHash("sha256").update("mars-dev-worker-bootstrap-v1\0").update(token.trim(), "utf8").digest("base64url");
}

export function devWorkerEnrollmentAdapter(token: string): (db: Sql<{}>, body: unknown) => Promise<WorkerRequestResult> {
  const codeHash = createHash("sha256").update(Buffer.from(deriveDevWorkerCode(token), "base64url")).digest();
  return (db, body) => requestPendingWorker(db, WorkerBootstrapRequest.parse(body), undefined, undefined, { codeHash, reusable: true });
}

export async function devWindowsImageBuild(build: Parameters<NonNullable<ControlPlaneStartOptions["devWindowsImageBuild"]>>[0], publicOrigin: string | null) {
  if (!build || !publicOrigin) return null;
  const paths = [build.builderPath, build.verifierPath, build.containerfilePath, build.entrypointPath, build.jobAgentPath];
  if (!(await Promise.all(paths.map(path => Bun.file(path).exists()))).every(Boolean)) return null;
  return createWorkerImageBuildPayload({ baseUrl: publicOrigin, buildId: randomUUID(), image: "mars/windows-job:local", build });
}