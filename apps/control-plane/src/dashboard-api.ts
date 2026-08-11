import { z } from "zod";
import type { DashboardDb } from "@whitesmith/db";
import { listOrganizations, getOverview, listRepositories, listRuns, getRunDetail, listLogChunks, listWorkers, getWorkerDetail } from "@whitesmith/db";
import { adoptWorker } from "./workers.ts";
import type { SessionUser } from "./auth.ts";
import { ApiError, OverviewDto, CursorPage, OrganizationSummary, RepositorySummary, RunSummary, RunDetail, LogChunk, WorkerDetail } from "@whitesmith/contracts";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional() }).strict();
const periodSchema = z.enum(["24h", "7d", "30d"]);
const logSchema = z.object({ after: z.coerce.number().int().min(-1).default(-1), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();
const mutationSchema = z.object({}).strict();

type DashboardHandlerDeps = { db: DashboardDb; requestId?: () => string };
type HandlerResult = Response | null;

function requestId(request: Request, deps: DashboardHandlerDeps): string { return request.headers.get("x-request-id") || deps.requestId?.() || crypto.randomUUID(); }
function error(request: Request, deps: DashboardHandlerDeps, status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return Response.json(ApiError.parse({ code, message, requestId: requestId(request, deps), ...(details ? { details } : {}) }), { status, headers: { "cache-control": "no-store" } });
}
function parseQuery(request: Request, deps: DashboardHandlerDeps) { const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams)); return parsed.success ? parsed.data : error(request, deps, 400, "invalid_query", "Invalid query parameters", { issues: parsed.error.issues }); }
function requireMutation(request: Request, deps: DashboardHandlerDeps): Response | null { if (!request.headers.get("idempotency-key")?.trim()) return error(request, deps, 400, "missing_idempotency_key", "Idempotency-Key is required"); return null; }

async function member(db: DashboardDb, user: SessionUser, organizationId: string): Promise<boolean> {
  if (user.isGlobalAdmin) return true;
  const [row] = await db`SELECT 1 FROM memberships WHERE user_id=${user.id} AND organization_id=${organizationId}`;
  return Boolean(row);
}
async function orgResource(db: DashboardDb, user: SessionUser, organizationId: string, request: Request, deps: DashboardHandlerDeps): Promise<Response | null> {
  return await member(db, user, organizationId) ? null : error(request, deps, 404, "not_found", "Resource not found");
}

export function createDashboardApi(deps: DashboardHandlerDeps) {
  return async function dashboardApi(request: Request, user: SessionUser): Promise<HandlerResult> {
    const url = new URL(request.url); const path = url.pathname;
    try {
      if (request.method === "GET" && (path === "/api/organizations" || path === "/api/v1/organizations")) return Response.json(OrganizationSummary.array().parse(await listOrganizations(deps.db, user.id)));
      const orgMatch = path.match(/^\/api(?:\/v1)?\/organizations\/([^/]+)(?:\/(.*))?$/); if (!orgMatch) return null;
      const organizationId = decodeURIComponent(orgMatch[1]); const tail = orgMatch[2] ?? "";
      const denied = await orgResource(deps.db, user, organizationId, request, deps); if (denied) return denied;
      if (request.method === "GET" && tail === "overview") { const period = periodSchema.safeParse(url.searchParams.get("period") ?? "24h"); if (!period.success) return error(request, deps, 400, "invalid_period", "Invalid overview period", { issues: period.error.issues }); return Response.json(OverviewDto.parse(await getOverview(deps.db, organizationId, period.data))); }
      if (request.method === "GET" && tail === "repositories") { const q = parseQuery(request, deps); if (q instanceof Response) return q; return Response.json(CursorPage(RepositorySummary).parse(await listRepositories(deps.db, organizationId, q.limit))); }
      if (request.method === "GET" && tail === "runs") { const q = parseQuery(request, deps); if (q instanceof Response) return q; return Response.json(CursorPage(RunSummary).parse(await listRuns(deps.db, organizationId, q.limit))); }
      const run = tail.match(/^runs\/([^/]+)$/); if (request.method === "GET" && run) { const value = await getRunDetail(deps.db, organizationId, run[1]); return value ? Response.json(RunDetail.parse(value)) : error(request, deps, 404, "not_found", "Resource not found"); }
      const logs = tail.match(/^runs\/([^/]+)\/jobs\/([^/]+)\/logs$/); if (request.method === "GET" && logs) { const q = logSchema.safeParse(Object.fromEntries(url.searchParams)); if (!q.success) return error(request, deps, 400, "invalid_log_bounds", "Invalid log bounds", { issues: q.error.issues }); return Response.json(CursorPage(LogChunk).parse(await listLogChunks(deps.db, organizationId, logs[1], logs[2], q.data.after, q.data.limit))); }
      if (request.method === "GET" && tail === "workers") { const q = parseQuery(request, deps); if (q instanceof Response) return q; return Response.json(CursorPage(WorkerDetail).parse(await listWorkers(deps.db, organizationId, q.limit))); }
      const worker = tail.match(/^workers\/([^/]+)(?:\/(adopt|reject|drain|remove))?$/); if (worker) {
        const workerId = worker[1]; const action = worker[2];
        if (!action && request.method === "GET") { const value = await getWorkerDetail(deps.db, organizationId, workerId); return value ? Response.json(WorkerDetail.parse(value)) : error(request, deps, 404, "not_found", "Resource not found"); }
        if (request.method !== "POST" || !action) return error(request, deps, 405, "method_not_allowed", "Method not allowed");
        const idem = requireMutation(request, deps); if (idem) return idem;
        const value = await getWorkerDetail(deps.db, organizationId, workerId); if (!value) return error(request, deps, 404, "not_found", "Resource not found");
        if (["adopt", "reject", "remove"].includes(action) && !user.isGlobalAdmin) return error(request, deps, 403, "forbidden", "Global administrator authorization required");
        mutationSchema.parse(await request.json().catch(() => ({})));
        if (action === "adopt") await adoptWorker(deps.db, workerId, user.id);
        else if (action === "reject") await deps.db`UPDATE workers SET admission_state='rejected' WHERE id=${workerId} AND organization_id=${organizationId} AND admission_state='pending'`;
        else if (action === "drain") await deps.db`UPDATE workers SET draining=true WHERE id=${workerId} AND organization_id=${organizationId}`;
        else await deps.db`UPDATE workers SET admission_state='revoked' WHERE id=${workerId} AND organization_id=${organizationId}`;
        return Response.json({ ok: true });
      }
      return error(request, deps, 404, "not_found", "Resource not found");
    } catch (cause) { if (cause instanceof z.ZodError) return error(request, deps, 400, "invalid_request", "Invalid request", { issues: cause.issues }); console.error(cause); return error(request, deps, 500, "internal_error", "Internal server error"); }
  };
}
