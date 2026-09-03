import {
  ApiError,
  ApproveWorkerRequest,
  CursorPage,
  DashboardWorkerCachePage,
  LogChunk,
  OrganizationSettings,
  OrganizationSummary,
  OverviewDto,
  PendingWorkerRequest,
  PoolSummary,
  WorkerHealth,
  WorkerImageBuildSpec,
  WorkerConfiguration,
  WorkerDetail,
  RepositorySummary,
  RunDetail,
  RunSummary,
  JobTimingSnapshot,
  JobTimingAggregate,
  JobResourceSample,
  JobResourceTrendResponse,
  JobResourceTrendSort,
  OnboardingDetail,
  OnboardingStatus,
  ControlPlaneSetupRequest,
  SelectOnboardingWorkerRequest,
  StartOnboardingVerificationRequest,
  StartOnboardingVerificationResult,
  VerifyOnboardingRepositoriesResult,
  CreatePoolRequest,
  RunnerWorkflowFile,
  RunnerWorkflowPreview,
  RunnerWorkflowPrRequest,
  RunnerWorkflowPrResult,
} from "@mars/contracts";
import {
  DashboardBootstrapReveal,
  DashboardBootstrapStatus,
  DashboardBuildWorkerResponse,
  DashboardHealthResponse,
  DashboardOkResponse,
  DashboardOperator,
  DashboardWorkerMutationResponse,
  DashboardPoolMutationResponse,
  DashboardLocationResponse,
  DashboardManifestResponse,
  DashboardPendingWorkerResponse,
  DashboardQueuedResponse,
  DashboardPoolCreateResponse,
} from "@mars/contracts";
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

  const rawBody = await response.text();
  if (!rawBody.trim()) throw new ApiRequestError("The control plane returned an empty response. Restart the control plane and try again.", response.status, "empty_response");
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new ApiRequestError("The control plane returned invalid JSON.", response.status, "invalid_json");
  }
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "response"}: ${issue.message}`).join("; ");
      throw new ApiRequestError(`Invalid API response for ${init?.method ?? "GET"} ${path}: ${issues}`, response.status, "invalid_response");
    }
    throw error;
  }
}

export const getMe = () => request("/api/me", DashboardOperator);
export const getHealth = () => request("/api/healthz", DashboardHealthResponse);
export const getWorkerHealth = (workerId: string) =>
  request(`/api/workers/${workerId}/health`, WorkerHealth, { cache: "no-store" });
export const logout = () => request("/api/auth/logout", DashboardOkResponse, { method: "POST" });
export const getOrganizations = () => request("/api/organizations", z.array(OrganizationSummary));
export const getOverview = (organizationId: string, period: OverviewDto["period"] = "24h") =>
  request(`/api/organizations/${organizationId}/overview?period=${period}`, OverviewDto);
export function getRuns(organizationId: string, { cursor, search = "", limit = 50 }: { cursor?: string | null; search?: string; limit?: number } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (search) query.set("search", search);
  if (cursor) query.set("cursor", cursor);
  return request(`/api/organizations/${organizationId}/runs?${query}`, CursorPage(RunSummary));
}
export function getJobTimingHistory(organizationId: string, params: { cursor?: string | null; from?: string; to?: string; platform?: string; vcpu?: number; concurrency?: number; limit?: number } = {}) {
  const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && key !== "limit") query.set(key, String(value));
  return request(`/api/organizations/${organizationId}/job-timings?${query}`, CursorPage(JobTimingSnapshot));
}
export function getJobTimingAggregates(organizationId: string, params: { from?: string; to?: string; platform?: string; vcpu?: number; concurrency?: number } = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  return request(`/api/organizations/${organizationId}/job-timings/aggregates?${query}`, JobTimingAggregate.array());
}
export type JobResourceTrendRequest = {
  from: string;
  to: string;
  platform?: string;
  vcpu?: number;
  concurrency?: number;
  search?: string;
  sort?: JobResourceTrendSort;
  cursor?: string | null;
  limit?: number;
  jobKey?: string | null;
  pointLimit?: number;
};

export function buildJobResourceTrendsUrl(organizationId: string, params: JobResourceTrendRequest): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  return `/api/organizations/${organizationId}/job-resource-trends?${query}`;
}

export function getJobResourceTrends(organizationId: string, params: JobResourceTrendRequest) {
  return request(buildJobResourceTrendsUrl(organizationId, params), JobResourceTrendResponse);
}
export const getJobResourceSamples = (organizationId: string, runId: string, jobId: string, after: string | null = null, limit = 100) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (after) query.set("after", after);
  return request(`/api/organizations/${organizationId}/runs/${runId}/jobs/${jobId}/resource-samples?${query}`, CursorPage(JobResourceSample));
};
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
export async function configureWorker(workerId: string, input: WorkerConfigurationInput) {
  return request(`/api/workers/${workerId}/configure`, DashboardWorkerMutationResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
const WorkerRunnerCachePurgeResponse = z.object({ workerId: z.string().min(1), commandId: z.string().uuid() }).strict();
export function purgeWorkerCache(workerId: string) {
  return request(`/api/workers/${workerId}/cache/purge`, WorkerRunnerCachePurgeResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export function buildWorkerImage(workerId: string, spec: z.input<typeof WorkerImageBuildSpec>) {
  return request(`/api/workers/${workerId}/build-runtime`, DashboardBuildWorkerResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(WorkerImageBuildSpec.parse(spec)),
  });
}

export async function mutateWorker(organizationId: string, workerId: string, action: "reject" | "drain" | "resume" | "remove"): Promise<{ ok: boolean }> {
  const idempotencyKey = crypto.randomUUID();
  return request(`/api/organizations/${organizationId}/workers/${workerId}/${action}`, DashboardOkResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({}),
  });
}
export function setWorkerLeasePreservation(organizationId: string, workerId: string, enabled: boolean) {
  return request(`/api/organizations/${organizationId}/workers/${workerId}/lease-preservation`, WorkerDetail, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ enabled }),
  });
}
export const getWorkerBootstrapStatus = () => request("/api/workers/bootstrap", DashboardBootstrapStatus, { cache: "no-store" });
export const getWorkerControlPlaneUrls = () => request("/api/workers/control-plane-urls", z.array(z.string().url()), { cache: "no-store" });
export const getPendingWorkerRequests = () => request("/api/workers/pending", DashboardPendingWorkerResponse, { cache: "no-store" });
export async function approvePendingWorker(workerId: string, input: ApproveWorkerRequest) {
  return request(`/api/workers/pending/${workerId}/approve`, DashboardOkResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(ApproveWorkerRequest.parse(input)),
  });
}
export type WorkerConfigurationInput = {
  appliance: z.infer<typeof WorkerConfiguration>["appliance"];
  runtime: z.infer<typeof WorkerConfiguration>["runtime"];
  guestPlatforms: z.infer<typeof WorkerConfiguration>["guestPlatforms"];
  cache?: { ttlSeconds?: number; runnerCacheEnabled?: boolean; runnerCacheMaxGiB?: number };
};
export function getWorkerCache(workerId: string, { cursor, query = "", limit = 50 }: { cursor?: string | null; query?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  if (query) params.set("query", query);
  return request(`/api/workers/${workerId}/cache?${params.toString()}`, DashboardWorkerCachePage);
}
export async function configurePendingWorker(workerId: string, input: WorkerConfigurationInput) {
  return request(`/api/workers/pending/${workerId}/configure`, DashboardWorkerMutationResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function rejectPendingWorker(workerId: string) {
  return request(`/api/workers/pending/${workerId}/reject`, DashboardOkResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export const initializeWorkerBootstrap = () => request("/api/workers/bootstrap/initialize", DashboardBootstrapReveal, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: "{}" });
export const rotateWorkerBootstrap = () => request("/api/workers/bootstrap/rotate", DashboardBootstrapReveal, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: "{}" });
export const getGlobalPools = (cursor?: string | null, limit = 50) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return request(`/api/pools?${query}`, CursorPage(PoolSummary));
};
export const saveGlobalPool = (input: CreatePoolRequest) =>
  request(input.poolId ? `/api/pools/${input.poolId}` : "/api/pools", DashboardPoolMutationResponse, {
    method: input.poolId ? "PUT" : "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
export const deleteGlobalPool = (poolId: string) =>
  request(`/api/pools/${poolId}`, DashboardOkResponse, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } });
export const mutateGlobalPool = (poolId: string, action: "enable" | "disable") =>
  request(`/api/pools/${poolId}/${action}`, DashboardOkResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
export const getSettings = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/settings`, OrganizationSettings);
export async function mutatePool(organizationId: string, poolId: string, action: "enable" | "disable") {
  return request(`/api/organizations/${organizationId}/pools/${poolId}/${action}`, DashboardOkResponse, {
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
  return request("/api/onboarding/worker", DashboardOkResponse, {
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
export async function skipOnboardingLabels() {
  return request("/api/onboarding/skip-labels", DashboardOkResponse, {
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
export async function beginUnboundOnboardingGithubInstall() {
  return request("/api/onboarding/github/install", DashboardLocationResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export async function beginOnboardingGithubInstall(input: { organizationId: string }) {
  return request(`/api/github/app/install`, DashboardLocationResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function beginOrganizationGithubInstall(organizationId: string) {
  return request(`/api/organizations/${organizationId}/github/install`, DashboardLocationResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export const getGithubOrganizationSettings = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/github/settings`, DashboardLocationResponse);
export const getGithubRepositorySettings = (organizationId: string, repositoryId: string) =>
  request(`/api/organizations/${organizationId}/repositories/${repositoryId}/github/settings`, DashboardLocationResponse);
export async function refreshGithubConnection(organizationId: string) {
  return request(`/api/organizations/${organizationId}/github/refresh`, DashboardOkResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export function recheckRepositoryDiscovery(organizationId: string, repositoryId: string) {
  return request(
    `/api/organizations/${organizationId}/repositories/${repositoryId}/discovery/recheck`,
    DashboardQueuedResponse,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: "{}",
    },
  );
}
export async function uninstallOrganizationGithub(organizationId: string) {
  return request(`/api/organizations/${organizationId}/github/uninstall`, DashboardOkResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: "{}",
  });
}
export async function beginControlPlaneSetup(input: ControlPlaneSetupRequest) {
  return request("/api/setup/github-app", DashboardManifestResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function beginOnboardingGithubManifest(input: { organizationId: string }) {
  return request("/api/github/app/manifest", DashboardManifestResponse, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function createOnboardingPool(input: CreatePoolRequest & { organizationId: string }) {
  return request("/api/organizations/" + input.organizationId + "/pools", DashboardPoolCreateResponse, {
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
