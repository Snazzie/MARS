import { Hono } from "hono";
import { z } from "zod";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { listOrganizations, getOverview, getAllOverview, listRepositories, listAllRepositories, listRuns, listAllRuns, getRunDetail, listLogChunks, listWorkers, listAllWorkers, getWorkerDetail, listPools, listAllPools, getOrganizationSettings, updateOrganizationSettings, dashboardMutation, invalidateDashboard, completeOnboardingIfReady } from "@whitesmith/db";
import { adoptWorker } from "../workers.ts";
import { ApiError, OverviewDto, CursorPage, OrganizationSummary, RepositorySummary, RunSummary, RunDetail, LogChunk, WorkerDetail, PoolSummary, OrganizationSettings, CreatePoolRequest } from "@whitesmith/contracts";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional() }).strict();
const periodSchema = z.enum(["24h", "7d", "30d"]);
const logSchema = z.object({ after: z.coerce.number().int().min(-1).default(-1), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();
const mutationSchema = z.object({}).strict();

function error(c: any, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return c.json(ApiError.parse({ code, message, requestId: c.req.header("x-request-id") || crypto.randomUUID(), ...(details ? { details } : {}) }), status, { "cache-control": "no-store" });
}
function parseQuery(c: any) { const parsed = querySchema.safeParse(c.req.query()); return parsed.success ? parsed.data : error(c, 400, "invalid_query", "Invalid query parameters", { issues: parsed.error.issues }); }
function requireMutation(c: any) { return c.req.header("idempotency-key")?.trim() ? null : error(c, 400, "missing_idempotency_key", "Idempotency-Key is required"); }
async function member(db: any, user: any, organizationId: string) { if (user.isGlobalAdmin) return true; const [row] = await db`SELECT 1 FROM memberships WHERE user_id=${user.id} AND organization_id=${organizationId}`; return Boolean(row); }
async function guard(c: any, deps: ControlPlaneHttpDeps, organizationId: string) { return await member(deps.db, c.get("user"), organizationId) ? null : error(c, 404, "not_found", "Resource not found"); }
function githubInstallationLocation(row: { login?: unknown; githubInstallationId?: unknown }) {
  if (typeof row.login !== "string" || !row.login || !Number.isSafeInteger(Number(row.githubInstallationId))) return null;
  return `https://github.com/organizations/${encodeURIComponent(row.login)}/settings/installations/${Number(row.githubInstallationId)}`;
}

export function registerDashboardRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const safe = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { try { return await fn(c); } catch (cause) { if (cause instanceof z.ZodError) return error(c, 400, "invalid_request", "Invalid request", { issues: cause.issues }); console.error(cause); return error(c, 500, "internal_error", "Internal server error"); } };
  app.get("/api/me", (c) => c.json(c.get("user")));
  app.get("/api/organizations", safe(async (c) => c.json(OrganizationSummary.array().parse(await listOrganizations(deps.db, c.get("user").id)))));
  app.get("/api/organizations/:organizationId/overview", safe(async (c) => { const org = c.req.param("organizationId"); const period = periodSchema.safeParse(c.req.query("period") || "24h"); if (!period.success) return error(c, 400, "invalid_period", "Invalid period", { issues: period.error.issues }); if (org === "all") return c.json(OverviewDto.parse(await getAllOverview(deps.db, c.get("user").id, period.data))); const denied = await guard(c, deps, org); if (denied) return denied; return c.json(OverviewDto.parse(await getOverview(deps.db, org, period.data))); }));
  for (const [path, fn, allFn, schema] of [["repositories", listRepositories, listAllRepositories, RepositorySummary], ["runs", listRuns, listAllRuns, RunSummary], ["pools", listPools, listAllPools, PoolSummary], ["workers", listWorkers, listAllWorkers, WorkerDetail]] as const) app.get(`/api/organizations/:organizationId/${path}`, safe(async (c) => { const org = c.req.param("organizationId"); const q = parseQuery(c); if (q instanceof Response) return q; if (org === "all") return c.json(CursorPage(schema).parse(await allFn(deps.db, c.get("user").id, q.limit))); const denied = await guard(c, deps, org); if (denied) return denied; return c.json(CursorPage(schema).parse(await fn(deps.db, org, q.limit))); }));
  app.get("/api/organizations/:organizationId/runs/:runId", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const value=await getRunDetail(deps.db,org,c.req.param("runId")); return value?c.json(RunDetail.parse(value)):error(c,404,"not_found","Resource not found"); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/logs", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const q=logSchema.safeParse(c.req.query()); if(!q.success)return error(c,400,"invalid_log_bounds","Invalid log bounds",{issues:q.error.issues}); return c.json(CursorPage(LogChunk).parse(await listLogChunks(deps.db,org,c.req.param("runId"),c.req.param("jobId"),q.data.after,q.data.limit))); }));
  app.get("/api/organizations/:organizationId/settings", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;return c.json(OrganizationSettings.parse(await getOrganizationSettings(deps.db,org)));}));
  app.put("/api/organizations/:organizationId/settings", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;if(!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");const idem=requireMutation(c);if(idem)return idem;const body=OrganizationSettings.parse({...await c.req.json(),organizationId:org});const key=c.req.header("idempotency-key")!;if(!(await dashboardMutation(deps.db,org,key)))return c.json(OrganizationSettings.parse(await getOrganizationSettings(deps.db,org)));const value=await updateOrganizationSettings(deps.db,body);await invalidateDashboard(deps.db,org,["settings"]);return c.json(OrganizationSettings.parse(value));}));
  app.get("/api/organizations/:organizationId/workers/:workerId", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;const value=await getWorkerDetail(deps.db,org,c.req.param("workerId"));return value?c.json(WorkerDetail.parse(value)):error(c,404,"not_found","Resource not found");}));
  app.post("/api/organizations/:organizationId/workers/:workerId/:action", safe(async(c)=>{const org=c.req.param("organizationId"), action=c.req.param("action"), id=c.req.param("workerId");const denied=await guard(c,deps,org);if(denied)return denied;if(!["adopt","reject","drain","remove"].includes(action))return error(c,404,"not_found","Resource not found");const idem=requireMutation(c);if(idem)return idem;const value=await getWorkerDetail(deps.db,org,id);if(!value)return error(c,404,"not_found","Resource not found");if(["adopt","reject","remove"].includes(action)&&!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");mutationSchema.parse(await c.req.json().catch(()=>({})));if(action==="adopt")await adoptWorker(deps.db,id,c.get("user").id);else if(action==="reject")await deps.db`UPDATE workers SET admission_state='rejected' WHERE id=${id} AND organization_id=${org} AND admission_state='pending'`;else if(action==="drain")await deps.db`UPDATE workers SET draining=true WHERE id=${id} AND organization_id=${org}`;else await deps.db`UPDATE workers SET admission_state='revoked' WHERE id=${id} AND organization_id=${org}`;return c.json({ok:true});}));
  app.post("/api/organizations/:organizationId/pools", safe(async (c) => {
    const org = c.req.param("organizationId");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const body = CreatePoolRequest.parse(await c.req.json());
    if (body.triggerLabel === "self-hosted" || ["linux", "windows", "macos", "x64", "arm64"].includes(body.triggerLabel)) return error(c, 400, "reserved_trigger_label", "Trigger label is reserved");
    const worker = await deps.db`SELECT platform,admission_state AS "admissionState",connection_state AS "connectionState",configuration_state AS "configurationState",draining,limits FROM workers WHERE organization_id=${org} AND id=${body.workerId}`;
    if (!worker[0]) return error(c, 404, "not_found", "Resource not found");
    const w = worker[0];
    if (w.admissionState !== "adopted" || w.connectionState !== "online" || w.configurationState !== "ready" || w.draining) return error(c, 422, "worker_not_ready", "Worker is not ready");
    const driver = w.platform === "linux-x64" ? "kata-k3s" : w.platform === "windows-x64" ? "windows-hyperv" : "tart-vm";
    const labels = w.platform === "linux-x64" ? ["self-hosted", "linux", "x64", body.triggerLabel] : w.platform === "windows-x64" ? ["self-hosted", "windows", "x64", body.triggerLabel] : ["self-hosted", "macos", "arm64", body.triggerLabel];
    const duplicate = await deps.db`SELECT 1 FROM runner_pools WHERE organization_id=${org} AND (name=${body.name} OR trigger_label=${body.triggerLabel})`;
    if (duplicate[0]) return error(c, 409, "pool_conflict", "Pool name or trigger label already exists");
    const key = c.req.header("idempotency-key")!;
    if (!(await dashboardMutation(deps.db, org, key))) return c.json({ ok: true });
    const [pool] = await deps.db`INSERT INTO runner_pools (organization_id,worker_id,name,platform,driver,image_digest,resources,labels,trigger_label,enabled) VALUES (${org},${body.workerId},${body.name},${w.platform},${driver},${body.imageDigest},${JSON.stringify(body.resources)},${JSON.stringify(labels)},${body.triggerLabel},true) RETURNING id`;
    await deps.db`INSERT INTO audit_events (organization_id,actor,type,payload) VALUES (${org},${c.get("user").id},'pool.created',${JSON.stringify({ poolId: pool.id, workerId: body.workerId, triggerLabel: body.triggerLabel })})`;
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
    const [installation] = await deps.db`SELECT o.login, i.github_installation_id AS "githubInstallationId" FROM organizations o JOIN dashboard_installations i ON i.organization_id=o.id WHERE o.id=${org} ORDER BY i.created_at DESC LIMIT 1`;
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
    const [installation] = await deps.db`SELECT o.login, i.github_installation_id AS "githubInstallationId" FROM organizations o JOIN dashboard_repositories r ON r.organization_id=o.id JOIN dashboard_installations i ON i.id=r.installation_id WHERE o.id=${org} AND r.id=${c.req.param("repositoryId")}`;
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
  app.post("/api/organizations/:organizationId/repositories/:repositoryId/:action", safe(async (c) => {
    const org = c.req.param("organizationId"), action = c.req.param("action");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!["approve", "reject"].includes(action)) return error(c, 404, "not_found", "Resource not found");
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const key = c.req.header("idempotency-key")!;
    const [updated] = await deps.db`UPDATE dashboard_repositories SET approved=${action === "approve"} WHERE organization_id=${org} AND id=${c.req.param("repositoryId")} AND available=true RETURNING id`;
    if (!updated) return error(c, 409, "repository_not_approvable", "Repository is unavailable or not eligible for Whitesmith approval");
    await invalidateDashboard(deps.db, org, ["repositories"]); return c.json({ ok: true });
  }));
}
