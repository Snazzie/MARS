import { Hono } from "hono";
import type { Context } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { verifyWorkerBootstrap, initializeWorkerBootstrap } from "../worker-bootstrap.ts";
import { fingerprint, adoptWorker as adoptPendingWorker } from "../workers.ts";

const attempts = new Map<string, { count: number; resetAt: number }>();
const limit = (source: string): boolean => { const now = Date.now(); const bucket = attempts.get(source); if (!bucket || bucket.resetAt <= now) { attempts.set(source, { count: 1, resetAt: now + 60_000 }); return true; } if (bucket.count >= 10) return false; bucket.count++; return true; };
export function registerWorkerRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const auth = async (c: Context<ControlPlaneEnv>) => deps.currentUser(c.req.raw);
  app.get("/api/workers/installer", async (c) => { const audience = c.req.query("audience"); const file = audience === "linux-x64" ? "install-worker.sh" : audience === "windows-x64" ? "install-worker.ps1" : audience === "macos-arm64" ? "install-worker-macos.sh" : null; if (!file) return c.json({ error: "unsupported installer audience" }, 400); return new Response(Bun.file(new URL(file, deps.workerInstallerRoot)), { headers: { "cache-control": "no-store" } }); });
  app.post("/api/workers/enroll", async (c) => { const user = await auth(c); if (!user) return c.json({ code: "unauthorized", message: "Authentication required", requestId: deps.requestId() }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); const audience = c.req.query("audience"); const e = await initializeWorkerBootstrap(deps.db, user.id); return c.json({ code: e.code, expiresAt: new Date(Date.parse(e.createdAt) + 15 * 60_000).toISOString(), installer: `${deps.baseUrl}/api/workers/installer${audience ? `?audience=${encodeURIComponent(audience)}` : ""}` }, 201); });
  app.get("/api/workers", async (c) => { const user = await auth(c); if (!user) return c.json({ code: "unauthorized", message: "Authentication required", requestId: deps.requestId() }, 401); return c.json(await deps.db`select id,name,platform,admission_state as "admissionState",connection_state as "connectionState",configuration_state as "configurationState",fingerprint,limits,doctor from workers order by created_at desc`); });
  app.post("/api/workers/:workerId/adopt", async (c) => { const user = await auth(c); if (!user) return c.json({ code: "unauthorized", message: "Authentication required", requestId: deps.requestId() }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); await adoptPendingWorker(deps.db, c.req.param("workerId"), user.id); deps.onWorkerAdopted(c.req.param("workerId")); return c.json({ ok: true }); });
}
