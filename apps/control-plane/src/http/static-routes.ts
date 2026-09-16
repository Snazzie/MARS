import type { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";

const clientRoutes: Record<string, true> = { "/": true, "/onboarding": true, "/settings": true, "/runs": true, "/repositories": true, "/workers": true, "/pools": true };

async function assetResponse(deps: ControlPlaneHttpDeps, name: string, fallback = "", contentType = "text/html; charset=utf-8"): Promise<Response> {
  const file = Bun.file(new URL(name, deps.webRoot));
  if (await file.exists()) {
    return new Response(file, { headers: { "Cache-Control": "no-cache", "Content-Type": contentType } });
  }
  return new Response(fallback, { headers: { "Cache-Control": "no-cache", "Content-Type": contentType } });
}

export function registerStaticRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps): void {
  app.get("/index.html", async () => assetResponse(deps, "index.html", "<!doctype html><title>Mars</title>"));
  app.get("/index.js", async () => assetResponse(deps, "index.js", "", "text/javascript; charset=utf-8"));
  app.get("/index.css", async () => assetResponse(deps, "index.css", "", "text/css; charset=utf-8"));
  app.get("/mars-icon.svg", async () => assetResponse(deps, "mars-icon.svg", "", "image/svg+xml"));
  app.get("/mars-icon.ico", async () => assetResponse(deps, "MARS.ico", "", "image/x-icon"));
  for (const path of Object.keys(clientRoutes)) {
    app.get(path, async () => assetResponse(deps, "index.html", "<!doctype html><title>Mars</title>"));
  }
  app.get("/runs/:runId", async () => assetResponse(deps, "index.html", "<!doctype html><title>Mars</title>"));
  app.get("/workers/:workerId", async () => assetResponse(deps, "index.html", "<!doctype html><title>Mars</title>"));
}

