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
  ApproveOnboardingRepositoriesRequest,
  CreatePoolRequest,
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

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
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

const meResponse = z.unknown();
export const getMe = () => request("/api/me", meResponse);
export const getOrganizations = () => request("/api/organizations", z.array(OrganizationSummary));
export const getOverview = (organizationId: string, period = "24h" as const) =>
  request(`/api/organizations/${organizationId}/overview?period=${period}`, OverviewDto);
export const getRuns = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/runs`, CursorPage(RunSummary));
export const getRun = (organizationId: string, runId: string) =>
  request(`/api/organizations/${organizationId}/runs/${runId}`, RunDetail);
export const getLogs = (organizationId: string, runId: string, jobId: string) =>
  request(`/api/organizations/${organizationId}/runs/${runId}/jobs/${jobId}/logs`, CursorPage(LogChunk));
export const getRepositories = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/repositories`, CursorPage(RepositorySummary));
export const getWorkers = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/workers`, CursorPage(WorkerDetail));

export async function mutateWorker(organizationId: string, workerId: string, action: "adopt" | "reject" | "drain" | "rotate-key" | "remove"): Promise<{ ok: boolean }> {
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
  organizationId: string;
  appliance: z.infer<typeof WorkerConfiguration>["appliance"];
  runtime: z.infer<typeof WorkerConfiguration>["runtime"];
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
export const getPools = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/pools`, CursorPage(PoolSummary));
export const getSettings = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/settings`, OrganizationSettings);
export async function setRepositoryApproval(organizationId: string, repositoryId: string, approved: boolean) {
  return request(`/api/organizations/${organizationId}/repositories/${repositoryId}/${approved ? "approve" : "reject"}`, z.object({ ok: z.boolean() }), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({}),
  });
}
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
const onboardingStatusResponse = z.custom<OnboardingStatus>();
const onboardingDetailResponse = z.custom<OnboardingDetail>();
export const getOnboardingStatus = () => request("/api/onboarding/status", onboardingStatusResponse, { cache: "no-store" });
export const getOnboardingDetail = () => request("/api/onboarding", onboardingDetailResponse, { cache: "no-store" });
export async function selectOnboardingWorker(input: SelectOnboardingWorkerRequest) {
  return request("/api/onboarding/worker", z.object({ ok: z.boolean() }), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
export async function approveOnboardingRepositories(input: ApproveOnboardingRepositoriesRequest) {
  return request("/api/onboarding/repositories", z.object({ ok: z.boolean() }), {
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
    body: JSON.stringify({ workerId: input.workerId, name: input.name, resources: input.resources, triggerLabel: input.triggerLabel, imageDigest: input.imageDigest }),
  });
}
