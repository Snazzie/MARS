import {
  ApiError,
  CursorPage,
  LogChunk,
  OrganizationSummary,
  OverviewDto,
  RepositorySummary,
  RunDetail,
  RunSummary,
  WorkerDetail,
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
export const getPools = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/pools`, z.unknown());
export const getSettings = (organizationId: string) =>
  request(`/api/organizations/${organizationId}/settings`, z.unknown());

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "unauthorized";
}

export function isOffline(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "offline";
}
