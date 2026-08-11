import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { createEnrollmentCode, consumeJoin, fingerprint, adoptWorker } from "../workers.ts";

export function registerWorkerRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.get("/api/workers/installer", async (c) => {
    const audience = c.req.query("audience");
    const artifact = audience === "linux-x64" ? { file: "install-worker.sh", type: "text/x-shellscript; charset=utf-8" } : audience === "windows-x64" ? { file: "install-worker.ps1", type: "text/plain; charset=utf-8" } : audience === "macos-arm64" ? { file: "install-worker-macos.sh", type: "text/x-shellscript; charset=utf-8" } : null;
    if (!artifact) return c.json({ error: "unsupported installer audience" }, 400);
    return new Response(Bun.file(new URL(`../../../deploy/workers/${artifact.file}`, import.meta.url)), { headers: { "cache-control": "no-store", "content-disposition": `attachment; filename="${artifact.file}"`, "content-type": artifact.type } });
  });
  app.post("/api/workers/join", async (c) => {
    const body = await c.req.json<{ code: string; publicKey: string; platform: string; vmUuid: string; limits: Record<string, number> }>();
    if (!await consumeJoin(deps.db, Buffer.from(body.code, "base64url"))) return c.json({ error: "invalid or expired join" }, 401);
    const [worker] = await deps.db`insert into workers (name,platform,admission_state,public_key,fingerprint,vm_uuid,limits) values (${body.vmUuid},${body.platform},'pending',${body.publicKey},${fingerprint(body.publicKey)},${body.vmUuid},${JSON.stringify(body.limits)}) returning id,fingerprint`;
    return c.json({ workerId: worker.id, fingerprint: worker.fingerprint }, 201);
  });
  app.get("/api/workers", async (c) => c.json(await deps.db`select id,name,platform,admission_state as "admissionState",connection_state as "connectionState",configuration_state as "configurationState",fingerprint,limits,doctor from workers order by created_at desc`));
  app.post("/api/workers/enroll", async (c) => {
    const user = c.get("user");
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json<{ audience: string; profile: Record<string, number> }>();
    const enrollment = createEnrollmentCode();
    await deps.db`insert into worker_join_codes (guest_token_hash,status_token_hash,audience,requested_profile,canonical_base_url,expires_at) values (${enrollment.guestHash},${enrollment.statusHash},${body.audience},${JSON.stringify(body.profile)},${deps.baseUrl},${enrollment.expiresAt})`;
    return c.json({ code: enrollment.code, expiresAt: enrollment.expiresAt.toISOString(), installer: `${deps.baseUrl}/api/workers/installer?audience=${encodeURIComponent(body.audience)}` }, 201);
  });
  app.post("/api/workers/:workerId/adopt", async (c) => {
    const user = c.get("user");
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    await adoptWorker(deps.db, c.req.param("workerId"), user.id);
    deps.onWorkerAdopted(c.req.param("workerId"));
    return c.json({ ok: true });
  });
}
