import { Hono } from "hono";
import type { Context } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { verifyWorkerBootstrap, initializeWorkerBootstrap } from "../worker-bootstrap.ts";
import { fingerprint, adoptWorker as adoptPendingWorker } from "../workers.ts";
export function registerWorkerRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const auth = async (c: Context<ControlPlaneEnv>) => deps.currentUser(c.req.raw);
  app.post("/api/workers/join", async (c) => { const body = await c.req.json<{code:string;publicKey:string;platform:string;vmUuid:string;limits:Record<string,number>}>(); if (!await verifyWorkerBootstrap(deps.db, body.code)) return c.json({ error: "invalid or rotated bootstrap credential" }, 401); const [worker] = await deps.db`insert into workers (name,platform,admission_state,public_key,fingerprint,vm_uuid,limits,last_requested_at) values (${body.vmUuid},${body.platform},'pending',${body.publicKey},${fingerprint(body.publicKey)},${body.vmUuid},${JSON.stringify(body.limits)},now()) returning id,fingerprint`; return c.json({ workerId: worker.id, fingerprint: worker.fingerprint }, 201); });
  app.post("/api/workers/enroll", async (c) => { const user = await auth(c); if (!user) return c.json({ code: "unauthorized", message: "Authentication required", requestId: deps.requestId() }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); const e = await initializeWorkerBootstrap(deps.db, user.id); return c.json({ code: e.code, generation: e.generation, createdAt: e.createdAt, installer: `${deps.baseUrl}/api/workers/installer` }, 201); });
  app.post("/api/workers/:workerId/adopt", async (c) => { const user = await auth(c); if (!user) return c.json({ code: "unauthorized", message: "Authentication required", requestId: deps.requestId() }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); await adoptPendingWorker(deps.db, c.req.param("workerId"), user.id); deps.onWorkerAdopted(c.req.param("workerId")); return c.json({ ok: true }); });
}
