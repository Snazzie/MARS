import { Hono } from "hono";
import type { Context } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { createDashboardApi } from "../dashboard-api.ts";

export function registerDashboardRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const handler = createDashboardApi({ db: deps.db, requestId: deps.requestId });
  const paths = ["/api/me", "/api/organizations", "/api/organizations/:organizationId/*", "/api/organizations/:organizationId", "/api/organizations/:organizationId/overview", "/api/organizations/:organizationId/runs", "/api/organizations/:organizationId/runs/:runId", "/api/organizations/:organizationId/runs/:runId/jobs/:jobId/logs", "/api/organizations/:organizationId/repositories", "/api/organizations/:organizationId/workers", "/api/organizations/:organizationId/workers/:workerId", "/api/organizations/:organizationId/workers/:workerId/:action", "/api/organizations/:organizationId/pools", "/api/organizations/:organizationId/pools/:poolId/:action", "/api/organizations/:organizationId/settings"];
  for (const path of paths) { app.on(["GET", "POST", "PUT"], path, async (c) => (await handler(c.req.raw, c.get("user"))) ?? c.json({ code: "not_found", message: "Resource not found", requestId: deps.requestId() }, 404)); }
}
