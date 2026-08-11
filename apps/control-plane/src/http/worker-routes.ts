import { Hono } from "hono";
import type { Context } from "hono";
import { PendingWorkerRequest } from "@whitesmith/contracts";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { verifyWorkerBootstrap, initializeWorkerBootstrap, rotateWorkerBootstrap, getWorkerBootstrapStatus } from "../worker-bootstrap.ts";
import { approvePendingWorker, createRequestLimiter, parseApproveWorkerRequest, requestPendingWorker, rejectPendingWorker } from "../worker-requests.ts";

function noStore(headers = new Headers()): Headers { headers.set("cache-control", "no-store"); return headers; }
function pendingWorkerDto(row: Record<string, unknown>) {
  const telemetry = (row.doctor && typeof row.doctor === "object" ? row.doctor : {}) as Record<string, unknown>;
  return PendingWorkerRequest.parse({ ...row, publicKey: row.publicKey, machineUuid: row.vmUuid, doctor: telemetry.doctor ?? {}, capacity: telemetry.capacity ?? {} });
}
function admin(c: Context<ControlPlaneEnv>): boolean { return c.get("user")?.isGlobalAdmin === true; }
function idempotency(c: Context<ControlPlaneEnv>): boolean { return Boolean(c.req.header("Idempotency-Key")?.trim()); }
export function registerWorkerRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const approvalBody = async (c: Context<ControlPlaneEnv>) => { try { return parseApproveWorkerRequest(await c.req.json()); } catch { return null; } };
  const limiter = deps.workerRequestLimiter ?? createRequestLimiter();
  const auth = async (c: Context<ControlPlaneEnv>) => deps.currentUser(c.req.raw);
  app.post("/api/workers/enroll", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); let body: { audience?: string }; try { body = await c.req.json<{ audience?: string }>(); if (body.audience !== undefined && !["linux-x64", "windows-x64", "macos-arm64"].includes(body.audience)) return c.json({ error: "unsupported installer audience" }, 400); } catch { return c.json({ error: "invalid enrollment request" }, 400); } const result = await initializeWorkerBootstrap(deps.db, user.id); const audience = c.req.query("audience") ?? body.audience; return c.json({ ...result, expiresAt: new Date(Date.parse(result.createdAt) + 15 * 60_000).toISOString(), installer: `${deps.baseUrl}/api/workers/installer${audience ? `?audience=${encodeURIComponent(audience)}` : ""}` }, { status: 201, headers: noStore() }); });
  app.get("/api/workers/installer", async (c) => { const audience = c.req.query("audience"); const file = audience === "linux-x64" ? "install-worker.sh" : audience === "windows-x64" ? "install-worker.ps1" : audience === "macos-arm64" ? "install-worker-macos.sh" : null; if (!file) return c.json({ error: "unsupported installer audience" }, 400); return new Response(Bun.file(new URL(file, deps.workerInstallerRoot)), { headers: noStore() }); });
  app.post("/api/workers/join", async (c) => {
    const source = deps.requestSource(c.req.raw);
    if (!limiter.allow(source)) return c.json({ error: "invalid or rotated bootstrap credential" }, 429);
    try {
      const body = await c.req.json();
      const result = await requestPendingWorker(deps.db, body);
      limiter.clear(source);
      return c.json(result, { status: result.status === "created" ? 201 : 200 });
    } catch (error) {
      if (error instanceof SyntaxError || (error && typeof error === "object" && "issues" in error)) return c.json({ error: "invalid worker request" }, 400);
      if (error instanceof Error && (error.message === "identity_conflict" || error.message === "invalid_bootstrap")) return c.json({ error: "invalid or rotated bootstrap credential" }, error.message === "identity_conflict" ? 409 : 401);
      throw error;
    }
  });
  app.get("/api/workers/bootstrap", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); return c.json(await getWorkerBootstrapStatus(deps.db)); });
  app.post("/api/workers/bootstrap/rotate", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); try { const result = await rotateWorkerBootstrap(deps.db, user.id); return c.json(result, { status: 201, headers: noStore() }); } catch (error) { if (error instanceof Error && error.message === "bootstrap credential is not initialized") return c.json({ error: "bootstrap credential is not initialized" }, 409); throw error; } });
  app.post("/api/workers/pending/:workerId/approve", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); const body = await approvalBody(c); if (!body) return c.json({ error: "invalid approval request" }, 400); await approvePendingWorker(deps.db, c.req.param("workerId"), body, user.id); deps.onWorkerAdopted(c.req.param("workerId")); return c.json({ ok: true }); });
  app.get("/api/workers/pending", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); const rows = await deps.db`select id,name,platform,admission_state as "admissionState",connection_state as "connectionState",configuration_state as "configurationState",public_key as "publicKey",fingerprint,vm_uuid as "vmUuid",limits,doctor,last_requested_at as "lastRequestedAt" from workers where admission_state='pending' order by created_at desc`; return c.json(rows.map((row) => pendingWorkerDto(row))); });
  app.post("/api/workers/pending/:workerId/reject", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); await rejectPendingWorker(deps.db, c.req.param("workerId"), user.id); return c.json({ ok: true }); });
}
