import {
  ApiError,
  ApproveWorkerRequest,
  CursorPage,
  LogChunk,
  OrganizationSettings,
  OrganizationSummary,
  OverviewDto,
  PendingWorkerRequest,
  WorkerConfiguration,
  WorkerDetail,
  PoolSummary,
  RepositorySummary,
  RunDetail,
  RunSummary,
  OnboardingDetail,
  OnboardingStatus,
  SelectOnboardingWorkerRequest,
  StartOnboardingVerificationRequest,
  StartOnboardingVerificationResult,
  VerifyOnboardingRepositoriesResult,
  CreatePoolRequest,
  RunnerWorkflowFile,
  RunnerWorkflowPreview,
  RunnerWorkflowPrRequest,
  RunnerWorkflowPrResult,
} from "@whitesmith/contracts";
import { z } from "zod";

export type ApiResult<T> = { data: T; status: number };

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function request<S extends z.ZodTypeAny>(path: string, schema: S, init?: RequestInit): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiRequestError("The control plane is offline. Check your connection and try again.", 0, "offline");
  }

  if (response.status === 401) throw new ApiRequestError("Your session has expired.", 401, "unauthorized");
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const body = ApiError.parse(await response.json());
      message = body.message;
      code = body.code;
    } catch {
      // Keep the HTTP status message when the server did not return the API error DTO.
    }
    throw new ApiRequestError(message, response.status, code);
  }

  return schema.parse(await response.json());
}

const meResponse = z.object({ id: z.string(), githubUserId: z.number().int(), login: z.string().min(1), isGlobalAdmin: z.boolean() });
export const getMe = () => request("/api/me", meResponse);
export const getHealth = () => request("/api/healthz", z.object({ ok: z.boolean(), discovery: z.object({ stale: z.boolean(), lastSuccessAt: z.string().nullable() }).passthrough() }).passthrough());
export const logout = () => request("/api/auth/logout", z.object({ ok: z.literal(true) }), { method: "POST" });
export const getOrganizations = () => request("/api/organizations", z.array(OrganizationSummary));
export const getOverview = (organizationId: string, period: OverviewDto["period"] = "24h") =>
  request(`/api/organizations/${organizationId}/overview?period=${period}`, OverviewDto);
export function getRuns(organizationId: string, { cursor, search = "", limit = 50 }: { cursor?: string | null; search?: string; limit?: number } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (search) query.set("search", search);
  if (cursor) query.set("cursor", cursor);
  return request(`/api/organizations/${organizationId}/runs?${query}`, CursorPage(RunSummary));
}
export const getRun = (organizationId: string, runId: string) =>
  request(`/api/organizations/${organizationId}/runs/${runId}`, RunDetail);
export const getLogs = (organizationId: string, runId: string, jobId: string, after: string | number = -1, limit = 100) =>
  request(`/api/organizations/${organizationId}/runs/${runId}/jobs/${jobId}/logs?after=${after}&limit=${limit}`, CursorPage(LogChunk));
export const getStepLogs = (organizationId: string, runId: string, jobId: string, stepId: string, after: string | number = -1, limit = 100) =>
  request(`/api/organizations/${organizationId}/runs/${runId}/jobs/${jobId}/steps/${stepId}/logs?after=${after}&limit=${limit}`, CursorPage(LogChunk));
export function getRepositories(organizationId: string, {
  cursor,
  search = "",
  availability,
  visibility,
  limit = 50,
}: {
  cursor?: string | null;
  search?: string;
  availability?: "available" | "unavailable";
  visibility?: "all" | "public" | "private" | "internal";
  limit?: number;
} = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (search) query.set("search", search);
  if (availability) query.set("availability", availability);
  if (visibility && visibility !== "all") query.set("visibility", visibility);
  if (cursor) query.set("cursor", cursor);
  return request(`/api/organizations/${organizationId}/repositories?${query}`, CursorPage(RepositorySummary));
}
export const getWorkers = (organizationId: string, includeInactive = false) =>
  request(`/api/organizations/${organizationId}/workers?includeInactive=${includeInactive ? "true" : "false"}`, CursorPage(WorkerDetail));
export async function configureWorker(organizationId: string, workerId: string, input: WorkerConfigurationInput) {
  return request(`/api/organizations/${organizationId}/workers/${workerId}/configure`, z.object({ revision: z.string(), fingerprint: z.string(), commandId: z.string().uuid().optional() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export async function mutateWorker(organizationId: string, workerId: string, action: "reject" | "drain" | "remove"): Promise<{ ok: boolean }> {
  const idempotencyKey = crypto.randomUUID();
  return request(`/api/organizations/${organizationId}/workers/${workerId}/${action}`, z.object({ ok: z.boolean() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({}),
  });
}

const WorkerBootstrapStatus = z.object({ initialized: z.boolean(), generation: z.number().nullable(), createdAt: z.string().nullable(), rotatedAt: z.string().nullable() });
const WorkerBootstrapReveal = z.object({ code: z.string().min(1), generation: z.number(), createdAt: z.string() });
export const getWorkerBootstrapStatus = () => request("/api/workers/bootstrap", WorkerBootstrapStatus, { cache: "no-store" });
export const getWorkerControlPlaneUrls = () => request("/api/workers/control-plane-urls", z.array(z.string().url()), { cache: "no-store" });
const pendingWorkersResponse = z.array(z.object({ id: z.string().uuid(), fingerprint: z.string().min(1) }).merge(PendingWorkerRequest));
export const getPendingWorkerRequests = () => request("/api/workers/pending", pendingWorkersResponse, { cache: "no-store" });
export async function approvePendingWorker(workerId: string, input: ApproveWorkerRequest) {
  return request(`/api/workers/pending/${workerId}/approve`, z.object({ ok: z.boolean() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(ApproveWorkerRequest.parse(input)),
  });
}
export type WorkerConfigurationInput = {
  appliance: z.infer<typeof WorkerConfiguration>["appliance"];
  runtime: z.infer<typeof WorkerConfiguration>["runtime"];
  guestPlatforms: z.infer<typeof WorkerConfiguration>["guestPlatforms"];
};
export async function configurePendingWorker(workerId: string, input: WorkerConfigurationInput) {
  return request(`/api/workers/pending/${workerId}/configure`, z.object({ revision: z.string(), fingerprint: z.string(), commandId: z.string().uuid().optional() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function rejectPendingWorker(workerId: string) {
  return request(`/api/workers/pending/${workerId}/reject`, z.object({ ok: z.boolean() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export const initializeWorkerBootstrap = () => request("/api/workers/bootstrap/initialize", WorkerBootstrapReveal, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: "{}" });
export const rotateWorkerBootstrap = () => request("/api/workers/bootstrap/rotate", WorkerBootstrapReveal, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: "{}" });
export const getGlobalPools = () =>
  request("/api/pools", CursorPage(PoolSummary));
export const mutateGlobalPool = (poolId: string, action: "enable" | "disable") =>
  request(`/api/pools/${poolId}/${action}`, z.object({ ok: z.boolean() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
export const getSettings = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/settings`, OrganizationSettings);
export async function mutatePool(organizationId: string, poolId: string, action: "enable" | "disable" | "rotate-key") {
  return request(`/api/organizations/${organizationId}/pools/${poolId}/${action}`, z.object({ ok: z.boolean() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({}),
  });
}
export async function updateSettings(organizationId: string, settings: Omit<z.infer<typeof OrganizationSettings>, "organizationId">) {
  return request(`/api/organizations/${organizationId}/settings`, OrganizationSettings, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(settings),
  });
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "unauthorized";
}

export function isOffline(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "offline";
}
const onboardingStatusResponse = OnboardingStatus;
const onboardingDetailResponse = OnboardingDetail;
export const getOnboardingStatus = () => request("/api/onboarding/status", onboardingStatusResponse, { cache: "no-store" });
export const getOnboardingDetail = () => request("/api/onboarding", onboardingDetailResponse, { cache: "no-store" });
export async function selectOnboardingWorker(input: SelectOnboardingWorkerRequest) {
  return request("/api/onboarding/worker", z.object({ ok: z.boolean() }), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function verifyOnboardingRepositories() {
  return request("/api/onboarding/repositories/verify", VerifyOnboardingRepositoriesResult, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
}
export async function startOnboardingVerification(input: StartOnboardingVerificationRequest) {
  return request("/api/onboarding/verification", StartOnboardingVerificationResult, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function beginOnboardingGithubInstall(input: { organizationId: string }) {
  return request("/api/github/app/install", z.object({ location: z.string().url() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function beginOrganizationGithubInstall(organizationId: string) {
  return request(`/api/organizations/${organizationId}/github/install`, z.object({ location: z.string().url() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export const getGithubOrganizationSettings = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/github/settings`, z.object({ location: z.string().url() }));
export const getGithubRepositorySettings = (organizationId: string, repositoryId: string) =>
  request(`/api/organizations/${organizationId}/repositories/${repositoryId}/github/settings`, z.object({ location: z.string().url() }));
export async function refreshGithubConnection(organizationId: string) {
  return request(`/api/organizations/${organizationId}/github/refresh`, z.object({ ok: z.boolean() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export function recheckRepositoryDiscovery(organizationId: string, repositoryId: string) {
  return request(
    `/api/organizations/${organizationId}/repositories/${repositoryId}/discovery/recheck`,
    z.object({ queued: z.literal(true) }),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: "{}",
    },
  );
}
export async function uninstallOrganizationGithub(organizationId: string) {
  return request(`/api/organizations/${organizationId}/github/uninstall`, z.object({ ok: z.boolean() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export async function beginOnboardingGithubManifest(input: { organizationId: string }) {
  return request("/api/github/app/manifest", z.object({ action: z.string().url(), manifest: z.string() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function createOnboardingPool(input: CreatePoolRequest & { organizationId: string }) {
  return request("/api/organizations/" + input.organizationId + "/pools", z.object({ id: z.string().uuid().optional() }).passthrough(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ workerId: input.workerId, guestPlatform: input.guestPlatform, name: input.name, resources: input.resources, triggerLabel: input.triggerLabel, imageDigest: input.imageDigest }),
  });
}
export const getRunnerWorkflowFiles = (organizationId: string, repositoryId: string) =>
  request(`/api/organizations/${organizationId}/repositories/${repositoryId}/runner-workflows`, RunnerWorkflowFile.array());
export const previewRunnerWorkflowPr = (organizationId: string, repositoryId: string, selectedPaths: string[]) =>
  request(`/api/organizations/${organizationId}/repositories/${repositoryId}/runner-workflows/preview`, RunnerWorkflowPreview, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedPaths }) });
export const createRunnerWorkflowPr = (organizationId: string, repositoryId: string, input: RunnerWorkflowPrRequest) =>
  request(`/api/organizations/${organizationId}/repositories/${repositoryId}/runner-workflows/pr`, RunnerWorkflowPrResult, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(input) });
