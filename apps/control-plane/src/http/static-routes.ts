import type { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";

async function assetResponse(deps: ControlPlaneHttpDeps, name: string, fallback = "", contentType = "text/html; charset=utf-8"): Promise<Response> {
  const file = Bun.file(new URL(name, deps.webRoot));
  if (await file.exists()) {
    return new Response(file, { headers: { "Cache-Control": "no-cache", "Content-Type": contentType } });
  }
  return new Response(fallback, { headers: { "Cache-Control": "no-cache", "Content-Type": contentType } });
}

export function registerStaticRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps): void {
  app.get("/_authenticated/cost-center", (c) => {
    const url = new URL(c.req.url);
    return new Response(null, { status: 308, headers: { Location: `/cost-center${url.search}` } });
  });
  app.get("/index.html", async () => assetResponse(deps, "index.html", "<!doctype html><title>Mars</title>"));
  app.get("/index.js", async () => assetResponse(deps, "index.js", "", "text/javascript; charset=utf-8"));
  app.get("/index.css", async () => assetResponse(deps, "index.css", "", "text/css; charset=utf-8"));
  app.get("/mars-icon.svg", async () => assetResponse(deps, "mars-icon.svg", "", "image/svg+xml"));
  app.get("/mars-icon.ico", async () => assetResponse(deps, "MARS.ico", "", "image/x-icon"));
  // Register after API routes so direct navigation reaches the client router
  // without turning missing API endpoints or assets into successful HTML.
  app.get("*", async (c) => {
    const path = c.req.path;
    if (path === "/api" || path.startsWith("/api/") || /\/[^/]*\.[^/]+\/?$/.test(path)) {
      return c.notFound();
    }
    return assetResponse(deps, "index.html", "<!doctype html><title>Mars</title>");
  });
}

