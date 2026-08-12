import { createMiddleware } from "hono/factory";
import { Hono } from "hono";
import { registerStaticRoutes } from "./static-routes.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { registerGithubRoutes } from "./github-routes.ts";
import { registerDashboardRoutes } from "./dashboard-routes.ts";
import { registerWorkerRoutes } from "./worker-routes.ts";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";

export function requireSession(deps: ControlPlaneHttpDeps) {
  return createMiddleware<ControlPlaneEnv>(async (c, next) => {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ code: "unauthorized", message: "Authentication required", requestId: deps.requestId() }, 401);
    c.set("user", user);
    await next();
  });
}

export function createControlPlaneApp(deps: ControlPlaneHttpDeps) {
  const app = new Hono<ControlPlaneEnv>();
  app.get("/api/healthz", (c) => c.json({ ok: true }));
  registerAuthRoutes(app, deps);
  registerGithubRoutes(app, deps);
  registerStaticRoutes(app, deps);
  const protectedApi = new Hono<ControlPlaneEnv>();
  protectedApi.use("/api/organizations/*", requireSession(deps));
  protectedApi.use("/api/organizations", requireSession(deps));
  protectedApi.use("/api/me", requireSession(deps));
  registerDashboardRoutes(protectedApi, deps);
  registerWorkerRoutes(app, deps);
  app.route("/", protectedApi);
  app.notFound((c) => c.req.path.startsWith("/api/") ? c.json({ code: "not_found", message: "Resource not found", requestId: deps.requestId() }, 404) : c.text("Not found", 404));
  app.onError((cause, c) => {
    console.error(cause);
    return c.req.path.startsWith("/api/") ? c.json({ code: "internal_error", message: "Internal server error", requestId: deps.requestId() }, 500) : c.text("Internal server error", 500);
  });
  return app;
}
