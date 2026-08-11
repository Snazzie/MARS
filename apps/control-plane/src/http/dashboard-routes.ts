import { Hono } from "hono";
import { z } from "zod";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { listOrganizations, getOverview, listRepositories, listRuns, getRunDetail, listLogChunks, listWorkers, getWorkerDetail, listPools, getOrganizationSettings, updateOrganizationSettings, dashboardMutation, invalidateDashboard } from "@whitesmith/db";
import { adoptWorker } from "../workers.ts";
import { ApiError, OverviewDto, CursorPage, OrganizationSummary, RepositorySummary, RunSummary, RunDetail, LogChunk, WorkerDetail, PoolSummary, OrganizationSettings } from "@whitesmith/contracts";

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

export function registerDashboardRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const safe = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => { try { return await fn(c); } catch (cause) { if (cause instanceof z.ZodError) return error(c, 400, "invalid_request", "Invalid request", { issues: cause.issues }); console.error(cause); return error(c, 500, "internal_error", "Internal server error"); } };
  app.get("/api/me", (c) => c.json(c.get("user")));
  app.get("/api/organizations", safe(async (c) => c.json(OrganizationSummary.array().parse(await listOrganizations(deps.db, c.get("user").id)))));
  app.get("/api/organizations/:organizationId/overview", safe(async (c) => { const denied = await guard(c, deps, c.req.param("organizationId")); if (denied) return denied; const period = periodSchema.safeParse(c.req.query("period") || "24h"); if (!period.success) return error(c, 400, "invalid_period", "Invalid overview period", { issues: period.error.issues }); return c.json(OverviewDto.parse(await getOverview(deps.db, c.req.param("organizationId"), period.data))); }));
  for (const [path, fn, schema] of [["repositories", listRepositories, RepositorySummary], ["runs", listRuns, RunSummary], ["pools", listPools, PoolSummary], ["workers", listWorkers, WorkerDetail]] as const) app.get(`/api/organizations/:organizationId/${path}`, safe(async (c) => { const org = c.req.param("organizationId"); const denied = await guard(c, deps, org); if (denied) return denied; const q = parseQuery(c); if (q instanceof Response) return q; return c.json(CursorPage(schema).parse(await fn(deps.db, org, q.limit))); }));
  app.get("/api/organizations/:organizationId/runs/:runId", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const value=await getRunDetail(deps.db,org,c.req.param("runId")); return value?c.json(RunDetail.parse(value)):error(c,404,"not_found","Resource not found"); }));
  app.get("/api/organizations/:organizationId/runs/:runId/jobs/:jobId/logs", safe(async (c) => { const org=c.req.param("organizationId"); const denied=await guard(c,deps,org); if(denied)return denied; const q=logSchema.safeParse(c.req.query()); if(!q.success)return error(c,400,"invalid_log_bounds","Invalid log bounds",{issues:q.error.issues}); return c.json(CursorPage(LogChunk).parse(await listLogChunks(deps.db,org,c.req.param("runId"),c.req.param("jobId"),q.data.after,q.data.limit))); }));
  app.get("/api/organizations/:organizationId/settings", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;return c.json(OrganizationSettings.parse(await getOrganizationSettings(deps.db,org)));}));
  app.put("/api/organizations/:organizationId/settings", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;const idem=requireMutation(c);if(idem)return idem;if(!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");const key=c.req.header("idempotency-key")!;if(!(await dashboardMutation(deps.db,org,key)))return c.json(OrganizationSettings.parse(await getOrganizationSettings(deps.db,org)));const value=await updateOrganizationSettings(deps.db,OrganizationSettings.parse({...await c.req.json(),organizationId:org}));await invalidateDashboard(deps.db,org,["settings"]);return c.json(OrganizationSettings.parse(value));}));
  app.get("/api/organizations/:organizationId/workers/:workerId", safe(async(c)=>{const org=c.req.param("organizationId");const denied=await guard(c,deps,org);if(denied)return denied;const value=await getWorkerDetail(deps.db,org,c.req.param("workerId"));return value?c.json(WorkerDetail.parse(value)):error(c,404,"not_found","Resource not found");}));
  app.post("/api/organizations/:organizationId/workers/:workerId/:action", safe(async(c)=>{const org=c.req.param("organizationId"), action=c.req.param("action"), id=c.req.param("workerId");const denied=await guard(c,deps,org);if(denied)return denied;if(!["adopt","reject","drain","remove"].includes(action))return error(c,404,"not_found","Resource not found");const idem=requireMutation(c);if(idem)return idem;const value=await getWorkerDetail(deps.db,org,id);if(!value)return error(c,404,"not_found","Resource not found");if(["adopt","reject","remove"].includes(action)&&!c.get("user").isGlobalAdmin)return error(c,403,"forbidden","Global administrator authorization required");mutationSchema.parse(await c.req.json().catch(()=>({})));if(action==="adopt")await adoptWorker(deps.db,id,c.get("user").id);else if(action==="reject")await deps.db`UPDATE workers SET admission_state='rejected' WHERE id=${id} AND organization_id=${org} AND admission_state='pending'`;else if(action==="drain")await deps.db`UPDATE workers SET draining=true WHERE id=${id} AND organization_id=${org}`;else await deps.db`UPDATE workers SET admission_state='revoked' WHERE id=${id} AND organization_id=${org}`;return c.json({ok:true});}));
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
  app.post("/api/organizations/:organizationId/repositories/:repositoryId/:action", safe(async (c) => {
    const org = c.req.param("organizationId"), action = c.req.param("action");
    const denied = await guard(c, deps, org); if (denied) return denied;
    if (!["approve", "reject"].includes(action)) return error(c, 404, "not_found", "Resource not found");
    if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
    const idem = requireMutation(c); if (idem) return idem;
    const key = c.req.header("idempotency-key")!;
    if (!(await dashboardMutation(deps.db, org, key))) return c.json({ ok: true });
    await deps.db`UPDATE dashboard_installations i SET approved=${action === "approve"} FROM dashboard_repositories r WHERE r.organization_id=${org} AND r.id=${c.req.param("repositoryId")} AND i.organization_id=r.organization_id AND i.id=r.installation_id`;
    await invalidateDashboard(deps.db, org, ["repositories"]); return c.json({ ok: true });
  }));
}
