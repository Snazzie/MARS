import { Hono, type Context } from "hono";
import { and, desc, eq, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { defineQueries, schema } from "@mars/db";
const routeQueries = defineQueries(db => ({
  membership: db.select({ allowed: sql`1` }).from(schema.memberships).where(and(eq(schema.memberships.userId, sql.placeholder("userId")), eq(schema.memberships.organizationId, sql.placeholder("organizationId")))).prepare("route_membership"),
  worker: db.select({ id: schema.workers.id }).from(schema.workers).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("route_worker"),
  purgeWorker: db.select({ id: schema.workers.id, admissionState: schema.workers.admissionState }).from(schema.workers).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("route_purge_worker"),
  preserveLeases: db.update(schema.workers).set({ preserveLeases: sql`${sql.placeholder("enabled")}` }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("route_preserve_leases"),
  requeuePreservedLeases: db.update(schema.runnerLeases).set({ cleanupState: "pending" }).where(and(eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), eq(schema.runnerLeases.state, "failed"), eq(schema.runnerLeases.cleanupState, "debug_preserved"))).prepare("route_requeue_preserved_leases"),
  rejectWorker: db.update(schema.workers).set({ admissionState: "rejected" }).where(and(eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.admissionState, "pending"))).prepare("route_reject_worker"),
  drainWorker: db.update(schema.workers).set({ draining: true }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("route_drain_worker"),
  resumeWorker: db.update(schema.workers).set({ draining: false }).where(and(eq(schema.workers.id, sql.placeholder("workerId")), eq(schema.workers.admissionState, "adopted"), eq(schema.workers.configurationState, "ready"))).prepare("route_resume_worker"),
  activeWorkerLease: db.select({ id: schema.runnerLeases.id }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.workerId, sql.placeholder("workerId")), notInArray(schema.runnerLeases.state, ["reaped", "failed", "expired", "completed"]))).limit(1).prepare("route_active_worker_lease"),
  removeWorkerDrain: db.update(schema.workers).set({ draining: true }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("route_remove_worker_drain"),
  removeWorkerPools: db.update(schema.runnerPools).set({ enabled: false }).where(eq(schema.runnerPools.workerId, sql.placeholder("workerId"))).prepare("route_remove_worker_pools"),
  removeWorkerRevoke: db.update(schema.workers).set({ admissionState: "revoked" }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("route_remove_worker_revoke"),
  removeWorkerAudit: db.insert(schema.auditEvents).values({ actor: sql.placeholder("actor"), type: "worker.removed", payload: sql`${sql.placeholder("payload")}::jsonb` }).prepare("route_remove_worker_audit"),
  poolWorker: db.select({ platform: schema.workers.platform, contractVersion: schema.workers.contractVersion, limits: schema.workers.limits, guestPlatforms: schema.workers.guestPlatforms, admissionState: schema.workers.admissionState, configurationState: schema.workers.configurationState, configurationRevision: schema.workers.configurationRevision, appliedConfigurationRevision: schema.workers.appliedConfigurationRevision, desiredConfiguration: schema.workers.desiredConfiguration, lastDoctorAt: schema.workers.doctorObservedAt, doctor: schema.workers.doctor }).from(schema.workers).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("route_pool_worker"),
  globalPoolDuplicate: db.select({ id: schema.runnerPools.id }).from(schema.runnerPools).where(and(isNull(schema.runnerPools.organizationId), or(eq(schema.runnerPools.name, sql.placeholder("name")), eq(schema.runnerPools.triggerLabel, sql.placeholder("triggerLabel"))))).limit(1).prepare("route_global_pool_duplicate"),
  globalPoolDuplicateOther: db.select({ id: schema.runnerPools.id }).from(schema.runnerPools).where(and(isNull(schema.runnerPools.organizationId), ne(schema.runnerPools.id, sql.placeholder("poolId")), or(eq(schema.runnerPools.name, sql.placeholder("name")), eq(schema.runnerPools.triggerLabel, sql.placeholder("triggerLabel"))))).limit(1).prepare("route_global_pool_duplicate_other"),
  globalPoolCreate: db.insert(schema.runnerPools).values({ organizationId: null, workerId: null, name: sql.placeholder("name"), platform: sql.placeholder("platform"), driver: sql.placeholder("driver"), imageDigest: sql.placeholder("imageDigest"), resources: sql.placeholder("resources"), cpuMode: sql.placeholder("cpuMode"), labels: sql.placeholder("labels"), triggerLabel: sql.placeholder("triggerLabel"), enabled: sql.placeholder("enabled") }).returning({ id: schema.runnerPools.id }).prepare("route_global_pool_create"),
  globalPoolEditInfo: db.select({ id: schema.runnerPools.id, enabled: schema.runnerPools.enabled, active: sql<number>`(${db.select({ count: sql<number>`count(*)::int` }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.poolId, schema.runnerPools.id), ne(schema.runnerLeases.state, "reaped")))})` }).from(schema.runnerPools).where(and(eq(schema.runnerPools.id, sql.placeholder("poolId")), isNull(schema.runnerPools.organizationId))).prepare("route_global_pool_edit_info"),
  globalPoolUpdate: db.update(schema.runnerPools).set({ name: sql`${sql.placeholder("name")}`, platform: sql`${sql.placeholder("platform")}`, driver: sql`${sql.placeholder("driver")}`, imageDigest: sql`${sql.placeholder("imageDigest")}`, resources: sql`${sql.placeholder("resources")}::jsonb`, cpuMode: sql`${sql.placeholder("cpuMode")}`, labels: sql`${sql.placeholder("labels")}::jsonb`, triggerLabel: sql`${sql.placeholder("triggerLabel")}` }).where(and(eq(schema.runnerPools.id, sql.placeholder("poolId")), isNull(schema.runnerPools.organizationId))).prepare("route_global_pool_update"),
  globalPoolDelete: db.delete(schema.runnerPools).where(and(eq(schema.runnerPools.id, sql.placeholder("poolId")), isNull(schema.runnerPools.organizationId))).prepare("route_global_pool_delete"),
  globalPoolInfo: db.select({ id: schema.runnerPools.id, platform: schema.runnerPools.platform, driver: schema.runnerPools.driver, imageDigest: schema.runnerPools.imageDigest, cpuMode: schema.runnerPools.cpuMode, resources: schema.runnerPools.resources }).from(schema.runnerPools).where(and(eq(schema.runnerPools.id, sql.placeholder("poolId")), isNull(schema.runnerPools.organizationId))).prepare("route_global_pool_info"),
  enableWorkers: db.select({ id: schema.workers.id, platform: schema.workers.platform, limits: schema.workers.limits, contractVersion: schema.workers.contractVersion }).from(schema.workers).where(sql`${schema.workers.admissionState}='adopted' AND ${schema.workers.configurationState}='ready' AND ${schema.workers.configurationRevision}=${schema.workers.appliedConfigurationRevision} AND ${schema.workers.draining}=false AND ${schema.workers.lastHeartbeatAt}>now()-interval '60 seconds' AND ${schema.workers.doctorObservedAt}>now()-interval '60 seconds' AND ${sql.placeholder("platform")}=ANY(SELECT jsonb_array_elements_text(${schema.workers.guestPlatforms})) AND ${sql.placeholder("driver")}=${schema.workers.desiredConfiguration}->>'selectedDriver' AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(CASE WHEN jsonb_typeof(${schema.workers.doctor}->'doctor')='object' THEN ${schema.workers.doctor}->'doctor' ELSE ${schema.workers.doctor} END->'capabilities')='array' THEN CASE WHEN jsonb_typeof(${schema.workers.doctor}->'doctor')='object' THEN ${schema.workers.doctor}->'doctor' ELSE ${schema.workers.doctor} END->'capabilities' ELSE '[]'::jsonb END) capability WHERE capability->>'driver'=${sql.placeholder("driver")} AND capability->>'guestPlatform'=${sql.placeholder("platform")} AND capability->>'ready'='true')`).prepare("route_enable_workers"),
  globalPoolSetEnabled: db.update(schema.runnerPools).set({ enabled: sql`${sql.placeholder("enabled")}` }).where(and(eq(schema.runnerPools.id, sql.placeholder("poolId")), isNull(schema.runnerPools.organizationId))).prepare("route_global_pool_set_enabled"),
  organizationPoolWorker: db.select({ platform: schema.workers.platform, contractVersion: schema.workers.contractVersion, guestPlatforms: schema.workers.guestPlatforms, admissionState: schema.workers.admissionState, configurationState: schema.workers.configurationState, configurationRevision: schema.workers.configurationRevision, appliedConfigurationRevision: schema.workers.appliedConfigurationRevision, desiredConfiguration: schema.workers.desiredConfiguration, lastDoctorAt: schema.workers.doctorObservedAt, draining: schema.workers.draining, limits: schema.workers.limits, doctor: schema.workers.doctor }).from(schema.workers).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("route_org_pool_worker"),
  orgPoolDuplicate: db.select({ id: schema.runnerPools.id, name: schema.runnerPools.name, triggerLabel: schema.runnerPools.triggerLabel, enabled: schema.runnerPools.enabled, cpuMode: schema.runnerPools.cpuMode, resources: schema.runnerPools.resources }).from(schema.runnerPools).where(and(isNull(schema.runnerPools.organizationId), or(eq(schema.runnerPools.name, sql.placeholder("name")), eq(schema.runnerPools.triggerLabel, sql.placeholder("triggerLabel"))))).prepare("route_org_pool_duplicate"),
  orgPoolExisting: db.select({ id: schema.runnerPools.id, enabled: schema.runnerPools.enabled, cpuMode: schema.runnerPools.cpuMode, resources: schema.runnerPools.resources }).from(schema.runnerPools).where(and(eq(schema.runnerPools.id, sql.placeholder("poolId")), isNull(schema.runnerPools.organizationId))).prepare("route_org_pool_existing"),
  poolActiveLease: db.select({ id: schema.runnerLeases.id }).from(schema.runnerLeases).where(and(eq(schema.runnerLeases.poolId, sql.placeholder("poolId")), ne(schema.runnerLeases.state, "reaped"))).limit(1).prepare("route_pool_active_lease"),
  orgPoolUpdate: db.update(schema.runnerPools).set({ workerId: null, platform: sql`${sql.placeholder("platform")}`, driver: sql`${sql.placeholder("driver")}`, imageDigest: sql`${sql.placeholder("imageDigest")}`, resources: sql`${sql.placeholder("resources")}::jsonb`, cpuMode: sql`${sql.placeholder("cpuMode")}`, labels: sql`${sql.placeholder("labels")}::jsonb`, name: sql`${sql.placeholder("name")}`, triggerLabel: sql`${sql.placeholder("triggerLabel")}`, enabled: true }).where(eq(schema.runnerPools.id, sql.placeholder("poolId"))).prepare("route_org_pool_update"),
  orgPoolCreate: db.insert(schema.runnerPools).values({ organizationId: null, workerId: null, name: sql.placeholder("name"), platform: sql.placeholder("platform"), driver: sql.placeholder("driver"), imageDigest: sql.placeholder("imageDigest"), resources: sql.placeholder("resources"), cpuMode: sql.placeholder("cpuMode"), labels: sql.placeholder("labels"), triggerLabel: sql.placeholder("triggerLabel"), enabled: true }).returning({ id: schema.runnerPools.id }).prepare("route_org_pool_create"),
  poolAudit: db.insert(schema.auditEvents).values({ organizationId: null, actor: sql.placeholder("actor"), type: "pool.created", payload: sql`${sql.placeholder("payload")}::jsonb` }).prepare("route_pool_audit"),
  orgPoolSetEnabled: db.update(schema.runnerPools).set({ enabled: sql`${sql.placeholder("enabled")}` }).where(and(eq(schema.runnerPools.organizationId, sql.placeholder("organizationId")), eq(schema.runnerPools.id, sql.placeholder("poolId")))).prepare("route_org_pool_set_enabled"),
  githubConnection: db.select({ login: schema.organizations.login, githubAccountType: schema.organizations.githubAccountType, githubInstallationId: schema.dashboardInstallations.githubInstallationId }).from(schema.organizations).leftJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.organizationId, schema.organizations.id), ne(schema.dashboardInstallations.state, "suspended"))).where(eq(schema.organizations.id, sql.placeholder("organizationId"))).orderBy(sql`${schema.dashboardInstallations.createdAt} DESC NULLS LAST`).limit(1).prepare("route_github_connection"),
  githubInstallation: db.select({ githubInstallationId: schema.dashboardInstallations.githubInstallationId }).from(schema.dashboardInstallations).where(and(eq(schema.dashboardInstallations.organizationId, sql.placeholder("organizationId")), ne(schema.dashboardInstallations.state, "suspended"))).orderBy(desc(schema.dashboardInstallations.createdAt)).limit(1).prepare("route_github_installation"),
  githubLocation: db.select({ login: schema.organizations.login, githubAccountType: schema.organizations.githubAccountType, githubInstallationId: schema.dashboardInstallations.githubInstallationId }).from(schema.organizations).innerJoin(schema.dashboardInstallations, eq(schema.dashboardInstallations.organizationId, schema.organizations.id)).where(eq(schema.organizations.id, sql.placeholder("organizationId"))).orderBy(desc(schema.dashboardInstallations.createdAt)).limit(1).prepare("route_github_location"),
  githubRepositoryLocation: db.select({ login: schema.organizations.login, githubAccountType: schema.organizations.githubAccountType, githubInstallationId: schema.dashboardInstallations.githubInstallationId }).from(schema.organizations).innerJoin(schema.dashboardRepositories, eq(schema.dashboardRepositories.organizationId, schema.organizations.id)).innerJoin(schema.dashboardInstallations, eq(schema.dashboardInstallations.id, schema.dashboardRepositories.installationId)).where(and(eq(schema.organizations.id, sql.placeholder("organizationId")), eq(schema.dashboardRepositories.id, sql.placeholder("repositoryId")), eq(schema.dashboardRepositories.available, true), ne(schema.dashboardInstallations.state, "suspended"))).prepare("route_github_repository_location"),
  insertMutation: db.insert(schema.dashboardMutations).values({ organizationId: sql.placeholder("organizationId"), idempotencyKey: sql.placeholder("key") }).onConflictDoNothing().returning({ idempotencyKey: schema.dashboardMutations.idempotencyKey }).prepare("route_insert_mutation"),
  priorMutation: db.select({ response: schema.dashboardMutations.response }).from(schema.dashboardMutations).where(and(eq(schema.dashboardMutations.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardMutations.idempotencyKey, sql.placeholder("key")))).prepare("route_prior_mutation"),
  saveMutationResponse: db.update(schema.dashboardMutations).set({ response: sql`${sql.placeholder("response")}::jsonb` }).where(and(eq(schema.dashboardMutations.organizationId, sql.placeholder("organizationId")), eq(schema.dashboardMutations.idempotencyKey, sql.placeholder("key")))).prepare("route_save_mutation_response"),
  failureAnalysisRepository: db.select({ id: schema.dashboardRepositories.id }).from(schema.dashboardRepositories).where(and(eq(schema.dashboardRepositories.id, sql.placeholder("repositoryId")), eq(schema.dashboardRepositories.organizationId, sql.placeholder("organizationId")))).limit(1).prepare("route_failure_analysis_repository"),
  failureAnalysisSettings: db.select({ enabled: schema.repositoryFailureAnalysisSettings.enabled, providerId: schema.repositoryFailureAnalysisSettings.providerId, enabledSince: schema.repositoryFailureAnalysisSettings.enabledSince }).from(schema.repositoryFailureAnalysisSettings).where(eq(schema.repositoryFailureAnalysisSettings.repositoryId, sql.placeholder("repositoryId"))).limit(1).prepare("route_failure_analysis_settings"),
  failureAnalysisProvider: db.select({ id: schema.llmProviders.id }).from(schema.llmProviders).where(eq(schema.llmProviders.id, sql.placeholder("providerId"))).limit(1).prepare("route_failure_analysis_provider"),
  failureAnalysisUpsert: db.insert(schema.repositoryFailureAnalysisSettings).values({ organizationId: sql.placeholder("organizationId"), repositoryId: sql.placeholder("repositoryId"), enabled: sql.placeholder("enabled"), providerId: sql.placeholder("providerId"), enabledSince: sql`${sql.placeholder("enabledSince")}`, updatedAt: sql`now()` }).onConflictDoUpdate({ target: schema.repositoryFailureAnalysisSettings.repositoryId, set: { enabled: sql`${sql.placeholder("enabled")}`, providerId: sql`${sql.placeholder("providerId")}`, enabledSince: sql`${sql.placeholder("enabledSince")}`, updatedAt: sql`now()` } }).returning({ enabled: schema.repositoryFailureAnalysisSettings.enabled, providerId: schema.repositoryFailureAnalysisSettings.providerId, enabledSince: schema.repositoryFailureAnalysisSettings.enabledSince }).prepare("route_failure_analysis_upsert"),
}));
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { listOrganizations, listAllOrganizations, getOverview, getAllOverview, getGithubRunnerCostCenter, listRepositories, listAllRepositories, listRuns, listAllRuns, getRunDetail, listLogChunks, listStepLogChunks, listWorkers, listAllWorkers, getWorkerDetail, listPools, listAllPools, listGlobalPools, dashboardMutation, invalidateDashboard, completeOnboardingIfReady, queueRepositoryDiscoveryRecheck, listJobTimingHistory, getJobTimingAggregates, listJobResourceTrends, JobResourceTrendInputError, listJobResourceSamples, listWorkerCacheEntries, decodeWorkerCacheCursor, getWorkerHealth, getJobLabelRecommendation, selectRoutingLabel } from "@mars/db";
import { adoptWorker, renameWorker } from "../workers.ts";
import { configurePendingWorker, purgeWorkerRunnerCache } from "../worker-requests.ts";
import { discoverWorkflowFiles } from "../workflow-pr.ts";
import { ApiError, CostCenterDto, CostCenterPricingProvider, DashboardWorkerCachePage, DashboardWorkerMutationResponse, OverviewDto, CursorPage, OrganizationSummary, RepositorySummary, RunSummary, RunDetail, LogChunk, WorkerDetail, PoolSummary, CreatePoolRequest, WorkerConfiguration, RunnerWorkflowFile, RunnerWorkflowPreview, RunnerWorkflowPrRequest, RunnerWorkflowPrResult, JobTimingSnapshot, JobTimingAggregate, JobResourceTrendResponse, JobResourceTrendSort, JobResourceSample, WorkerHealth, JobLabelRecommendation, JobLabelRecommendationQuery, GithubConnectionSummary, GithubRateLimitStats, WorkerEventPayload, WorkerUpgradeStatus, RuntimePlatform, RuntimeDriverName, selectedRuntimeDriver } from "@mars/contracts";
import { supportsExclusiveCpuPlacement } from "@mars/contracts";
import { WorkerDispatchError } from "../worker-dispatch.ts";
import { WorkerReleaseCatalogUnavailable } from "../worker-release.ts";
import { workerPoolEvidence } from "../worker-evidence.ts";
import { getLiveDispatchPools } from "../job-reconciler.ts";
const jsonNumber = (value: unknown, key: string): number => value !== null && typeof value === "object" && key in value ? Number((value as Record<string, unknown>)[key]) : Number.NaN;
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
  includeInactive: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  search: z.string().max(200).default(""),
  availability: z.enum(["available", "unavailable"]).optional(),
  visibility: z.enum(["public", "private", "internal"]).optional(),
}).strict();
const runsQuerySchema = querySchema.pick({ limit: true, cursor: true, search: true }).extend({
  from: z.string().datetime({ offset: true }).optional(),
  runner: z.enum(["all", "mars", "external"]).default("all"),
}).strict();
const periodSchema = z.enum(["24h", "7d", "30d"]);
const timingQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), repositoryId: z.string().uuid().optional(), workflow: z.string().max(200).optional(), jobName: z.string().max(200).optional(), platform: z.string().max(100).optional(), driver: z.string().max(100).optional(), vcpu: z.coerce.number().int().positive().optional(), concurrency: z.coerce.number().int().positive().optional(), outcome: z.enum(["success", "failure", "cancelled", "skipped", "neutral"]).optional() }).strict();
const unixOrDateTimeSchema = z.preprocess((value) => {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return value;
  const seconds = Number(value);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return value;
  return new Date(milliseconds).toISOString();
}, z.string().datetime({ offset: true }));
const jobResourceTrendQuerySchema = z.object({
  from: unixOrDateTimeSchema,
  to: unixOrDateTimeSchema,
  platform: z.string().max(100).optional(),
  workerId: z.string().uuid().optional(),
  vcpu: z.coerce.number().int().positive().optional(),
  concurrency: z.coerce.number().int().positive().optional(),
  search: z.string().max(200).default(""),
  sort: JobResourceTrendSort.default("latest"),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  jobKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  pointLimit: z.coerce.number().int().min(2).max(200).default(100),
}).strict().superRefine((value, ctx) => {
  const from = Date.parse(value.from), to = Date.parse(value.to);
  if (from >= to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be after from" });
  if (to - from > 90 * 24 * 60 * 60 * 1000) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "range must not exceed 90 days" });
});
const logSchema = z.object({ after: z.coerce.number().int().min(-1).default(-1), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();
const controlPlaneLogQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  level: z.enum(["log", "warn", "error"]).optional(),
  contains: z.string().max(200).optional(),
}).strict();
const workerLogQuerySchema = z.object({
  maxBytes: z.coerce.number().int().min(1).max(128 * 1024).default(64 * 1024),
}).strict();
const mutationSchema = z.object({}).strict();
const workerNameSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();

function error(c: any, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return c.json(ApiError.parse({ code, message, requestId: c.req.header("x-request-id") || crypto.randomUUID(), ...(details ? { details } : {}) }), status, { "cache-control": "no-store" });
}
function githubWorkflowPermissionError(c: Context<ControlPlaneEnv>) { return error(c, 409, "github_app_permissions_missing", "GitHub App needs Contents and Pull requests write permissions. Update and approve the app permissions, then refresh."); }
function parseQuery(c: any) { const parsed = querySchema.safeParse(c.req.query()); return parsed.success ? parsed.data : error(c, 400, "invalid_query", "Invalid query parameters", { issues: parsed.error.issues }); }
function requireMutation(c: any) { return c.req.header("idempotency-key")?.trim() ? null : error(c, 400, "missing_idempotency_key", "Idempotency-Key is required"); }
async function member(db: any, user: any, organizationId: string) { if (user.isGlobalAdmin) return true; const [row] = await routeQueries(db).membership.execute({ userId: user.id, organizationId }); return Boolean(row); }
async function guard(c: any, deps: ControlPlaneHttpDeps, organizationId: string) { return await member(deps.db, c.get("user"), organizationId) ? null : error(c, 404, "not_found", "Resource not found"); }
function githubInstallationLocation(row: { login?: unknown; githubInstallationId?: unknown; githubAccountType?: unknown }) {
  if (row.githubInstallationId == null || !Number.isSafeInteger(Number(row.githubInstallationId))) return null;
  const installationId = Number(row.githubInstallationId);
  if (row.githubAccountType === "User") return `https://github.com/settings/installations/${installationId}`;
  if (typeof row.login !== "string" || !row.login) return null;
  return `https://github.com/organizations/${encodeURIComponent(row.login)}/settings/installations/${installationId}`;
}

export function registerDashboardRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const safe = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { try { return await fn(c); } catch (cause) { if (cause instanceof z.ZodError) return error(c, 400, "invalid_request", "Invalid request", { issues: cause.issues }); console.error(cause); return error(c, 500, "internal_error", "Internal server error"); } };
  const providerUnavailable = (c: any) => error(c, 503, "llm_unavailable", "LLM provider service is unavailable");
  app.get("/api/admin/llm/providers", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.llmProviders) return providerUnavailable(c);
    return c.json(await deps.llmProviders.list(), 200, { "cache-control": "no-store" });
  }));
  app.post("/api/admin/llm/providers", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.llmProviders) return providerUnavailable(c);
    const body = z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(["openai-compatible", "anthropic"]), baseUrl: z.string().url(), model: z.string().trim().min(1).max(200), apiKey: z.string().nullable().optional() }).strict().parse(await c.req.json());
    try { return c.json(await deps.llmProviders.save(body), 201, { "cache-control": "no-store" }); }
    catch (cause) { if (cause instanceof Error && ["llm_auth_failed", "llm_invalid_provider_url"].includes(cause.message)) return error(c, 400, cause.message, "Provider configuration is invalid"); throw cause; }
  }));
  app.put("/api/admin/llm/providers/:providerId", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.llmProviders) return providerUnavailable(c);
    const body = z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(["openai-compatible", "anthropic"]), baseUrl: z.string().url(), model: z.string().trim().min(1).max(200), apiKey: z.string().nullable().optional() }).strict().parse(await c.req.json());
    try { return c.json(await deps.llmProviders.save(body, c.req.param("providerId")), 200, { "cache-control": "no-store" }); }
    catch (cause) { if (cause instanceof Error && cause.message === "llm_provider_not_found") return error(c, 404, "not_found", "Provider not found"); if (cause instanceof Error && ["llm_auth_failed", "llm_invalid_provider_url"].includes(cause.message)) return error(c, 400, cause.message, "Provider configuration is invalid"); throw cause; }
  }));
  app.delete("/api/admin/llm/providers/:providerId", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.llmProviders) return providerUnavailable(c);
    try { await deps.llmProviders.delete(c.req.param("providerId")); return c.body(null, 204, { "cache-control": "no-store" }); }
    catch (cause) { if (cause instanceof Error && cause.message === "llm_provider_not_found") return error(c, 404, "not_found", "Provider not found"); if (cause instanceof Error && cause.message === "llm_provider_in_use") return error(c, 409, "llm_provider_in_use", "Provider is selected by a repository"); throw cause; }
  }));
  app.post("/api/admin/llm/providers/:providerId/test", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.llmProviders) return providerUnavailable(c);
    try { await deps.llmProviders.test(c.req.param("providerId")); return c.json({ ok: true }, 200, { "cache-control": "no-store" }); }
    catch (cause) { if (cause instanceof Error && cause.message === "llm_provider_not_found") return error(c, 404, "not_found", "Provider not found"); if (cause instanceof Error && /^llm_/.test(cause.message)) return error(c, 502, cause.message, "Provider test failed"); throw cause; }
  }));
  app.get("/api/organizations/:organizationId/repositories/:repositoryId/failure-analysis", safe(async (c) => {
    const organizationId = c.req.param("organizationId");
    const denied = await guard(c, deps, organizationId); if (denied) return denied;
    const repositoryId = c.req.param("repositoryId");
    const queries = routeQueries(deps.db);
    const [repository] = await queries.failureAnalysisRepository.execute({ organizationId, repositoryId });
    if (!repository) return error(c, 404, "not_found", "Resource not found");
    const [settings] = await queries.failureAnalysisSettings.execute({ repositoryId });
    return c.json({ organizationId, repositoryId, enabled: settings?.enabled ?? false, providerId: settings?.providerId ?? null, enabledSince: settings?.enabledSince ?? null }, 200, { "cache-control": "no-store" });
  }));
  app.put("/api/organizations/:organizationId/repositories/:repositoryId/failure-analysis", safe(async (c) => {
    const organizationId = c.req.param("organizationId");
    const denied = await guard(c, deps, organizationId); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const repositoryId = c.req.param("repositoryId");
    const queries = routeQueries(deps.db);
    const [repository] = await queries.failureAnalysisRepository.execute({ organizationId, repositoryId });
    if (!repository) return error(c, 404, "not_found", "Resource not found");
    const body = z.object({ enabled: z.boolean(), providerId: z.string().uuid().nullable() }).strict().parse(await c.req.json());
    if (body.enabled && !body.providerId) return error(c, 400, "invalid_request", "An enabled repository requires a provider");
    if (body.providerId && !(await queries.failureAnalysisProvider.execute({ providerId: body.providerId })).length) return error(c, 400, "invalid_request", "Provider does not exist");
    const [previous] = await queries.failureAnalysisSettings.execute({ repositoryId });
    const enabledSince = body.enabled ? (previous?.enabled ? previous.enabledSince : new Date().toISOString()) : null;
    const [saved] = await queries.failureAnalysisUpsert.execute({ organizationId, repositoryId, enabled: body.enabled, providerId: body.providerId, enabledSince });
    return c.json({ organizationId, repositoryId, enabled: saved.enabled, providerId: saved.providerId, enabledSince: saved.enabledSince }, 200, { "cache-control": "no-store" });
  }));
  app.get("/api/admin/logs", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.controlPlaneLogs) return error(c, 503, "logs_unavailable", "Control-plane logs are unavailable");
    const query = controlPlaneLogQuerySchema.safeParse(c.req.query());
    if (!query.success) return error(c, 400, "invalid_log_query", "Invalid log query", { issues: query.error.issues });
    return c.json(deps.controlPlaneLogs.list(query.data), 200, { "cache-control": "no-store" });
  }));
  app.get("/api/workers/:workerId/logs", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.workerDispatcher) return error(c, 503, "worker_dispatch_unavailable", "Worker command dispatch is unavailable");
    const query = workerLogQuerySchema.safeParse(c.req.query());
    if (!query.success) return error(c, 400, "invalid_log_query", "Invalid log query", { issues: query.error.issues });
    const workerId = c.req.param("workerId");
    const [worker] = await routeQueries(deps.db).worker.execute({ workerId });
    if (!worker) return error(c, 404, "not_found", "Resource not found");
    const requestId = randomUUID();
    try {
      const event = await deps.workerDispatcher.request({ workerId, type: "worker.collect_logs", leaseId: null, payload: { requestId, maxBytes: query.data.maxBytes } });
      const payload = WorkerEventPayload.safeParse({ type: event.type, payload: event.payload });
      if (!payload.success || payload.data.type !== "worker.logs" || payload.data.payload.requestId !== requestId) throw new WorkerDispatchError("worker returned an invalid log response");
      return c.json({ workerId, ...payload.data.payload }, 200, { "cache-control": "no-store" });
    } catch (cause) {
      if (!(cause instanceof WorkerDispatchError)) throw cause;
      if (cause.message === "worker is not authenticated") return error(c, 409, "worker_offline", "Worker is not connected");
      if (cause.message === "worker request timed out") return error(c, 504, "worker_log_timeout", "Worker log request timed out");
      return error(c, 502, "worker_log_failed", "Worker log request failed");
    }
  }));
  app.get("/api/me", (c) => c.json(c.get("user")));
  app.get("/api/organizations", safe(async (c) => {
    const user = c.get("user");
    const organizations = user.isGlobalAdmin
      ? await listAllOrganizations(deps.db, user.id)
      : await listOrganizations(deps.db, user.id);
    return c.json(OrganizationSummary.array().parse(organizations));
  }));
  app.get("/api/organizations/:organizationId/overview", safe(async (c) => {
    const org = c.req.param("organizationId");
    const period = periodSchema.safeParse(c.req.query("period") || "24h");
    if (!period.success) return error(c, 400, "invalid_period", "Invalid period", { issues: period.error.issues });
    const user = c.get("user");
    if (org === "all") {
      const data = await getAllOverview(deps.db, user.id, period.data);
      const organizationIds = deps.dispatchHealth ? (await listOrganizations(deps.db, user.id)).map(item => item.id) : [];
      const currentPools = deps.dispatchHealth ? await getLiveDispatchPools(deps.db, organizationIds, deps.workerConnected) : [];
      return c.json(OverviewDto.parse({ ...data, ...(deps.dispatchHealth ? { controlPlane: { ...deps.dispatchHealth(organizationIds), currentPools, currentPoolsObservedAt: new Date().toISOString() } } : {}) }));
    }
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    const data = await getOverview(deps.db, org, period.data);
    const currentPools = deps.dispatchHealth ? await getLiveDispatchPools(deps.db, [org], deps.workerConnected) : [];
    return c.json(OverviewDto.parse({ ...data, ...(deps.dispatchHealth ? { controlPlane: { ...deps.dispatchHealth([org]), currentPools, currentPoolsObservedAt: new Date().toISOString() } } : {}) }));
  }));
  app.get("/api/organizations/:organizationId/cost-center", safe(async (c) => { const org = c.req.param("organizationId"); const period = periodSchema.safeParse(c.req.query("period") || "24h"); const pricingProvider = CostCenterPricingProvider.safeParse(c.req.query("provider") || "github"); if (!period.success) return error(c, 400, "invalid_period", "Invalid period", { issues: period.error.issues }); if (!pricingProvider.success) return error(c, 400, "invalid_provider", "Invalid pricing provider", { issues: pricingProvider.error.issues }); if (org !== "all") { const denied = await guard(c, deps, org); if (denied) return denied; } const data = await getGithubRunnerCostCenter(deps.db, org, period.data, c.get("user").id, pricingProvider.data); return c.json(CostCenterDto.parse({ organizationId: org, period: period.data, ...data })); }));
  app.get("/api/organizations/:organizationId/repositories", safe(async (c) => {
    const org = c.req.param("organizationId");
    const q = parseQuery(c);
    if (q instanceof Response) return q;
    const filters = { search: q.search, availability: q.availability === undefined ? undefined : q.availability === "available", visibility: q.visibility };
    if (org === "all") return c.json(CursorPage(RepositorySummary).parse(await listAllRepositories(deps.db, c.get("user").id, q.limit, q.cursor ?? null, filters)));
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    return c.json(CursorPage(RepositorySummary).parse(await listRepositories(deps.db, org, q.limit, q.cursor ?? null, filters)));
  }));
  app.get("/api/organizations/:organizationId/runs", safe(async (c) => {
    const org = c.req.param("organizationId");
    const parsed = runsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return error(c, 400, "invalid_query", "Invalid run history query", { issues: parsed.error.issues });
    const q = parsed.data;
    const filters = { from: q.from, runner: q.runner };
    if (org === "all") return c.json(CursorPage(RunSummary).parse(await listAllRuns(deps.db, c.get("user").id, q.limit, q.cursor ?? null, q.search, filters)));
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    return c.json(CursorPage(RunSummary).parse(await listRuns(deps.db, org, q.limit, q.cursor ?? null, q.search, filters)));
  }));
  app.get("/api/organizations/:organizationId/job-timings", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    const parsed = timingQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return error(c, 400, "invalid_timing_query", "Invalid timing history query", { issues: parsed.error.issues });
    return c.json(CursorPage(JobTimingSnapshot).parse(await listJobTimingHistory(deps.db, org, parsed.data, c.get("user").id)));
  }));
  app.get("/api/organizations/:organizationId/job-timings/label-recommendation", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    const parsed = JobLabelRecommendationQuery.safeParse(c.req.query());
    if (!parsed.success) return error(c, 400, "invalid_label_recommendation_query", "Invalid label recommendation query", { issues: parsed.error.issues });
    const recommendation = await getJobLabelRecommendation(deps.db, org, parsed.data, c.get("user").id);
    if (recommendation.status !== "available" || typeof deps.githubApp?.resolveWorkflowJob !== "function") {
      return c.json(JobLabelRecommendation.parse(recommendation));
    }
    try {
      const target = await deps.githubApp.resolveWorkflowJob({
        organizationId: org,
        repositoryId: parsed.data.repositoryId,
        workflowName: parsed.data.workflowName,
        jobName: parsed.data.jobName,
      });
      const currentLabels = typeof target.currentRunsOn === "string" ? [target.currentRunsOn] : [...target.currentRunsOn];
      const currentRouting = selectRoutingLabel(currentLabels, recommendation.currentPlatform);
      if (!currentRouting) {
        return c.json(JobLabelRecommendation.parse({
          ...recommendation,
          status: "unavailable",
          currentLabels,
          currentRoutingLabel: null,
          currentPlatform: recommendation.currentPlatform,
          workflowPath: target.path,
          workflowJobId: target.jobId,
          recommendedVcpu: null,
          recommendedMemoryGiB: null,
          reason: "workflow_job_no_matching_route",
        }));
      }
      const recommendedVcpu = recommendation.p95CpuPeakPercent === null
        ? currentRouting.vcpu
        : recommendation.recommendedVcpu;
      const recommendedMemoryGiB = recommendation.p95MemoryPeakBytes === null
        ? currentRouting.memoryGiB
        : recommendation.recommendedMemoryGiB;
      return c.json(JobLabelRecommendation.parse({
        ...recommendation,
        currentLabels,
        currentRoutingLabel: currentRouting.original,
        currentPlatform: recommendation.currentPlatform,
        workflowPath: target.path,
        workflowJobId: target.jobId,
        recommendedVcpu,
        recommendedMemoryGiB,
      }));
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (code === "github_workflow_job_not_found" || code === "github_workflow_job_ambiguous" || code === "workflow_job_no_matching_route") {
        return c.json(JobLabelRecommendation.parse({
          ...recommendation,
          status: "unavailable",
          currentLabels: [],
          currentRoutingLabel: null,
          currentPlatform: recommendation.currentPlatform,
          workflowPath: null,
          workflowJobId: null,
          recommendedVcpu: null,
          recommendedMemoryGiB: null,
          reason: code === "workflow_job_no_matching_route" ? code : "workflow_job_not_resolved",
        }));
      }
      if (code === "github_rate_limited") return error(c, 500, "internal_error", "Internal server error");
      if (code === "github_repository_unavailable") return error(c, 404, "repository_unavailable", "Repository is unavailable");
      if (code === "github_403") return githubWorkflowPermissionError(c);
      if (code === "github_app_unconfigured") return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
      if (code === "github_runner_pool_missing") return error(c, 422, "runner_pool_missing", "Runner pool is not configured");
      throw cause;
    }
  }));
  app.get("/api/organizations/:organizationId/job-timings/aggregates", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    const parsed = timingQuerySchema.omit({ limit: true, cursor: true }).safeParse(c.req.query());
    if (!parsed.success) return error(c, 400, "invalid_timing_query", "Invalid timing aggregate query", { issues: parsed.error.issues });
    return c.json(JobTimingAggregate.array().parse(await getJobTimingAggregates(deps.db, org, parsed.data, c.get("user").id)));
  }));
  app.get("/api/organizations/:organizationId/job-resource-trends", safe(async (c) => {
    const org = c.req.param("organizationId");
    if (org !== "all") {
      const denied = await guard(c, deps, org);
      if (denied) return denied;
    }
    const parsed = jobResourceTrendQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return error(c, 400, "invalid_resource_trend_query", "Invalid job resource trend query", { issues: parsed.error.issues });
    try {
      return c.json(JobResourceTrendResponse.parse(await listJobResourceTrends(deps.db, org, parsed.data, c.get("user").id)));
    } catch (cause) {
      if (cause instanceof JobResourceTrendInputError) return error(c, 400, cause.code, cause.message);
      throw cause;
    }
  }));
  app.get("/api/organizations/:organizationId/pools", safe(async (c) => {
    const org = c.req.param("organizationId");
    const q = parseQuery(c);
    if (q instanceof Response) return q;
    if (org === "all") return c.json(CursorPage(PoolSummary).parse(await listAllPools(deps.db, c.get("user").id, q.limit)));
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    return c.json(CursorPage(PoolSummary).parse(await listPools(deps.db, org, q.limit)));
  }));
  app.post("/api/organizations/:organizationId/repositories/:repositoryId/discovery/recheck", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c);
    if (idem) return idem;
    const result = await queueRepositoryDiscoveryRecheck(deps.db, org, c.req.param("repositoryId"), c.req.header("idempotency-key")!.trim());
    if (result === "not_found") return error(c, 404, "not_found", "Resource not found");
    if (result === "not_paused") return error(c, 409, "repository_discovery_not_paused", "Repository discovery is not paused");
    await invalidateDashboard(deps.db, org, ["repositories"]);
    return c.json({ queued: true }, 202);
  }));
  app.get("/api/organizations/:organizationId/workers", safe(async (c) => { if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required"); const q = parseQuery(c); if (q instanceof Response) return q; return c.json(CursorPage(WorkerDetail).parse(await listAllWorkers(deps.db, c.get("user").id, q.limit, q.includeInactive, deps.workerConnected))); }));
  app.get("/api/workers/:workerId/upgrade", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const worker = await getWorkerDetail(deps.db, "all", c.req.param("workerId"), deps.workerConnected);
    if (!worker) return error(c, 404, "not_found", "Resource not found");
    if (!deps.workerUpgradeService) return error(c, 503, "worker_release_catalog_unavailable", "Worker release catalog is unavailable");
    try {
      return c.json(WorkerUpgradeStatus.parse(await deps.workerUpgradeService.suggest(worker)), { headers: { "Cache-Control": "no-store" } });
    } catch (cause) {
      if (cause instanceof WorkerReleaseCatalogUnavailable) return error(c, 503, "worker_release_catalog_unavailable", "Worker release catalog is unavailable");
      throw cause;
    }
  }));
  app.post("/api/workers/:workerId/configure", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const result = await configurePendingWorker(deps.db, c.req.param("workerId"), WorkerConfiguration.parse(await c.req.json()), c.get("user").id, deps.workerDispatcher, c.req.header("idempotency-key")!);
    await deps.onWorkerChanged(c.req.param("workerId"));
    return c.json(DashboardWorkerMutationResponse.parse(result));
  }));
  app.get("/api/organizations/:organizationId/runs/:runId", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const value=await getRunDetail(deps.db,org,c.req.param("runId")); return value?c.json(RunDetail.parse(value)):error(c,404,"not_found","Resource not found"); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/logs", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const q=logSchema.safeParse(c.req.query()); if(!q.success)return error(c,400,"invalid_log_bounds","Invalid log bounds",{issues:q.error.issues}); return c.json(CursorPage(LogChunk).parse(await listLogChunks(deps.db,org,c.req.param("runId"),c.req.param("jobId"),q.data.after,q.data.limit))); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/steps/:stepId/logs", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const q=logSchema.safeParse(c.req.query()); if(!q.success)return error(c,400,"invalid_log_bounds","Invalid log bounds",{issues:q.error.issues}); return c.json(CursorPage(LogChunk).parse(await listStepLogChunks(deps.db,org,c.req.param("runId"),c.req.param("jobId"),c.req.param("stepId"),q.data.after,q.data.limit))); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/resource-samples", safe(async (c) => { const org = c.req.param("organizationId"); const denied = await guard(c, deps, org); if (denied) return denied; const after = c.req.query("after"); const limit = Number(c.req.query("limit") ?? 100); if (after !== undefined && Number.isNaN(Date.parse(after))) return error(c, 400, "invalid_sample_cursor", "Invalid resource sample cursor"); if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(c, 400, "invalid_sample_limit", "Invalid resource sample limit"); return c.json(CursorPage(JobResourceSample).parse(await listJobResourceSamples(deps.db, org, c.req.param("runId"), c.req.param("jobId"), after ?? null, limit))); }));
  app.get("/api/organizations/:organizationId/workers/:workerId", safe(async(c)=>{if(!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");const value=await getWorkerDetail(deps.db,c.req.param("organizationId"),c.req.param("workerId"),deps.workerConnected);return value?c.json(WorkerDetail.parse(value)):error(c,404,"not_found","Resource not found");}));
  app.get("/api/workers/:workerId/cache", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const rawLimit = c.req.query("limit") ?? "50";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(c, 400, "invalid_cache_limit", "Invalid cache limit");
    const rawCursor = c.req.query("cursor");
    if (rawCursor !== undefined) {
      try { decodeWorkerCacheCursor(rawCursor); } catch { return error(c, 400, "invalid_cache_cursor", "Invalid cache cursor"); }
    }
    const query = c.req.query("query") ?? "";
    if (query.length > 200) return error(c, 400, "invalid_cache_query", "Invalid cache query");
    return c.json(DashboardWorkerCachePage.parse(await listWorkerCacheEntries(deps.db, c.req.param("workerId"), { cursor: rawCursor ?? null, limit, query })));
  }));
  app.post("/api/workers/:workerId/cache/purge", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    if (!deps.workerDispatcher) return error(c, 503, "worker_dispatch_unavailable", "Worker command dispatch is unavailable");
    const workerId = c.req.param("workerId");
    const [worker] = await routeQueries(deps.db).purgeWorker.execute({ workerId });
    if (!worker) return error(c, 404, "not_found", "Resource not found");
    if (!["pending", "adopted"].includes(worker.admissionState)) return error(c, 409, "worker_not_ready", "Worker is not available");
    const result = await purgeWorkerRunnerCache(deps.db, workerId, c.get("user").id, deps.workerDispatcher, c.req.header("idempotency-key")!.trim());
    return c.json(result, 202);
  }));
  app.get("/api/workers/:workerId/health", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const health = await getWorkerHealth(deps.db, c.req.param("workerId"), deps.workerConnected ?? (() => false));
    if (!health) return error(c, 404, "not_found", "Resource not found");
    const parsed = WorkerHealth.parse(health);
    if (c.req.query("configuration") === "1") return c.json(parsed, { headers: { "cache-control": "no-store" } });
    const { configuration: _configuration, ...legacyHealth } = parsed;
    return c.json(legacyHealth, { headers: { "cache-control": "no-store" } });
  }));
  app.post("/api/organizations/:organizationId/workers/:workerId/lease-preservation", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.workerDispatcher) return error(c, 503, "worker_dispatch_unavailable", "Worker command dispatch is unavailable");
    const organizationId = c.req.param("organizationId");
    const workerId = c.req.param("workerId");
    const worker = await getWorkerDetail(deps.db, organizationId, workerId);
    if (!worker) return error(c, 404, "not_found", "Resource not found");
    const body = z.object({ enabled: z.boolean() }).strict().parse(await c.req.json());
    const idem = requireMutation(c); if (idem) return idem;
    const key = c.req.header("idempotency-key")!;
    if (organizationId !== "all" && !(await dashboardMutation(deps.db, organizationId, key))) return c.json(WorkerDetail.parse(await getWorkerDetail(deps.db, organizationId, workerId)));
    await routeQueries(deps.db).preserveLeases.execute({ enabled: body.enabled, workerId });
    if (!body.enabled) await routeQueries(deps.db).requeuePreservedLeases.execute({ workerId });
    await deps.workerDispatcher.dispatch({ type: "worker.set_lease_preservation", workerId, leaseId: null, payload: { enabled: body.enabled } });
    if (organizationId !== "all") await invalidateDashboard(deps.db, organizationId, ["workers", workerId]);
    return c.json(WorkerDetail.parse(await getWorkerDetail(deps.db, organizationId, workerId)));
  }));
  app.post("/api/organizations/:organizationId/workers/:workerId/name", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const organizationId = c.req.param("organizationId");
    const workerId = c.req.param("workerId");
    const worker = await getWorkerDetail(deps.db, organizationId, workerId);
    if (!worker) return error(c, 404, "not_found", "Resource not found");
    const body = workerNameSchema.parse(await c.req.json());
    await renameWorker(deps.db, workerId, body.name, c.get("user").id);
    await deps.onWorkerChanged(workerId);
    return c.json(WorkerDetail.parse({ ...worker, name: body.name }));
  }));
  app.post("/api/organizations/:organizationId/workers/:workerId/:action", safe(async (c) => {
    const action = c.req.param("action"), id = c.req.param("workerId");
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!["adopt", "reject", "drain", "resume", "remove"].includes(action)) return error(c, 404, "not_found", "Resource not found");
    const idem = requireMutation(c); if (idem) return idem;
    const value = await getWorkerDetail(deps.db, c.req.param("organizationId"), id);
    if (!value) return error(c, 404, "not_found", "Resource not found");
    mutationSchema.parse(await c.req.json().catch(() => ({})));
    if (action === "adopt") await adoptWorker(deps.db, id, c.get("user").id);
    else if (action === "reject") await routeQueries(deps.db).rejectWorker.execute({ workerId: id });
    else if (action === "drain") {
      // Drain only removes the worker from scheduling. Existing leases must
      // finish normally; failing them here strands otherwise healthy jobs and
      // makes the UI contract ("active work completes") false.
      await routeQueries(deps.db).drainWorker.execute({ workerId: id });
    } else if (action === "resume") {
      if (value.admissionState !== "adopted" || value.configurationState !== "ready") return error(c, 409, "worker_not_ready", "Worker must be adopted and configured before resume");
      await routeQueries(deps.db).resumeWorker.execute({ workerId: id });
    } else {
      const [active] = await routeQueries(deps.db).activeWorkerLease.execute({ workerId: id });
      if (active) return error(c, 409, "worker_has_active_leases", "Worker has active leases; wait for reaping before removal");
      await deps.db.transaction(async tx => {
        await routeQueries(tx).removeWorkerDrain.execute({ workerId: id });
        await routeQueries(tx).removeWorkerPools.execute({ workerId: id });
        await routeQueries(tx).removeWorkerRevoke.execute({ workerId: id });
        await routeQueries(tx).removeWorkerAudit.execute({ actor: c.get("user").id, payload: JSON.stringify({ workerId: id }) });
      });
    }
    await deps.onWorkerChanged(id);
    return c.json({ ok: true });
  }));
  app.get("/api/pools", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const q = parseQuery(c); if (q instanceof Response) return q;
    return c.json(CursorPage(PoolSummary).parse(await listGlobalPools(deps.db, q.limit, q.cursor ?? null)));
  }));
  const poolWorker = async (body: z.infer<typeof CreatePoolRequest>): Promise<{ driver: string } | { error: "not_found" | "worker_not_ready" | "worker_runtime_not_ready" | "worker_guest_platform_unsupported" | "runtime_unsupported" | "exclusive_requires_concurrency_one" | "exclusive_worker_unsupported" }> => {
    const [worker] = await routeQueries(deps.db).poolWorker.execute({ workerId: body.workerId });
    if (!worker) return { error: "not_found" as const };
    if (worker.admissionState !== "adopted" || worker.configurationState !== "ready" || worker.configurationRevision !== worker.appliedConfigurationRevision || !worker.lastDoctorAt || Date.now() - new Date(String(worker.lastDoctorAt)).getTime() >= 60_000) return { error: "worker_not_ready" as const };
    if (body.cpuMode === "exclusive" && !supportsExclusiveCpuPlacement(String(worker.contractVersion ?? ""))) return { error: "exclusive_worker_unsupported" };
    if (body.cpuMode === "exclusive" && !String(worker.platform).startsWith("linux-") && (body.resources.concurrency !== 1 || jsonNumber(worker.limits, "maxConcurrentPods") !== 1)) return { error: "exclusive_requires_concurrency_one" };
    if (!(Array.isArray(worker.guestPlatforms) ? worker.guestPlatforms : [worker.platform]).includes(body.guestPlatform)) return { error: "worker_guest_platform_unsupported" as const };
    const desired = typeof worker.desiredConfiguration === "string" ? JSON.parse(worker.desiredConfiguration) : worker.desiredConfiguration;
    const driver = desired?.selectedDriver;
    if (typeof driver !== "string" || !RuntimeDriverName.safeParse(driver).success || !RuntimePlatform.safeParse(worker.platform).success) return { error: "runtime_unsupported" as const };
    const compatible = selectedRuntimeDriver(RuntimePlatform.parse(worker.platform), body.guestPlatform, RuntimeDriverName.parse(driver)) === driver;
    if (!compatible) return { error: "runtime_unsupported" as const };
    const evidence = workerPoolEvidence(worker.doctor, driver, body.guestPlatform);
    if (!evidence.ready) return { error: "worker_runtime_not_ready" };
    return { driver };
  };
  app.post("/api/pools", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const body = CreatePoolRequest.parse(await c.req.json());
    if (body.poolId) return error(c, 400, "invalid_request", "Use the pool update endpoint to edit an existing pool");
    const selected = await poolWorker(body);
    if ("error" in selected) return selected.error === "not_found" ? error(c, 404, "not_found", "Worker not found") : error(c, 422, selected.error, selected.error === "exclusive_requires_concurrency_one" ? "Windows/macOS exclusive pools require pool concurrency 1 and worker runtime.maxConcurrentPods 1" : selected.error === "exclusive_worker_unsupported" ? "Exclusive pools require worker contract 0.4.0 or newer" : selected.error === "worker_not_ready" ? "Worker configuration has not been reconciled" : selected.error === "worker_runtime_not_ready" ? "Worker runtime host evidence is not ready" : "Worker does not support the requested guest platform");
    const [duplicate] = await routeQueries(deps.db).globalPoolDuplicate.execute({ name: body.name, triggerLabel: body.triggerLabel });
    if (duplicate) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
    const [pool] = await routeQueries(deps.db).globalPoolCreate.execute({ name: body.name, platform: body.guestPlatform, driver: selected.driver, imageDigest: body.imageDigest, resources: body.resources, cpuMode: body.cpuMode, labels: [body.triggerLabel], triggerLabel: body.triggerLabel, enabled: false });
    await routeQueries(deps.db).poolAudit.execute({ actor: c.get("user").id, payload: JSON.stringify({ poolId: pool.id, workerId: body.workerId, guestPlatform: body.guestPlatform, triggerLabel: body.triggerLabel, scope: "control-plane" }) });
    return c.json({ id: String(pool.id), labels: [body.triggerLabel] });
  }));
  app.put("/api/pools/:poolId", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const poolId = c.req.param("poolId");
    const body = CreatePoolRequest.parse({ ...await c.req.json(), poolId });
    const [existing] = await routeQueries(deps.db).globalPoolEditInfo.execute({ poolId });
    if (!existing) return error(c, 404, "not_found", "Pool not found");
    if (existing.enabled || Number(existing.active) !== 0) return error(c, 409, "pool_in_use", "Disable the pool and wait for active leases to be reaped before editing");
    const selected = await poolWorker(body);
    if ("error" in selected) return error(c, selected.error === "not_found" ? 404 : 422, selected.error, selected.error === "exclusive_requires_concurrency_one" ? "Windows/macOS exclusive pools require pool concurrency 1 and worker runtime.maxConcurrentPods 1" : selected.error === "exclusive_worker_unsupported" ? "Exclusive pools require worker contract 0.4.0 or newer" : selected.error === "not_found" ? "Worker not found" : selected.error === "worker_runtime_not_ready" ? "Worker runtime host evidence is not ready" : "Worker is not compatible with this pool");
    const [duplicate] = await routeQueries(deps.db).globalPoolDuplicateOther.execute({ poolId, name: body.name, triggerLabel: body.triggerLabel });
    if (duplicate) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
    await routeQueries(deps.db).globalPoolUpdate.execute({ poolId, name: body.name, platform: body.guestPlatform, driver: selected.driver, imageDigest: body.imageDigest, resources: JSON.stringify(body.resources), cpuMode: body.cpuMode, labels: JSON.stringify([body.triggerLabel]), triggerLabel: body.triggerLabel });
    return c.json({ id: poolId, labels: [body.triggerLabel] });
  }));
  app.delete("/api/pools/:poolId", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const poolId = c.req.param("poolId");
    const [pool] = await routeQueries(deps.db).globalPoolEditInfo.execute({ poolId });
    if (!pool) return error(c, 404, "not_found", "Pool not found");
    if (pool.enabled || Number(pool.active) !== 0) return error(c, 409, "pool_in_use", "Disable the pool and wait for active leases to be reaped before deleting");
    await routeQueries(deps.db).globalPoolDelete.execute({ poolId });
    return c.json({ ok: true });
  }));
  app.post("/api/pools/:poolId/:action", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const action = c.req.param("action");
    if (!["enable", "disable"].includes(action)) return error(c, 404, "not_found", "Resource not found");
    const idem = requireMutation(c); if (idem) return idem;
    const poolId = c.req.param("poolId");
    const [pool] = await routeQueries(deps.db).globalPoolInfo.execute({ poolId });
    if (!pool) return error(c, 404, "not_found", "Pool not found");
    if (action === "enable") {
      const readyWorkers = await routeQueries(deps.db).enableWorkers.execute({ platform: pool.platform, driver: pool.driver });
      const ready = readyWorkers.find(worker => (!deps.workerConnected || deps.workerConnected(String(worker.id))) && (pool.cpuMode !== "exclusive" || supportsExclusiveCpuPlacement(String(worker.contractVersion ?? "")) && (String(worker.platform).startsWith("linux-") || jsonNumber(pool.resources, "concurrency") === 1 && jsonNumber(worker.limits, "maxConcurrentPods") === 1)));
      if (!ready && pool.cpuMode === "exclusive" && readyWorkers.some(worker => !String(worker.platform).startsWith("linux-") && (jsonNumber(pool.resources, "concurrency") !== 1 || jsonNumber(worker.limits, "maxConcurrentPods") !== 1))) return error(c, 422, "exclusive_requires_concurrency_one", "Windows/macOS exclusive pools require pool concurrency 1 and worker runtime.maxConcurrentPods 1");
      if (!ready) return error(c, 409, "no_compatible_ready_worker", "No compatible ready worker is connected for this pool");
    }
    await routeQueries(deps.db).globalPoolSetEnabled.execute({ enabled: action === "enable", poolId });
    return c.json({ ok: true });
  }));
  app.post("/api/organizations/:organizationId/pools", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const body = CreatePoolRequest.parse(await c.req.json());
    const [w] = await routeQueries(deps.db).organizationPoolWorker.execute({ workerId: body.workerId });
    if (!w || (w.platform === "linux-x64" && body.guestPlatform === "linux-x64")) return error(c, 422, "runtime_unsupported", "Linux-host x64 runners are not available in this release");
    if (w.admissionState !== "adopted" || (deps.workerConnected ? !deps.workerConnected(body.workerId) : false) || w.configurationState !== "ready" || w.configurationRevision !== w.appliedConfigurationRevision || w.draining || !w.lastDoctorAt || Date.now() - new Date(String(w.lastDoctorAt)).getTime() >= 60_000) return error(c, 422, "worker_not_ready", "Worker is not ready");
    if (body.cpuMode === "exclusive" && !supportsExclusiveCpuPlacement(String(w.contractVersion ?? ""))) return error(c, 422, "exclusive_worker_unsupported", "Exclusive pools require worker contract 0.4.0 or newer");
    if (body.cpuMode === "exclusive" && !String(w.platform).startsWith("linux-") && (body.resources.concurrency !== 1 || jsonNumber(w.limits, "maxConcurrentPods") !== 1)) return error(c, 422, "exclusive_requires_concurrency_one", "Windows/macOS exclusive pools require pool concurrency 1 and worker runtime.maxConcurrentPods 1");
    if (!(Array.isArray(w.guestPlatforms) ? w.guestPlatforms : [w.platform]).includes(body.guestPlatform)) return error(c, 422, "worker_guest_platform_unsupported", "Worker does not support the requested guest platform");
    const desired = typeof w.desiredConfiguration === "string" ? JSON.parse(w.desiredConfiguration) : w.desiredConfiguration;
    const driver = desired?.selectedDriver;
    if (typeof driver !== "string" || !RuntimeDriverName.safeParse(driver).success || !RuntimePlatform.safeParse(w.platform).success || selectedRuntimeDriver(RuntimePlatform.parse(w.platform), body.guestPlatform, RuntimeDriverName.parse(driver)) !== driver) return error(c, 422, "runtime_unsupported", "Worker has no compatible selected runtime");
    const evidence = workerPoolEvidence(w.doctor, driver, body.guestPlatform);
    if (!evidence.ready) return error(c, 422, "worker_runtime_not_ready", "Worker runtime host evidence is not ready");
    const labels = [body.triggerLabel];
    const [duplicate] = await routeQueries(deps.db).orgPoolDuplicate.execute({ name: body.name, triggerLabel: body.triggerLabel });
    if (body.poolId) {
      const [existing] = await routeQueries(deps.db).orgPoolExisting.execute({ poolId: body.poolId });
      if (!existing) return error(c, 404, "not_found", "Resource not found");
      if (existing.enabled) return error(c, 409, "pool_in_use", "Disable the pool before editing");
      if (existing.cpuMode !== body.cpuMode || JSON.stringify(existing.resources) !== JSON.stringify(body.resources)) {
        const [active] = await routeQueries(deps.db).poolActiveLease.execute({ poolId: body.poolId });
        if (active) return error(c, 409, "pool_in_use", "Wait for every lease to be reaped before changing mode or resources");
      }
      if (duplicate && String(duplicate.id) !== body.poolId) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
      await routeQueries(deps.db).orgPoolUpdate.execute({ poolId: body.poolId, platform: body.guestPlatform, driver, imageDigest: body.imageDigest, resources: JSON.stringify(body.resources), cpuMode: body.cpuMode, labels: JSON.stringify(labels), name: body.name, triggerLabel: body.triggerLabel });
      await invalidateDashboard(deps.db, org, ["pools", "onboarding"]);
      return c.json({ id: body.poolId, labels });
    }
    if (duplicate) {
      if (duplicate.name !== body.name || duplicate.triggerLabel !== body.triggerLabel) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
      if (duplicate.enabled) return error(c, 409, "pool_in_use", "Disable the pool before editing");
      if (duplicate.cpuMode !== body.cpuMode || JSON.stringify(duplicate.resources) !== JSON.stringify(body.resources)) {
        const [active] = await routeQueries(deps.db).poolActiveLease.execute({ poolId: duplicate.id });
        if (active) return error(c, 409, "pool_in_use", "Wait for every lease to be reaped before changing mode or resources");
      }
      await routeQueries(deps.db).orgPoolUpdate.execute({ poolId: duplicate.id, platform: body.guestPlatform, driver, imageDigest: body.imageDigest, resources: JSON.stringify(body.resources), cpuMode: body.cpuMode, labels: JSON.stringify(labels), name: body.name, triggerLabel: body.triggerLabel });
      await completeOnboardingIfReady(deps.db);
      await invalidateDashboard(deps.db, org, ["pools", "onboarding"]);
      return c.json({ id: String(duplicate.id), labels });
    }
    const key = c.req.header("idempotency-key")!;
    if (!(await dashboardMutation(deps.db, org, key))) return c.json({ ok: true });
    const [pool] = await routeQueries(deps.db).orgPoolCreate.execute({ name: body.name, platform: body.guestPlatform, driver, imageDigest: body.imageDigest, resources: body.resources, cpuMode: body.cpuMode, labels, triggerLabel: body.triggerLabel });
    await routeQueries(deps.db).poolAudit.execute({ actor: c.get("user").id, payload: JSON.stringify({ poolId: pool.id, workerId: body.workerId, guestPlatform: body.guestPlatform, triggerLabel: body.triggerLabel, scope: "control-plane" }) });
    await completeOnboardingIfReady(deps.db);
    await invalidateDashboard(deps.db, org, ["pools", "onboarding"]);
    return c.json({ id: pool.id, labels });
  }));
  app.post("/api/organizations/:organizationId/pools/:poolId/:action", safe(async (c) => {
    const org = c.req.param("organizationId"), action = c.req.param("action");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!["enable", "disable"].includes(action)) return error(c, 404, "not_found", "Resource not found");
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const key = c.req.header("idempotency-key")!;
    if (!(await dashboardMutation(deps.db, org, key))) return c.json({ ok: true });
    await routeQueries(deps.db).orgPoolSetEnabled.execute({ organizationId: org, poolId: c.req.param("poolId"), enabled: action === "enable" });
    await invalidateDashboard(deps.db, org, ["pools"]); return c.json({ ok: true });
  }));
  app.get("/api/organizations/:organizationId/github/connection", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    const [installation] = await routeQueries(deps.db).githubConnection.execute({ organizationId: org });
    c.header("Cache-Control", "no-store");
    if (!installation || installation.githubInstallationId == null || !Number.isSafeInteger(Number(installation.githubInstallationId))) return c.json(GithubConnectionSummary.parse({ connected: false }));
    const summary: Record<string, unknown> = { connected: true };
    if (typeof installation.login === "string" && installation.login) summary.login = installation.login;
    if (installation.githubAccountType === "User" || installation.githubAccountType === "Organization") summary.accountType = installation.githubAccountType;
    summary.installationId = Number(installation.githubInstallationId);
    const location = githubInstallationLocation(installation);
    if (location) summary.location = location;
    return c.json(GithubConnectionSummary.parse(summary));
  }));
  app.get("/api/organizations/:organizationId/github/rate-limit", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    const [installation] = await routeQueries(deps.db).githubInstallation.execute({ organizationId: org });
    if (!installation || installation.githubInstallationId == null || !Number.isSafeInteger(Number(installation.githubInstallationId))) return error(c, 404, "not_found", "GitHub installation not found");
    if (!deps.githubApp) return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
    try {
      const stats = await deps.githubApp.getInstallationRateLimit(Number(installation.githubInstallationId));
      c.header("Cache-Control", "no-store");
      return c.json(GithubRateLimitStats.parse(stats));
    } catch (cause) {
      if (cause instanceof Error && (cause.message === "github_installation_not_found" || cause.message === "github_404")) return error(c, 404, "not_found", "GitHub installation not found");
      if (cause instanceof Error && cause.message === "github_app_unconfigured") return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
      if (cause instanceof Error && cause.message === "github_rate_limit_invalid") return error(c, 502, "github_rate_limit_invalid", "GitHub returned invalid rate-limit statistics");
      if (cause instanceof Error && /^github_[45]\d\d$/.test(cause.message)) return error(c, 502, "github_upstream_error", "GitHub API request failed");
      throw cause;
    }
  }));
  app.get("/api/organizations/:organizationId/github/settings", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    const [installation] = await routeQueries(deps.db).githubLocation.execute({ organizationId: org });
    const location = githubInstallationLocation(installation ?? {});
    return location ? c.json({ location }) : error(c, 404, "not_found", "GitHub installation not found");
  }));
  app.post("/api/organizations/:organizationId/github/uninstall", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    if (!deps.githubApp) return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
    try {
      await deps.githubApp.uninstallOrganization(org);
      await invalidateDashboard(deps.db, org, ["repositories", "organizations"]);
      return c.json({ ok: true });
    } catch (cause) {
      if (cause instanceof Error && cause.message === "github_installation_not_found") return error(c, 404, "not_found", "GitHub installation not found");
      throw cause;
    }
  }));
  app.get("/api/organizations/:organizationId/repositories/:repositoryId/github/settings", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    const [installation] = await routeQueries(deps.db).githubRepositoryLocation.execute({ organizationId: org, repositoryId: c.req.param("repositoryId") });
    const location = githubInstallationLocation(installation ?? {});
    return location ? c.json({ location }) : error(c, 404, "not_found", "GitHub repository installation not found");
  }));
  app.post("/api/organizations/:organizationId/github/install", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    if (!deps.githubApp) return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
    try {
      const result = await deps.githubApp.beginOrganizationInstallation(c.get("user").id, org, c.req.header("idempotency-key")!);
      if (result.installCookie) c.header("Set-Cookie", `github_install_state=${result.installCookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=600`);
      return c.json({ location: result.location });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (code === "github_organization_already_connected") return error(c, 409, code, "This organization is already connected");
      throw cause;
    }
  }));
  app.post("/api/organizations/:organizationId/github/refresh", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    if (!deps.githubApp) return error(c, 503, "github_unconfigured", "GitHub App is not configured");
    try {
      await deps.githubApp.refreshInstallationRepositories(org);
      await invalidateDashboard(deps.db, org, ["repositories"]);
      return c.json({ ok: true });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (code === "github_404" || code === "github_installation_not_found") return error(c, 404, "not_found", "GitHub installation not found");
      if (/^github_[45]\d\d$/.test(code)) return error(c, 502, "github_upstream_error", "GitHub API request failed");
      throw cause;
    }
  }));
  app.get("/api/organizations/:organizationId/repositories/:repositoryId/runner-workflows", safe(async (c) => {
    const org = c.req.param("organizationId"); const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.githubApp) return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
    try {
      const result = await deps.githubApp.listRepositoryRunnerWorkflows({ organizationId: org, repositoryId: c.req.param("repositoryId") });
      return c.json(RunnerWorkflowFile.array().parse(discoverWorkflowFiles(result.files)));
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "Invalid workflow file";
      if (code === "github_repository_unavailable") return error(c, 404, "repository_unavailable", "Repository is unavailable");
      if (code === "github_403") return githubWorkflowPermissionError(c);
      if (/Invalid|Malformed|Unsupported/i.test(code)) return error(c, 422, "workflow_invalid", code, { repositoryId: c.req.param("repositoryId"), organizationId: org });
      throw cause;
    }
  }));
  app.post("/api/organizations/:organizationId/repositories/:repositoryId/runner-workflows/preview", safe(async (c) => {
    const org = c.req.param("organizationId"); const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    if (!deps.githubApp) return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
    const body = z.object({
      selectedPaths: z.array(z.string()).default([]),
      selectedPath: z.string().optional(),
      selectedJobId: z.string().trim().min(1).optional(),
      labels: z.array(z.string().trim().min(1)).min(1).optional(),
    }).strict().parse(await c.req.json());
    if ((body.selectedPath === undefined) !== (body.selectedJobId === undefined)) return error(c, 422, "workflow_invalid", "Focused workflow selection requires selectedPath and selectedJobId");
    try {
      return c.json(RunnerWorkflowPreview.parse(await deps.githubApp.previewRepositoryRunnerPr({
        organizationId: org,
        repositoryId: c.req.param("repositoryId"),
        selectedPaths: body.selectedPaths,
        selectedPath: body.selectedPath,
        selectedJobId: body.selectedJobId,
        labels: body.labels,
      })));
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (code === "github_repository_unavailable") return error(c, 404, "repository_unavailable", "Repository is unavailable");
      if (code === "github_403") return githubWorkflowPermissionError(c);
      if (code === "github_runner_pool_missing") return error(c, 422, "runner_pool_missing", "Runner pool is not configured");
      if (/Invalid|Malformed|Unsupported|not discovered|no-op|Focused workflow|resource label|duplicate labels|foreign or conflicting|Windows routing/i.test(code)) return error(c, 422, "workflow_invalid", code);
      throw cause;
    }
  }));
  app.post("/api/organizations/:organizationId/repositories/:repositoryId/runner-workflows/pr", safe(async (c) => {
    const org = c.req.param("organizationId"); const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem; if (!deps.githubApp) return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
    const body = RunnerWorkflowPrRequest.parse(await c.req.json());
    if ((body.selectedPath === undefined) !== (body.selectedJobId === undefined)) return error(c, 422, "workflow_invalid", "Focused workflow selection requires selectedPath and selectedJobId");
    const key = c.req.header("idempotency-key")!;
    const inserted = await routeQueries(deps.db).insertMutation.execute({ organizationId: org, key });
    if (!inserted.length) { const [prior] = await routeQueries(deps.db).priorMutation.execute({ organizationId: org, key }); if (prior?.response) return c.json(RunnerWorkflowPrResult.parse(prior.response)); return error(c, 409, "mutation_in_progress", "Mutation is already in progress"); }
    try {
      const result = RunnerWorkflowPrResult.parse(await deps.githubApp.createRepositoryRunnerPr({ ...body, organizationId: org, repositoryId: c.req.param("repositoryId") }));
      await routeQueries(deps.db).saveMutationResponse.execute({ organizationId: org, key, response: JSON.stringify(result) });
      return c.json(result);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (/github_workflow_head_stale/.test(code)) return error(c, 409, "workflow_head_stale", "Workflow files changed; refresh preview");
      if (code === "github_repository_unavailable") return error(c, 404, "repository_unavailable", "Repository is unavailable");
      if (code === "github_403") return githubWorkflowPermissionError(c);
      if (/Invalid|Malformed|Unsupported|not discovered|no-op|Focused workflow|resource label|duplicate labels|foreign or conflicting|Windows routing/i.test(code)) return error(c, 422, "workflow_invalid", code);
      throw cause;
    }
  }));
}
