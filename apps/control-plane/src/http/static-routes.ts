import type { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";

const clientRoutes: Record<string, true> = { "/": true, "/settings": true, "/runs": true, "/repositories": true, "/workers": true, "/pools": true };

async function assetResponse(deps: ControlPlaneHttpDeps, name: string, fallback = ""): Promise<Response> {
  const file = Bun.file(new URL(name, deps.webRoot));
  if (await file.exists()) {
    return new Response(file, { headers: { "Cache-Control": "no-cache" } });
  }
  return new Response(fallback, { headers: { "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" } });
}

export function registerStaticRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps): void {
  app.get("/index.html", async () => assetResponse(deps, "index.html", "<!doctype html><title>Whitesmith</title>"));
  app.get("/index.js", async () => assetResponse(deps, "index.js"));
  app.get("/styles.css", async () => assetResponse(deps, "styles.css", ""));
  for (const path of Object.keys(clientRoutes)) {
    app.get(path, async () => assetResponse(deps, "index.html", "<!doctype html><title>Whitesmith</title>"));
  }
  app.get("/runs/:runId", async () => assetResponse(deps, "index.html", "<!doctype html><title>Whitesmith</title>"));
}
