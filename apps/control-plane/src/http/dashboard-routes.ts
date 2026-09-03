import { Hono, type Context } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { listOrganizations, getOverview, getAllOverview, listRepositories, listAllRepositories, listRuns, listAllRuns, getRunDetail, listLogChunks, listStepLogChunks, listWorkers, listAllWorkers, getWorkerDetail, listPools, listAllPools, listGlobalPools, getOrganizationSettings, updateOrganizationSettings, dashboardMutation, invalidateDashboard, completeOnboardingIfReady, queueRepositoryDiscoveryRecheck, jsonParameter, listJobTimingHistory, getJobTimingAggregates, listJobResourceTrends, JobResourceTrendInputError, listJobResourceSamples, listWorkerCacheEntries, decodeWorkerCacheCursor, getWorkerHealth, getJobLabelRecommendation } from "@mars/db";
import { adoptWorker } from "../workers.ts";
import { configurePendingWorker, purgeWorkerRunnerCache } from "../worker-requests.ts";
import { discoverWorkflowFiles } from "../workflow-pr.ts";
import { createWorkerImageBuildPayload } from "../windows-image-build.ts";
import { ApiError, DashboardWorkerCachePage, DashboardWorkerMutationResponse, OverviewDto, CursorPage, OrganizationSummary, RepositorySummary, RunSummary, RunDetail, LogChunk, WorkerDetail, PoolSummary, OrganizationSettings, CreatePoolRequest, WorkerConfiguration, WorkerImageBuildSpec, RunnerWorkflowFile, RunnerWorkflowPreview, RunnerWorkflowPrRequest, RunnerWorkflowPrResult, JobTimingSnapshot, JobTimingAggregate, JobResourceTrendResponse, JobResourceTrendSort, JobResourceSample, WorkerHealth, JobLabelRecommendation, JobLabelRecommendationQuery } from "@mars/contracts";
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
  includeInactive: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  search: z.string().max(200).default(""),
  availability: z.enum(["available", "unavailable"]).optional(),
  visibility: z.enum(["public", "private", "internal"]).optional(),
}).strict();
const periodSchema = z.enum(["24h", "7d", "30d"]);
const timingQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), repositoryId: z.string().uuid().optional(), workflow: z.string().max(200).optional(), jobName: z.string().max(200).optional(), platform: z.string().max(100).optional(), driver: z.string().max(100).optional(), vcpu: z.coerce.number().int().positive().optional(), concurrency: z.coerce.number().int().positive().optional(), outcome: z.enum(["success", "failure", "cancelled", "skipped", "neutral"]).optional() }).strict();
const jobResourceTrendQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  platform: z.string().max(100).optional(),
  vcpu: z.coerce.number().int().positive().optional(),
  concurrency: z.coerce.number().int().positive().optional(),
  search: z.string().max(200).default(""),
  sort: JobResourceTrendSort.default("latest"),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  jobKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  pointLimit: z.coerce.number().int().min(1).max(200).default(100),
}).strict().superRefine((value, ctx) => {
  const from = Date.parse(value.from), to = Date.parse(value.to);
  if (from >= to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be after from" });
  if (to - from > 90 * 24 * 60 * 60 * 1000) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "range must not exceed 90 days" });
});
const logSchema = z.object({ after: z.coerce.number().int().min(-1).default(-1), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();
const mutationSchema = z.object({}).strict();

function error(c: any, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return c.json(ApiError.parse({ code, message, requestId: c.req.header("x-request-id") || crypto.randomUUID(), ...(details ? { details } : {}) }), status, { "cache-control": "no-store" });
}
function githubWorkflowPermissionError(c: Context<ControlPlaneEnv>) { return error(c, 409, "github_app_permissions_missing", "GitHub App needs Contents and Pull requests write permissions. Update and approve the app permissions, then refresh."); }
function parseQuery(c: any) { const parsed = querySchema.safeParse(c.req.query()); return parsed.success ? parsed.data : error(c, 400, "invalid_query", "Invalid query parameters", { issues: parsed.error.issues }); }
function requireMutation(c: any) { return c.req.header("idempotency-key")?.trim() ? null : error(c, 400, "missing_idempotency_key", "Idempotency-Key is required"); }
async function member(db: any, user: any, organizationId: string) { if (user.isGlobalAdmin) return true; const [row] = await db`SELECT 1 FROM memberships WHERE user_id=${user.id} AND organization_id=${organizationId}`; return Boolean(row); }
async function guard(c: any, deps: ControlPlaneHttpDeps, organizationId: string) { return await member(deps.db, c.get("user"), organizationId) ? null : error(c, 404, "not_found", "Resource not found"); }
function githubInstallationLocation(row: { login?: unknown; githubInstallationId?: unknown; githubAccountType?: unknown }) {
  if (!Number.isSafeInteger(Number(row.githubInstallationId))) return null;
  const installationId = Number(row.githubInstallationId);
  if (row.githubAccountType === "User") return `https://github.com/settings/installations/${installationId}`;
  if (typeof row.login !== "string" || !row.login) return null;
  return `https://github.com/organizations/${encodeURIComponent(row.login)}/settings/installations/${installationId}`;
}

export function registerDashboardRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const safe = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { try { return await fn(c); } catch (cause) { if (cause instanceof z.ZodError) return error(c, 400, "invalid_request", "Invalid request", { issues: cause.issues }); console.error(cause); return error(c, 500, "internal_error", "Internal server error"); } };
  app.get("/api/me", (c) => c.json(c.get("user")));
  app.get("/api/organizations", safe(async (c) => c.json(OrganizationSummary.array().parse(await listOrganizations(deps.db, c.get("user").id)))));
  app.get("/api/organizations/:organizationId/overview", safe(async (c) => { const org = c.req.param("organizationId"); const period = periodSchema.safeParse(c.req.query("period") || "24h"); if (!period.success) return error(c, 400, "invalid_period", "Invalid period", { issues: period.error.issues }); if (org === "all") return c.json(OverviewDto.parse(await getAllOverview(deps.db, c.get("user").id, period.data))); const denied = await guard(c, deps, org); if (denied) return denied; return c.json(OverviewDto.parse(await getOverview(deps.db, org, period.data))); }));
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
    const q = parseQuery(c);
    if (q instanceof Response) return q;
    if (org === "all") return c.json(CursorPage(RunSummary).parse(await listAllRuns(deps.db, c.get("user").id, q.limit, q.cursor ?? null, q.search)));
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    return c.json(CursorPage(RunSummary).parse(await listRuns(deps.db, org, q.limit, q.cursor ?? null, q.search)));
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
    return c.json(JobLabelRecommendation.parse(await getJobLabelRecommendation(deps.db, org, parsed.data, c.get("user").id)));
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
    const denied = await guard(c, deps, org);
    if (denied) return denied;
    const parsed = jobResourceTrendQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return error(c, 400, "invalid_resource_trend_query", "Invalid job resource trend query", { issues: parsed.error.issues });
    try {
      return c.json(JobResourceTrendResponse.parse(await listJobResourceTrends(deps.db, org, parsed.data)));
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
  app.post("/api/workers/:workerId/configure", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const result = await configurePendingWorker(deps.db, c.req.param("workerId"), WorkerConfiguration.parse(await c.req.json()), c.get("user").id, deps.workerDispatcher, c.req.header("idempotency-key")!);
    return c.json(DashboardWorkerMutationResponse.parse(result));
  }));
  app.post("/api/workers/:workerId/build-runtime", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    if (!deps.workerDispatcher) return error(c, 503, "worker_dispatch_unavailable", "Worker command dispatch is unavailable");
    const workerId = c.req.param("workerId");
    const [worker] = await deps.db`SELECT admission_state AS "admissionState" FROM workers WHERE id=${workerId}`;
    if (!worker) return error(c, 404, "not_found", "Resource not found");
    if (worker.admissionState !== "adopted" || (deps.workerConnected ? !deps.workerConnected(workerId) : false)) return error(c, 409, "worker_not_ready", "Worker must be adopted and connected before building a runtime image");
    const spec = WorkerImageBuildSpec.parse(await c.req.json());
    if (!deps.windowsContainerBuild) return error(c, 503, "image_build_unavailable", "Authoritative Windows image build inputs are unavailable");
    const buildId = randomUUID();
    const payload = await createWorkerImageBuildPayload({ baseUrl: deps.setup.publicOrigin() ?? "", buildId, image: spec.image, build: deps.windowsContainerBuild });
    console.log("Windows image build dispatch", { workerId, buildId, image: payload.image, contentSha256: payload.contentSha256 });
    await deps.db`UPDATE workers SET doctor=COALESCE(doctor,'{}'::jsonb) || ${JSON.stringify({ runtimeBuildState: "building", runtimeBuildMessage: null, runtimeReady: false })}::jsonb WHERE id=${workerId}`;
    await deps.workerDispatcher.dispatch({ type: "worker.build_image", workerId, leaseId: null, payload });
    return c.json({ buildId }, 202);
  }));
  app.get("/api/organizations/:organizationId/runs/:runId", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const value=await getRunDetail(deps.db,org,c.req.param("runId")); return value?c.json(RunDetail.parse(value)):error(c,404,"not_found","Resource not found"); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/logs", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const q=logSchema.safeParse(c.req.query()); if(!q.success)return error(c,400,"invalid_log_bounds","Invalid log bounds",{issues:q.error.issues}); return c.json(CursorPage(LogChunk).parse(await listLogChunks(deps.db,org,c.req.param("runId"),c.req.param("jobId"),q.data.after,q.data.limit))); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/steps/:stepId/logs", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const q=logSchema.safeParse(c.req.query()); if(!q.success)return error(c,400,"invalid_log_bounds","Invalid log bounds",{issues:q.error.issues}); return c.json(CursorPage(LogChunk).parse(await listStepLogChunks(deps.db,org,c.req.param("runId"),c.req.param("jobId"),c.req.param("stepId"),q.data.after,q.data.limit))); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/resource-samples", safe(async (c) => { const org = c.req.param("organizationId"); const denied = await guard(c, deps, org); if (denied) return denied; const after = c.req.query("after"); const limit = Number(c.req.query("limit") ?? 100); if (after !== undefined && Number.isNaN(Date.parse(after))) return error(c, 400, "invalid_sample_cursor", "Invalid resource sample cursor"); if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(c, 400, "invalid_sample_limit", "Invalid resource sample limit"); return c.json(CursorPage(JobResourceSample).parse(await listJobResourceSamples(deps.db, org, c.req.param("runId"), c.req.param("jobId"), after ?? null, limit))); }));
  app.get("/api/organizations/:organizationId/settings", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;return c.json(OrganizationSettings.parse(await getOrganizationSettings(deps.db,org)));}));
  app.put("/api/organizations/:organizationId/settings", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;if(!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");const idem=requireMutation(c);if(idem)return idem;const body=OrganizationSettings.parse({...await c.req.json(),organizationId:org});const key=c.req.header("idempotency-key")!;if(!(await dashboardMutation(deps.db,org,key)))return c.json(OrganizationSettings.parse(await getOrganizationSettings(deps.db,org)));const value=await updateOrganizationSettings(deps.db,body);await invalidateDashboard(deps.db,org,["settings"]);return c.json(OrganizationSettings.parse(value));}));
  app.get("/api/organizations/:organizationId/workers/:workerId", safe(async(c)=>{if(!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");const value=await getWorkerDetail(deps.db,c.req.param("organizationId"),c.req.param("workerId"));return value?c.json(WorkerDetail.parse(value)):error(c,404,"not_found","Resource not found");}));
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
    const [worker] = await deps.db`SELECT id,admission_state AS "admissionState" FROM workers WHERE id=${workerId}`;
    if (!worker) return error(c, 404, "not_found", "Resource not found");
    if (!["pending", "adopted"].includes(worker.admissionState)) return error(c, 409, "worker_not_ready", "Worker is not available");
    const result = await purgeWorkerRunnerCache(deps.db, workerId, c.get("user").id, deps.workerDispatcher, c.req.header("idempotency-key")!.trim());
    return c.json(result, 202);
  }));
  app.get("/api/workers/:workerId/health", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const health = await getWorkerHealth(deps.db, c.req.param("workerId"), deps.workerConnected ?? (() => false));
    return health ? c.json(WorkerHealth.parse(health), { headers: { "cache-control": "no-store" } }) : error(c, 404, "not_found", "Resource not found");
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
    await deps.db`UPDATE workers SET preserve_leases=${body.enabled} WHERE id=${workerId}`;
    if (!body.enabled) await deps.db`UPDATE runner_leases SET cleanup_state='pending' WHERE worker_id=${workerId} AND state='failed' AND cleanup_state='debug_preserved'`;
    await deps.workerDispatcher.dispatch({ type: "worker.set_lease_preservation", workerId, leaseId: null, payload: { enabled: body.enabled } });
    if (organizationId !== "all") await invalidateDashboard(deps.db, organizationId, ["workers", workerId]);
    return c.json(WorkerDetail.parse(await getWorkerDetail(deps.db, organizationId, workerId)));
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
    else if (action === "reject") await deps.db`UPDATE workers SET admission_state='rejected' WHERE id=${id} AND admission_state='pending'`;
    else if (action === "drain") {
      await deps.db`UPDATE workers SET draining=true WHERE id=${id}`;
      await deps.db`UPDATE runner_leases SET state='failed',terminal_result=${jsonParameter(deps.db, { reason: "worker_drained" })}::jsonb,cleanup_state='pending',updated_at=now() WHERE worker_id=${id} AND state IN ('reserved','requested','dispatched','provisioning','sandbox_ready','online','busy')`;
      await deps.db`UPDATE dashboard_jobs j SET status='completed',stage='completed',conclusion=COALESCE(j.conclusion,'failure'),completed_at=COALESCE(j.completed_at,now()) FROM runner_leases l WHERE l.worker_id=${id} AND l.github_job_id=j.github_job_id AND l.state='failed' AND l.terminal_result->>'reason'='worker_drained' AND j.status <> 'completed'`;
      await deps.db`UPDATE dashboard_runs r SET status='completed',conclusion=COALESCE(r.conclusion,'failure'),completed_at=COALESCE(r.completed_at,now()) WHERE EXISTS (SELECT 1 FROM dashboard_jobs j JOIN runner_leases l ON l.organization_id=j.organization_id AND l.github_job_id=j.github_job_id WHERE l.worker_id=${id} AND l.state='failed' AND l.terminal_result->>'reason'='worker_drained' AND r.organization_id=j.organization_id AND r.id=j.run_id) AND r.status <> 'completed'`;
    } else if (action === "resume") {
      if (value.admissionState !== "adopted" || value.configurationState !== "ready") return error(c, 409, "worker_not_ready", "Worker must be adopted and configured before resume");
      await deps.db`UPDATE workers SET draining=false WHERE id=${id} AND admission_state='adopted' AND configuration_state='ready'`;
    } else {
      const [active] = await deps.db`SELECT id FROM runner_leases WHERE worker_id=${id} AND state NOT IN ('reaped','failed','expired','completed') LIMIT 1`;
      if (active) return error(c, 409, "worker_has_active_leases", "Worker has active leases; wait for reaping before removal");
      await deps.db.begin(async tx => {
        await tx`UPDATE workers SET draining=true WHERE id=${id}`;
        await tx`UPDATE runner_pools SET enabled=false WHERE worker_id=${id}`;
        await tx`UPDATE workers SET admission_state='revoked' WHERE id=${id}`;
        await tx`INSERT INTO audit_events (actor,type,payload) VALUES (${c.get("user").id},'worker.removed',${jsonParameter(tx, { workerId: id })}::jsonb)`;
      });
    }
    return c.json({ ok: true });
  }));
  app.get("/api/pools", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const q = parseQuery(c); if (q instanceof Response) return q;
    return c.json(CursorPage(PoolSummary).parse(await listGlobalPools(deps.db, q.limit, q.cursor ?? null)));
  }));
  const poolWorker = async (body: z.infer<typeof CreatePoolRequest>): Promise<{ driver: string } | { error: "not_found" | "worker_not_ready" | "worker_runtime_not_ready" | "worker_image_mismatch" | "worker_guest_platform_unsupported" | "runtime_unsupported" }> => {
    const [worker] = await deps.db`SELECT platform,guest_platforms AS "guestPlatforms",admission_state AS "admissionState",configuration_state AS "configurationState",configuration_revision AS "configurationRevision",applied_configuration_revision AS "appliedConfigurationRevision",doctor FROM workers WHERE id=${body.workerId}`;
    if (!worker) return { error: "not_found" as const };
    if (worker.admissionState !== "adopted" || worker.configurationState !== "ready" || worker.configurationRevision !== worker.appliedConfigurationRevision) return { error: "worker_not_ready" as const };
    if (!(Array.isArray(worker.guestPlatforms) ? worker.guestPlatforms : [worker.platform]).includes(body.guestPlatform)) return { error: "worker_guest_platform_unsupported" as const };
    const driver = worker.platform === "linux-x64" ? "linux-libvirt-vm" : worker.platform === "windows-x64" ? "windows-hyperv-container" : "tart-vm";
    if (driver === "linux-libvirt-vm") {
      const doctor = worker.doctor && typeof worker.doctor === "object" ? worker.doctor as Record<string, unknown> : {};
      if (![doctor.runtimeReady, doctor.libvirtReady, doctor.networkReady, doctor.cloneStorageReady, doctor.imageSignatures, doctor.realVmSmoke].every((value) => value === true)) return { error: "worker_runtime_not_ready" };
      if (doctor.artifactDigest !== body.imageDigest || doctor.smokeArtifactDigest !== body.imageDigest) return { error: "worker_image_mismatch" };
    }
    return { driver };
  };
  app.post("/api/pools", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const body = CreatePoolRequest.parse(await c.req.json());
    if (body.poolId) return error(c, 400, "invalid_request", "Use the pool update endpoint to edit an existing pool");
    const selected = await poolWorker(body);
    if ("error" in selected) return selected.error === "not_found" ? error(c, 404, "not_found", "Worker not found") : error(c, 422, selected.error, selected.error === "worker_not_ready" ? "Worker configuration has not been reconciled" : selected.error === "worker_runtime_not_ready" ? "Worker runtime host evidence is not ready" : selected.error === "worker_image_mismatch" ? "Worker image evidence does not match the requested digest" : "Worker does not support the requested guest platform");
    const [duplicate] = await deps.db`SELECT id FROM runner_pools WHERE organization_id IS NULL AND (name=${body.name} OR trigger_label=${body.triggerLabel}) LIMIT 1`;
    if (duplicate) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
    const [pool] = await deps.db`INSERT INTO runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) VALUES (NULL,NULL,${body.name},${body.guestPlatform},${selected.driver},${body.imageDigest},${jsonParameter(deps.db, body.resources)}::jsonb,${jsonParameter(deps.db, [body.triggerLabel])}::jsonb,${body.triggerLabel},false) RETURNING id`;
    await deps.db`INSERT INTO audit_events (organization_id,actor,type,payload) VALUES (NULL,${c.get("user").id},'pool.created',${jsonParameter(deps.db, { poolId: pool.id, workerId: body.workerId, guestPlatform: body.guestPlatform, triggerLabel: body.triggerLabel, scope: "control-plane" })}::jsonb)`;
    return c.json({ id: String(pool.id), labels: [body.triggerLabel] });
  }));
  app.put("/api/pools/:poolId", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const poolId = c.req.param("poolId");
    const body = CreatePoolRequest.parse({ ...await c.req.json(), poolId });
    const [existing] = await deps.db`SELECT p.id,p.enabled,(SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.state NOT IN ('completed','reaped','failed','expired')) AS active FROM runner_pools p WHERE p.id=${poolId} AND p.organization_id IS NULL`;
    if (!existing) return error(c, 404, "not_found", "Pool not found");
    if (existing.enabled || Number(existing.active) !== 0) return error(c, 409, "pool_in_use", "Disable the pool and wait for active leases to be reaped before editing");
    const selected = await poolWorker(body);
    if ("error" in selected) return error(c, selected.error === "not_found" ? 404 : 422, selected.error, selected.error === "not_found" ? "Worker not found" : selected.error === "worker_runtime_not_ready" ? "Worker runtime host evidence is not ready" : selected.error === "worker_image_mismatch" ? "Worker image evidence does not match the requested digest" : "Worker is not compatible with this pool");
    const [duplicate] = await deps.db`SELECT id FROM runner_pools WHERE organization_id IS NULL AND id<>${poolId} AND (name=${body.name} OR trigger_label=${body.triggerLabel}) LIMIT 1`;
    if (duplicate) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
    await deps.db`UPDATE runner_pools SET name=${body.name},platform=${body.guestPlatform},driver=${selected.driver},image_digest=${body.imageDigest},resources=${jsonParameter(deps.db, body.resources)}::jsonb,labels=${jsonParameter(deps.db, [body.triggerLabel])}::jsonb,trigger_label=${body.triggerLabel} WHERE id=${poolId} AND organization_id IS NULL`;
    return c.json({ id: poolId, labels: [body.triggerLabel] });
  }));
  app.delete("/api/pools/:poolId", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const poolId = c.req.param("poolId");
    const [pool] = await deps.db`SELECT p.id,p.enabled,(SELECT count(*)::int FROM runner_leases l WHERE l.pool_id=p.id AND l.state NOT IN ('completed','reaped','failed','expired')) AS active FROM runner_pools p WHERE p.id=${poolId} AND p.organization_id IS NULL`;
    if (!pool) return error(c, 404, "not_found", "Pool not found");
    if (pool.enabled || Number(pool.active) !== 0) return error(c, 409, "pool_in_use", "Disable the pool and wait for active leases to be reaped before deleting");
    await deps.db`DELETE FROM runner_pools WHERE id=${poolId} AND organization_id IS NULL`;
    return c.json({ ok: true });
  }));
  app.post("/api/pools/:poolId/:action", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const action = c.req.param("action");
    if (!["enable", "disable"].includes(action)) return error(c, 404, "not_found", "Resource not found");
    const idem = requireMutation(c); if (idem) return idem;
    const poolId = c.req.param("poolId");
    const [pool] = await deps.db`SELECT id,platform,driver,image_digest AS "imageDigest" FROM runner_pools WHERE id=${poolId} AND organization_id IS NULL`;
    if (!pool) return error(c, 404, "not_found", "Pool not found");
    if (action === "enable") {
      const [ready] = await deps.db`SELECT w.id FROM workers w WHERE w.admission_state='adopted' AND w.configuration_state='ready' AND w.configuration_revision=w.applied_configuration_revision AND w.draining=false AND w.last_heartbeat_at>now()-interval '90 seconds' AND w.doctor_observed_at IS NOT NULL AND ${pool.platform}=ANY(SELECT jsonb_array_elements_text(w.guest_platforms)) AND ${pool.driver}=CASE w.platform WHEN 'windows-x64' THEN 'windows-hyperv-container' WHEN 'macos-arm64' THEN 'tart-vm' ELSE 'linux-libvirt-vm' END AND (${pool.driver} <> 'linux-libvirt-vm' OR ((w.doctor->>'runtimeReady')::boolean IS TRUE AND (w.doctor->>'libvirtReady')::boolean IS TRUE AND (w.doctor->>'networkReady')::boolean IS TRUE AND (w.doctor->>'cloneStorageReady')::boolean IS TRUE AND (w.doctor->>'imageSignatures')::boolean IS TRUE AND (w.doctor->>'realVmSmoke')::boolean IS TRUE AND w.doctor->>'artifactDigest'=${pool.imageDigest} AND w.doctor->>'smokeArtifactDigest'=${pool.imageDigest})) LIMIT 1`;
      if (!ready || (deps.workerConnected ? !deps.workerConnected(String(ready.id)) : false)) return error(c, 409, "no_compatible_ready_worker", "No compatible ready worker is connected for this pool");
    }
    await deps.db`UPDATE runner_pools SET enabled=${action === "enable"} WHERE id=${poolId} AND organization_id IS NULL`;
    return c.json({ ok: true });
  }));
  app.post("/api/organizations/:organizationId/pools", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const body = CreatePoolRequest.parse(await c.req.json());
    if (body.guestPlatform === "linux-x64") return error(c, 422, "runtime_unsupported", "Linux runners are not available in this release");
    if (body.triggerLabel === "self-hosted" || ["linux", "windows", "macos", "x64", "arm64"].includes(body.triggerLabel)) return error(c, 400, "reserved_trigger_label", "Trigger label is reserved");
    const [w] = await deps.db`SELECT platform,guest_platforms AS "guestPlatforms",admission_state AS "admissionState",configuration_state AS "configurationState",draining,limits FROM workers WHERE id=${body.workerId}`;
    if (!w) return error(c, 404, "not_found", "Resource not found");
    if (w.platform === "linux-x64") return error(c, 422, "runtime_unsupported", "Linux runners are not available in this release");
    if (w.admissionState !== "adopted" || (deps.workerConnected ? !deps.workerConnected(body.workerId) : false) || w.configurationState !== "ready" || w.draining) return error(c, 422, "worker_not_ready", "Worker is not ready");
    if (!(Array.isArray(w.guestPlatforms) ? w.guestPlatforms : [w.platform]).includes(body.guestPlatform)) return error(c, 422, "worker_guest_platform_unsupported", "Worker does not support the requested guest platform");
    const driver = w.platform === "linux-x64" ? "linux-libvirt-vm" : w.platform === "windows-x64" ? "windows-hyperv-container" : "tart-vm";
    const labels = [body.triggerLabel];
    const [duplicate] = await deps.db`SELECT id,name,trigger_label AS "triggerLabel" FROM runner_pools WHERE organization_id IS NULL AND (name=${body.name} OR trigger_label=${body.triggerLabel})`;
    if (body.poolId) {
      const [existing] = await deps.db`SELECT id FROM runner_pools WHERE id=${body.poolId} AND organization_id IS NULL`;
      if (!existing) return error(c, 404, "not_found", "Resource not found");
      if (duplicate && String(duplicate.id) !== body.poolId) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
      await deps.db`UPDATE runner_pools SET worker_id=NULL,platform=${body.guestPlatform},driver=${driver},image_digest=${body.imageDigest},resources=${jsonParameter(deps.db, body.resources)},labels=${jsonParameter(deps.db, labels)},name=${body.name},trigger_label=${body.triggerLabel},enabled=true WHERE id=${body.poolId}`;
      await invalidateDashboard(deps.db, org, ["pools", "onboarding"]);
      return c.json({ id: body.poolId, labels });
    }
    if (duplicate) {
      if (duplicate.name !== body.name || duplicate.triggerLabel !== body.triggerLabel) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
      await deps.db`UPDATE runner_pools SET worker_id=NULL,platform=${body.guestPlatform},driver=${driver},image_digest=${body.imageDigest},resources=${jsonParameter(deps.db, body.resources)}::jsonb,labels=${jsonParameter(deps.db, labels)}::jsonb,enabled=true WHERE id=${duplicate.id}`;
      await completeOnboardingIfReady(deps.db);
      await invalidateDashboard(deps.db, org, ["pools", "onboarding"]);
      return c.json({ id: String(duplicate.id), labels });
    }
    const key = c.req.header("idempotency-key")!;
    if (!(await dashboardMutation(deps.db, org, key))) return c.json({ ok: true });
    const [pool] = await deps.db`INSERT INTO runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) VALUES (NULL,NULL,${body.name},${body.guestPlatform},${driver},${body.imageDigest},${jsonParameter(deps.db, body.resources)}::jsonb,${jsonParameter(deps.db, labels)}::jsonb,${body.triggerLabel},true) RETURNING id`;
    await deps.db`INSERT INTO audit_events (organization_id,actor,type,payload) VALUES (NULL,${c.get("user").id},'pool.created',${jsonParameter(deps.db, { poolId: pool.id, workerId: body.workerId, guestPlatform: body.guestPlatform, triggerLabel: body.triggerLabel, scope: "control-plane" })}::jsonb)`;
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
    await deps.db`UPDATE runner_pools SET enabled=${action === "enable"} WHERE organization_id=${org} AND id=${c.req.param("poolId")}`;
    await invalidateDashboard(deps.db, org, ["pools"]); return c.json({ ok: true });
  }));
  app.get("/api/organizations/:organizationId/github/settings", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    const [installation] = await deps.db`SELECT o.login, o.github_account_type AS "githubAccountType", i.github_installation_id AS "githubInstallationId" FROM organizations o JOIN dashboard_installations i ON i.organization_id=o.id WHERE o.id=${org} ORDER BY i.created_at DESC LIMIT 1`;
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
      await deps.db`DELETE FROM memberships WHERE organization_id=${org} AND user_id=${c.get("user").id}`;
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
    const [installation] = await deps.db`SELECT o.login, o.github_account_type AS "githubAccountType", i.github_installation_id AS "githubInstallationId" FROM organizations o JOIN dashboard_repositories r ON r.organization_id=o.id JOIN dashboard_installations i ON i.id=r.installation_id WHERE o.id=${org} AND r.id=${c.req.param("repositoryId")} AND r.available=true AND i.state <> 'suspended'`;
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
    await deps.githubApp.refreshInstallationRepositories(org);
    await invalidateDashboard(deps.db, org, ["repositories"]);
    return c.json({ ok: true });
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
      if (/Invalid|Malformed|Unsupported|not discovered|no-op/i.test(code)) return error(c, 422, "workflow_invalid", code);
      throw cause;
    }
  }));
  app.post("/api/organizations/:organizationId/repositories/:repositoryId/runner-workflows/pr", safe(async (c) => {
    const org = c.req.param("organizationId"); const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem; if (!deps.githubApp) return error(c, 503, "github_app_unconfigured", "GitHub App is not configured");
    const body = RunnerWorkflowPrRequest.parse(await c.req.json()); const key = c.req.header("idempotency-key")!;
    const inserted = await deps.db`INSERT INTO dashboard_mutations (organization_id,idempotency_key) VALUES (${org},${key}) ON CONFLICT DO NOTHING RETURNING idempotency_key`;
    if (!inserted.length) { const [prior] = await deps.db`SELECT response FROM dashboard_mutations WHERE organization_id=${org} AND idempotency_key=${key}`; if (prior?.response) return c.json(RunnerWorkflowPrResult.parse(prior.response)); return error(c, 409, "mutation_in_progress", "Mutation is already in progress"); }
    try {
      const result = RunnerWorkflowPrResult.parse(await deps.githubApp.createRepositoryRunnerPr({ ...body, organizationId: org, repositoryId: c.req.param("repositoryId") }));
      await deps.db`UPDATE dashboard_mutations SET response=${jsonParameter(deps.db, result)}::jsonb WHERE organization_id=${org} AND idempotency_key=${key}`;
      return c.json(result);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (/github_workflow_head_stale/.test(code)) return error(c, 409, "workflow_head_stale", "Workflow files changed; refresh preview");
      if (code === "github_repository_unavailable") return error(c, 404, "repository_unavailable", "Repository is unavailable");
      if (code === "github_403") return githubWorkflowPermissionError(c);
      if (/Invalid|Malformed|Unsupported|not discovered|no-op/i.test(code)) return error(c, 422, "workflow_invalid", code);
      throw cause;
    }
  }));
}
