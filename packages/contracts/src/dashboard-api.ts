import { z } from "zod";
import {
  ApiError,
  CursorPage,
  OrganizationSettings,
  OrganizationSummary,
  OverviewDto,
  PoolSummary,
  RepositorySummary,
  RunDetail,
  RunSummary,
  WorkerDetail,
  JobTimingSnapshot,
  JobTimingAggregate,
  JobResourceSample,
  JobResourceTrendSort,
  JobResourceTrendPoint,
  JobResourceTrendJob,
  JobResourceTrendResponse,
  JobLabelRecommendation,
  JobLabelRecommendationQuery,
  LogChunk,
  CreatePoolRequest,
  RunnerWorkflowFile,
  RunnerWorkflowPreview,
  RunnerWorkflowPrRequest,
  RunnerWorkflowPrResult,
} from "./dashboard.ts";
import { ApproveWorkerRequest, PendingWorkerRequest, WorkerConfiguration, WorkerImageBuildSpec } from "./orchestration.ts";
import {
  OnboardingDetail,
  OnboardingStatus,
  SelectOnboardingWorkerRequest,
  StartOnboardingVerificationRequest,
  StartOnboardingVerificationResult,
  VerifyOnboardingRepositoriesResult,
} from "./onboarding.ts";

export const DashboardOperator = z.object({
  id: z.string().min(1),
  githubUserId: z.number().int(),
  login: z.string().min(1),
  isGlobalAdmin: z.boolean(),
}).strict();
export type DashboardOperator = z.infer<typeof DashboardOperator>;
export const DashboardPoolMutationResponse = z.object({ id: z.string().uuid(), labels: z.array(z.string()) }).strict();
export type DashboardPoolMutationResponse = z.infer<typeof DashboardPoolMutationResponse>;

export const DashboardHealthResponse = z.object({
  ok: z.boolean(),
  discovery: z.object({ stale: z.boolean(), lastSuccessAt: z.string().nullable() }).passthrough(),
}).passthrough();
export type DashboardHealthResponse = z.infer<typeof DashboardHealthResponse>;

export const DashboardOkResponse = z.object({ ok: z.boolean() }).strict();
export type DashboardOkResponse = z.infer<typeof DashboardOkResponse>;

export const DashboardWorkerMutationResponse = z.object({
  revision: z.string(),
  fingerprint: z.string(),
  commandId: z.string().uuid().optional(),
}).strict();
export type DashboardWorkerMutationResponse = z.infer<typeof DashboardWorkerMutationResponse>;
export const DashboardLocationResponse = z.object({ location: z.string().url() }).strict();
export type DashboardLocationResponse = z.infer<typeof DashboardLocationResponse>;
export const DashboardManifestResponse = z.object({ action: z.string().url(), manifest: z.string() }).strict();
export type DashboardManifestResponse = z.infer<typeof DashboardManifestResponse>;
export const DashboardPoolCreateResponse = z.object({ id: z.string().uuid().optional() }).passthrough();
export type DashboardPoolCreateResponse = z.infer<typeof DashboardPoolCreateResponse>;
export const DashboardPendingWorkerResponse = z.array(z.object({ id: z.string().uuid(), fingerprint: z.string().min(1) }).merge(PendingWorkerRequest));
export const DashboardQueuedResponse = z.object({ queued: z.literal(true) }).strict();

export const DashboardBuildWorkerResponse = z.object({ buildId: z.string().uuid() }).strict();
export type DashboardBuildWorkerResponse = z.infer<typeof DashboardBuildWorkerResponse>;

export const DashboardBootstrapStatus = z.object({
  initialized: z.boolean(),
  generation: z.number().nullable(),
  createdAt: z.string().nullable(),
  rotatedAt: z.string().nullable(),
}).strict();
export type DashboardBootstrapStatus = z.infer<typeof DashboardBootstrapStatus>;

export const DashboardBootstrapReveal = z.object({
  code: z.string().min(1),
  generation: z.number(),
  createdAt: z.string(),
}).strict();
export type DashboardBootstrapReveal = z.infer<typeof DashboardBootstrapReveal>;

export const DashboardEndpoint = <Req extends z.ZodTypeAny | undefined, Res extends z.ZodTypeAny>(request: Req, response: Res) => ({ request, response });
export type DashboardEndpoint<Req extends z.ZodTypeAny | undefined, Res extends z.ZodTypeAny> = {
  request: Req;
  response: Res;
};

export {
  ApiError,
  ApproveWorkerRequest,
  CursorPage,
  CreatePoolRequest,
  DashboardHealthResponse as HealthResponse,
  JobLabelRecommendation,
  JobLabelRecommendationQuery,
  JobResourceSample,
  JobResourceTrendJob,
  JobResourceTrendPoint,
  JobResourceTrendResponse,
  JobResourceTrendSort,
  JobTimingAggregate,
  JobTimingSnapshot,
  LogChunk,
  OnboardingDetail,
  OnboardingStatus,
  OrganizationSettings,
  OrganizationSummary,
  OverviewDto,
  PendingWorkerRequest,
  PoolSummary,
  RepositorySummary,
  RunDetail,
  RunSummary,
  RunnerWorkflowFile,
  RunnerWorkflowPreview,
  RunnerWorkflowPrRequest,
  RunnerWorkflowPrResult,
  SelectOnboardingWorkerRequest,
  StartOnboardingVerificationRequest,
  StartOnboardingVerificationResult,
  VerifyOnboardingRepositoriesResult,
  WorkerConfiguration,
  WorkerDetail,
  WorkerImageBuildSpec,
};
