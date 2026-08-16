import { createMiddleware } from "hono/factory";
import { Hono } from "hono";
import { registerStaticRoutes } from "./static-routes.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { registerGithubRoutes } from "./github-routes.ts";
import { registerDashboardRoutes } from "./dashboard-routes.ts";
import { registerOnboardingRoutes } from "./onboarding-routes.ts";
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
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (new URL(deps.baseUrl).protocol === "https:") c.header("Strict-Transport-Security", "max-age=31536000");
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com");
  });
  app.get("/api/livez", (c) => c.json({ ok: true }));
  app.get("/api/readyz", async (c) => {
    const health = deps.health();
    try {
      await deps.db`SELECT 1`;
    } catch {
      return c.json({ ok: false, checks: { database: false, discovery: !health.discovery.stale }, ...health }, 503);
    }
    const ok = !health.discovery.stale;
    return c.json({ ok, checks: { database: true, discovery: ok }, ...health }, ok ? 200 : 503);
  });
  app.get("/api/healthz", (c) => {
    const health = deps.health();
    return c.json({ ok: !health.discovery.stale, ...health }, health.discovery.stale ? 503 : 200);
  });
  registerAuthRoutes(app, deps);
  registerGithubRoutes(app, deps);
  registerOnboardingRoutes(app, deps);
  registerStaticRoutes(app, deps);
  const protectedApi = new Hono<ControlPlaneEnv>();
  protectedApi.use("/api/organizations/*", requireSession(deps));
  protectedApi.use("/api/organizations", requireSession(deps));
  protectedApi.use("/api/pools", requireSession(deps));
  protectedApi.use("/api/pools/*", requireSession(deps));
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
