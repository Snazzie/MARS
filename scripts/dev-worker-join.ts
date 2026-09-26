import { createHash, randomUUID } from "node:crypto";
import { lstat, rename } from "node:fs/promises";
import type { Sql } from "../packages/db/src/index.ts";
import { requestPendingWorker, type WorkerRequestResult } from "../apps/control-plane/src/worker-requests.ts";
import { WorkerBootstrapRequest } from "../packages/contracts/src/index.ts";
import { createWorkerImageBuildPayload } from "../apps/control-plane/src/windows-image-build.ts";
import type { ControlPlaneStartOptions } from "../apps/control-plane/src/index.ts";

export function deriveDevWorkerCode(token: string): string {
  if (!token.trim()) throw new Error("MARS_DEV_TOKEN is required");
  return createHash("sha256").update("mars-dev-worker-bootstrap-v1\0").update(token.trim(), "utf8").digest("base64url");
}

export async function renewRevokedDevWorker(
  identityPath: string,
  workerId: string,
  controlPlane: string,
  token: string,
  request: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workerId)) throw new Error("Development worker identity has an invalid worker ID");
  const response = await request(new URL(`/api/organizations/all/workers/${encodeURIComponent(workerId)}`, controlPlane), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Cannot check development worker ${workerId} admission (HTTP ${response.status}); verify the control plane and MARS_DEV_TOKEN before changing its identity`);
  const worker = await response.json() as { admissionState?: string };
  if (!["pending", "adopted", "revoked", "rejected"].includes(worker.admissionState ?? "")) throw new Error(`Development worker ${workerId} admission response is invalid`);
  if (worker.admissionState !== "revoked") return false;
  const archivedPath = `${identityPath}.revoked-${workerId}`;
  try {
    await lstat(archivedPath);
    throw new Error(`Revoked development worker identity archive already exists: ${archivedPath}`);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  await rename(identityPath, archivedPath);
  return true;
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