import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { listOrganizations, getOverview, getAllOverview, listRepositories, listAllRepositories, listRuns, listAllRuns, getRunDetail, listLogChunks, listStepLogChunks, listWorkers, listAllWorkers, getWorkerDetail, listPools, listAllPools, listGlobalPools, getOrganizationSettings, updateOrganizationSettings, dashboardMutation, invalidateDashboard, completeOnboardingIfReady, queueRepositoryDiscoveryRecheck } from "@whitesmith/db";
import { adoptWorker } from "../workers.ts";
import { configurePendingWorker } from "../worker-requests.ts";
import { discoverWorkflowFiles } from "../workflow-pr.ts";
import { ApiError, OverviewDto, CursorPage, OrganizationSummary, RepositorySummary, RunSummary, RunDetail, LogChunk, WorkerDetail, PoolSummary, OrganizationSettings, CreatePoolRequest, WorkerConfiguration, RunnerWorkflowFile, RunnerWorkflowPreview, RunnerWorkflowPrRequest, RunnerWorkflowPrResult } from "@whitesmith/contracts";
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(), includeInactive: z.enum(["true", "false"]).default("false").transform((value) => value === "true") }).strict();
const periodSchema = z.enum(["24h", "7d", "30d"]);
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
  app.get("/api/organizations/:organizationId/repositories", safe(async (c) => { const org = c.req.param("organizationId"); const q = parseQuery(c); if (q instanceof Response) return q; if (org === "all") return c.json(CursorPage(RepositorySummary).parse(await listAllRepositories(deps.db, c.get("user").id, q.limit, q.cursor ?? null))); const denied = await guard(c, deps, org); if (denied) return denied; return c.json(CursorPage(RepositorySummary).parse(await listRepositories(deps.db, org, q.limit, q.cursor ?? null))); }));
  for (const [path, fn, allFn, schema] of [["runs", listRuns, listAllRuns, RunSummary], ["pools", listPools, listAllPools, PoolSummary]] as const) app.get(`/api/organizations/:organizationId/${path}`, safe(async (c) => { const org = c.req.param("organizationId"); const q = parseQuery(c); if (q instanceof Response) return q; if (org === "all") return c.json(CursorPage(schema).parse(await allFn(deps.db, c.get("user").id, q.limit))); const denied = await guard(c, deps, org); if (denied) return denied; return c.json(CursorPage(schema).parse(await fn(deps.db, org, q.limit))); }));
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
  app.get("/api/organizations/:organizationId/workers", safe(async (c) => { if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required"); const q = parseQuery(c); if (q instanceof Response) return q; return c.json(CursorPage(WorkerDetail).parse(await listAllWorkers(deps.db, c.get("user").id, q.limit, q.includeInactive))); }));
  app.post("/api/organizations/:organizationId/workers/:workerId/configure", safe(async (c) => { const org = c.req.param("organizationId"); const denied = await guard(c, deps, org); if (denied) return denied; if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required"); const idem = requireMutation(c); if (idem) return idem; const body = WorkerConfiguration.parse(await c.req.json()); const worker = await getWorkerDetail(deps.db, org, c.req.param("workerId")); if (!worker) return error(c, 404, "not_found", "Resource not found"); if (worker.admissionState === "rejected" || worker.admissionState === "revoked") return error(c, 409, "worker_not_configurable", "Rejected or revoked workers cannot be configured"); const result = await configurePendingWorker(deps.db, c.req.param("workerId"), body, c.get("user").id, deps.workerDispatcher, c.req.header("idempotency-key")!); if (org !== "all") await invalidateDashboard(deps.db, org, ["workers", "onboarding"]); return c.json(result, 202); }));
  app.get("/api/organizations/:organizationId/runs/:runId", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const value=await getRunDetail(deps.db,org,c.req.param("runId")); return value?c.json(RunDetail.parse(value)):error(c,404,"not_found","Resource not found"); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/logs", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const q=logSchema.safeParse(c.req.query()); if(!q.success)return error(c,400,"invalid_log_bounds","Invalid log bounds",{issues:q.error.issues}); return c.json(CursorPage(LogChunk).parse(await listLogChunks(deps.db,org,c.req.param("runId"),c.req.param("jobId"),q.data.after,q.data.limit))); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/steps/:stepId/logs", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const q=logSchema.safeParse(c.req.query()); if(!q.success)return error(c,400,"invalid_log_bounds","Invalid log bounds",{issues:q.error.issues}); return c.json(CursorPage(LogChunk).parse(await listStepLogChunks(deps.db,org,c.req.param("runId"),c.req.param("jobId"),c.req.param("stepId"),q.data.after,q.data.limit))); }));
  app.get("/api/organizations/:organizationId/settings", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;return c.json(OrganizationSettings.parse(await getOrganizationSettings(deps.db,org)));}));
  app.put("/api/organizations/:organizationId/settings", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;if(!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");const idem=requireMutation(c);if(idem)return idem;const body=OrganizationSettings.parse({...await c.req.json(),organizationId:org});const key=c.req.header("idempotency-key")!;if(!(await dashboardMutation(deps.db,org,key)))return c.json(OrganizationSettings.parse(await getOrganizationSettings(deps.db,org)));const value=await updateOrganizationSettings(deps.db,body);await invalidateDashboard(deps.db,org,["settings"]);return c.json(OrganizationSettings.parse(value));}));
  app.get("/api/organizations/:organizationId/workers/:workerId", safe(async(c)=>{if(!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");const value=await getWorkerDetail(deps.db,c.req.param("organizationId"),c.req.param("workerId"));return value?c.json(WorkerDetail.parse(value)):error(c,404,"not_found","Resource not found");}));
  app.post("/api/organizations/:organizationId/workers/:workerId/:action", safe(async(c)=>{const action=c.req.param("action"), id=c.req.param("workerId");if(!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");if(!["adopt","reject","drain","remove"].includes(action))return error(c,404,"not_found","Resource not found");const idem=requireMutation(c);if(idem)return idem;const value=await getWorkerDetail(deps.db,c.req.param("organizationId"),id);if(!value)return error(c,404,"not_found","Resource not found");mutationSchema.parse(await c.req.json().catch(()=>({})));if(action==="adopt")await adoptWorker(deps.db,id,c.get("user").id);else if(action==="reject")await deps.db`UPDATE workers SET admission_state='rejected' WHERE id=${id} AND admission_state='pending'`;else if(action==="drain")await deps.db`UPDATE workers SET draining=true WHERE id=${id}`;else await deps.db`UPDATE workers SET admission_state='revoked' WHERE id=${id}`;return c.json({ok:true});}));
  app.get("/api/pools", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const q = parseQuery(c); if (q instanceof Response) return q;
    return c.json(CursorPage(PoolSummary).parse(await listGlobalPools(deps.db, q.limit)));
  }));
  app.post("/api/pools", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const body = CreatePoolRequest.parse(await c.req.json());
    if (body.triggerLabel === "self-hosted" || ["linux", "windows", "macos", "x64", "arm64"].includes(body.triggerLabel)) return error(c, 400, "reserved_trigger_label", "Trigger label is reserved");
    const [worker] = await deps.db`SELECT platform,guest_platforms AS "guestPlatforms",admission_state AS "admissionState",connection_state AS "connectionState",configuration_state AS "configurationState",draining FROM workers WHERE id=${body.workerId}`;
    if (!worker) return error(c, 404, "not_found", "Resource not found");
    if (worker.admissionState !== "adopted" || worker.connectionState !== "online" || worker.configurationState !== "ready" || worker.draining) return error(c, 422, "worker_not_ready", "Worker is not ready");
    if (!(Array.isArray(worker.guestPlatforms) ? worker.guestPlatforms : [worker.platform]).includes(body.guestPlatform)) return error(c, 422, "worker_guest_platform_unsupported", "Worker does not support the requested guest platform");
    const driver = worker.platform === "linux-x64" ? "kata-k3s" : worker.platform === "windows-x64" ? "windows-hyperv-container" : "tart-vm";
    const labels = [body.triggerLabel];
    const [duplicate] = await deps.db`SELECT id,name,trigger_label AS "triggerLabel" FROM runner_pools WHERE organization_id IS NULL AND (name=${body.name} OR trigger_label=${body.triggerLabel}) LIMIT 1`;
    if (duplicate) {
      if (duplicate.name !== body.name || duplicate.triggerLabel !== body.triggerLabel) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
      await deps.db`UPDATE runner_pools SET worker_id=NULL,platform=${body.guestPlatform},driver=${driver},image_digest=${body.imageDigest},resources=${JSON.stringify(body.resources)},labels=${JSON.stringify(labels)},enabled=true WHERE id=${duplicate.id}`;
      return c.json({ id: String(duplicate.id), labels });
    }
    const [pool] = await deps.db`INSERT INTO runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) VALUES (NULL,NULL,${body.name},${body.guestPlatform},${driver},${body.imageDigest},${JSON.stringify(body.resources)},${JSON.stringify(labels)},${body.triggerLabel},true) RETURNING id`;
    await deps.db`INSERT INTO audit_events (organization_id,actor,type,payload) VALUES (NULL,${c.get("user").id},'pool.created',${JSON.stringify({ poolId: pool.id, workerId: body.workerId, guestPlatform: body.guestPlatform, triggerLabel: body.triggerLabel, scope: "control-plane" })})`;
    return c.json({ id: String(pool.id), labels });
  }));
  app.post("/api/pools/:poolId/:action", safe(async (c) => {
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const action = c.req.param("action");
    if (!["enable", "disable"].includes(action)) return error(c, 404, "not_found", "Resource not found");
    const idem = requireMutation(c); if (idem) return idem;
    const rows = await deps.db`UPDATE runner_pools SET enabled=${action === "enable"} WHERE id=${c.req.param("poolId")} AND organization_id IS NULL RETURNING id`;
    if (!rows[0]) return error(c, 404, "not_found", "Resource not found");
    return c.json({ ok: true });
  }));
  app.post("/api/organizations/:organizationId/pools", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const body = CreatePoolRequest.parse(await c.req.json());
    if (body.triggerLabel === "self-hosted" || ["linux", "windows", "macos", "x64", "arm64"].includes(body.triggerLabel)) return error(c, 400, "reserved_trigger_label", "Trigger label is reserved");
    const [w] = await deps.db`SELECT platform,guest_platforms AS "guestPlatforms",admission_state AS "admissionState",connection_state AS "connectionState",configuration_state AS "configurationState",draining,limits FROM workers WHERE id=${body.workerId}`;
    if (!w) return error(c, 404, "not_found", "Resource not found");
    if (w.admissionState !== "adopted" || w.connectionState !== "online" || w.configurationState !== "ready" || w.draining) return error(c, 422, "worker_not_ready", "Worker is not ready");
    if (!(Array.isArray(w.guestPlatforms) ? w.guestPlatforms : [w.platform]).includes(body.guestPlatform)) return error(c, 422, "worker_guest_platform_unsupported", "Worker does not support the requested guest platform");
    const driver = w.platform === "linux-x64" ? "kata-k3s" : w.platform === "windows-x64" ? "windows-hyperv-container" : "tart-vm";
    const labels = [body.triggerLabel];
    const [duplicate] = await deps.db`SELECT id,name,trigger_label AS "triggerLabel" FROM runner_pools WHERE organization_id IS NULL AND (name=${body.name} OR trigger_label=${body.triggerLabel})`;
    if (body.poolId) {
      const [existing] = await deps.db`SELECT id FROM runner_pools WHERE id=${body.poolId} AND organization_id IS NULL`;
      if (!existing) return error(c, 404, "not_found", "Resource not found");
      if (duplicate && String(duplicate.id) !== body.poolId) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
      await deps.db`UPDATE runner_pools SET worker_id=NULL,platform=${body.guestPlatform},driver=${driver},image_digest=${body.imageDigest},resources=${JSON.stringify(body.resources)},labels=${JSON.stringify(labels)},name=${body.name},trigger_label=${body.triggerLabel},enabled=true WHERE id=${body.poolId}`;
      await invalidateDashboard(deps.db, org, ["pools", "onboarding"]);
      return c.json({ id: body.poolId, labels });
    }
    if (duplicate) {
      if (duplicate.name !== body.name || duplicate.triggerLabel !== body.triggerLabel) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
      await deps.db`UPDATE runner_pools SET worker_id=NULL,platform=${body.guestPlatform},driver=${driver},image_digest=${body.imageDigest},resources=${JSON.stringify(body.resources)}::jsonb,labels=${JSON.stringify(labels)}::jsonb,enabled=true WHERE id=${duplicate.id}`;
      await completeOnboardingIfReady(deps.db);
      await invalidateDashboard(deps.db, org, ["pools", "onboarding"]);
      return c.json({ id: String(duplicate.id), labels });
    }
    const key = c.req.header("idempotency-key")!;
    if (!(await dashboardMutation(deps.db, org, key))) return c.json({ ok: true });
    const [pool] = await deps.db`INSERT INTO runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) VALUES (NULL,NULL,${body.name},${body.guestPlatform},${driver},${body.imageDigest},${JSON.stringify(body.resources)}::jsonb,${JSON.stringify(labels)}::jsonb,${body.triggerLabel},true) RETURNING id`;
    await deps.db`INSERT INTO audit_events (organization_id,actor,type,payload) VALUES (NULL,${c.get("user").id},'pool.created',${JSON.stringify({ poolId: pool.id, workerId: body.workerId, guestPlatform: body.guestPlatform, triggerLabel: body.triggerLabel, scope: "control-plane" })}::jsonb)`;
    await completeOnboardingIfReady(deps.db);
    await invalidateDashboard(deps.db, org, ["pools", "onboarding"]);
    return c.json({ id: pool.id, labels });
  }));
  app.post("/api/organizations/:organizationId/pools/:poolId/:action", safe(async (c) => {
    const org = c.req.param("organizationId"), action = c.req.param("action");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!["enable", "disable", "rotate-key"].includes(action)) return error(c, 404, "not_found", "Resource not found");
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const key = c.req.header("idempotency-key")!;
    if (!(await dashboardMutation(deps.db, org, key))) return c.json({ ok: true });
    if (action !== "rotate-key") await deps.db`UPDATE runner_pools SET enabled=${action === "enable"} WHERE organization_id=${org} AND id=${c.req.param("poolId")}`;
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
    const body = z.object({ selectedPaths: z.array(z.string()).default([]) }).strict().parse(await c.req.json());
    try { return c.json(RunnerWorkflowPreview.parse(await deps.githubApp.previewRepositoryRunnerPr({ organizationId: org, repositoryId: c.req.param("repositoryId"), selectedPaths: body.selectedPaths }))); }
    catch (cause) { const code = cause instanceof Error ? cause.message : ""; if (code === "github_repository_unavailable") return error(c, 404, "repository_unavailable", "Repository is unavailable"); if (code === "github_403") return githubWorkflowPermissionError(c); if (code === "github_runner_pool_missing") return error(c, 422, "runner_pool_missing", "Runner pool is not configured"); if (/Invalid|Malformed|Unsupported|not discovered|no-op/i.test(code)) return error(c, 422, "workflow_invalid", code); throw cause; }
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
      await deps.db`UPDATE dashboard_mutations SET response=${JSON.stringify(result)}::jsonb WHERE organization_id=${org} AND idempotency_key=${key}`;
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
