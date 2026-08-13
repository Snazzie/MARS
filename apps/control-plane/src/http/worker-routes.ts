import { Hono } from "hono";
import type { Context } from "hono";
import { PendingWorkerRequest, WorkerConfiguration } from "@whitesmith/contracts";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { verifyWorkerBootstrap, initializeWorkerBootstrap, rotateWorkerBootstrap, getWorkerBootstrapStatus } from "../worker-bootstrap.ts";
import { approvePendingWorker, configurePendingWorker, createRequestLimiter, hasMachineIdentity, parseApproveWorkerRequest, requestPendingWorker, rejectPendingWorker } from "../worker-requests.ts";

function noStore(headers = new Headers()): Headers { headers.set("cache-control", "no-store"); return headers; }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function injectInstallerOrigin(source: string, baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  const newline = source.indexOf("\n");
  const insertAt = source.startsWith("#!") && newline >= 0 ? newline + 1 : 0;
  return `${source.slice(0, insertAt)}PUBLIC_BASE_URL=${shellQuote(origin)}\nexport PUBLIC_BASE_URL\n${source.slice(insertAt)}`;
}
export function pendingWorkerDto(row: Record<string, unknown>) {
  if (!hasMachineIdentity(row) || typeof row.id !== "string" || typeof row.fingerprint !== "string") return null;
  const telemetry = (row.doctor && typeof row.doctor === "object" ? row.doctor : {}) as Record<string, unknown>;
  const pending = PendingWorkerRequest.parse({
    platform: row.platform,
    publicKey: row.publicKey,
    vmUuid: row.vmUuid,
    machineUuid: row.machineUuid,
    limits: row.limits,
    doctor: telemetry.doctor ?? {},
    capacity: telemetry.capacity ?? {},
  });
  return { id: row.id, fingerprint: row.fingerprint, ...pending };
}
function idempotency(c: Context<ControlPlaneEnv>): boolean { return Boolean(c.req.header("Idempotency-Key")?.trim()); }
export function registerWorkerRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const approvalBody = async (c: Context<ControlPlaneEnv>) => { try { return parseApproveWorkerRequest(await c.req.json()); } catch { return null; } };
  const auth = async (c: Context<ControlPlaneEnv>) => deps.currentUser(c.req.raw);
  const limiter = deps.workerRequestLimiter ?? createRequestLimiter();
  app.get("/api/workers/control-plane-urls", async (c) => {
    const user = await auth(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    const values = (deps.workerControlPlaneUrls ?? []).map((value) => new URL(value).origin);
    return c.json([...new Set(values)], { headers: noStore() });
  });
  app.get("/api/workers/installer", async (c) => { const audience = c.req.query("audience"); const file = audience === "linux-x64" ? "install-worker.sh" : audience === "windows-x64" ? "install-worker.ps1" : audience === "macos-arm64" ? "install-worker-macos.sh" : null; if (!file) return c.json({ error: "unsupported installer audience" }, 400); const installer = Bun.file(new URL(file, deps.workerInstallerRoot)); const body = audience === "windows-x64" ? installer : injectInstallerOrigin(await installer.text(), deps.baseUrl); return new Response(body, { headers: noStore() }); });
  app.get("/api/workers/orchestrator", (c) => { if (c.req.query("audience") !== "macos-arm64") return c.json({ error: "unsupported orchestrator audience" }, 400); const headers = noStore(); headers.set("content-type", "application/octet-stream"); headers.set("content-disposition", 'attachment; filename="whitesmith-orchestrator"'); return new Response(Bun.file(deps.workerOrchestratorExecutable), { headers }); });
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
  app.post("/api/workers/bootstrap/initialize", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); try { const result = await initializeWorkerBootstrap(deps.db, user.id); return c.json(result, { status: 201, headers: noStore() }); } catch (error) { if (error instanceof Error && error.message === "already initialized") return c.json({ error: "bootstrap credential is already initialized" }, 409); throw error; } });
  app.get("/api/workers/bootstrap", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); return c.json(await getWorkerBootstrapStatus(deps.db), { headers: noStore() }); });
  app.post("/api/workers/bootstrap/rotate", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); try { const result = await rotateWorkerBootstrap(deps.db, user.id); return c.json(result, { status: 201, headers: noStore() }); } catch (error) { if (error instanceof Error && error.message === "bootstrap credential is not initialized") return c.json({ error: "bootstrap credential is not initialized" }, 409); throw error; } });
  app.post("/api/workers/pending/:workerId/approve", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); const body = await approvalBody(c); if (!body) return c.json({ error: "invalid approval request" }, 400); await approvePendingWorker(deps.db, c.req.param("workerId"), body, user.id); deps.onWorkerAdopted(c.req.param("workerId")); return c.json({ ok: true }); });
  app.post("/api/workers/pending/:workerId/configure", async (c) => {
    const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400);
    try {
      const body = await c.req.json();
      const parsed = WorkerConfiguration.safeParse({ appliance: body.appliance, runtime: body.runtime });
      if (!parsed.success) return c.json({ error: "invalid worker configuration" }, 400);
      const key = c.req.header("Idempotency-Key")!.trim();
      const [prior] = await deps.db<{ response: Record<string, unknown> | null }[]>`select response from worker_mutations where worker_id=${c.req.param("workerId")} and idempotency_key=${key}`;
      if (prior?.response) return c.json(prior.response, { status: 202, headers: noStore() });
      const result = await configurePendingWorker(deps.db, c.req.param("workerId"), parsed.data, user.id, deps.workerDispatcher, key);
      deps.onWorkerAdopted(c.req.param("workerId"));
      return c.json(result, { status: 202, headers: noStore() });
    } catch (error) {
      if (error instanceof SyntaxError || (error && typeof error === "object" && "issues" in error)) return c.json({ error: "invalid worker configuration" }, 400);
      if (error instanceof Error && error.message.includes("capacity")) return c.json({ error: error.message }, 422);
      if (error instanceof Error && error.message.includes("conflict")) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  app.get("/api/workers/pending", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); const rows = await deps.db`select id,name,platform,admission_state as "admissionState",connection_state as "connectionState",configuration_state as "configurationState",public_key as "publicKey",fingerprint,vm_uuid as "vmUuid",machine_uuid as "machineUuid",limits,doctor,last_requested_at as "lastRequestedAt" from workers where admission_state='pending' order by created_at desc`; return c.json(rows.map((row) => pendingWorkerDto(row)).filter((row): row is NonNullable<typeof row> => row !== null)); });
  app.post("/api/workers/pending/:workerId/reject", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); await rejectPendingWorker(deps.db, c.req.param("workerId"), user.id); return c.json({ ok: true }); });
}
