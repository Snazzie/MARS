import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { readBody, validSignature, acceptDelivery } from "../webhook.ts";
import { applyWorkflowJobWebhook, type WorkflowJobPayload } from "../runs.ts";

export function registerGithubRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.post("/api/github/app/manifest", async (c) => {
    const user = await deps.currentUser(c.req.raw); if (!user) return c.json({ code:"unauthorized" },401); if (!user.isGlobalAdmin) return c.json({ code:"forbidden" },403);
    const key=c.req.header("Idempotency-Key"); if(!key) return c.json({ code:"idempotency_required" },400); const body=await c.req.json<{organizationId?:string}>(); if(!body.organizationId||!deps.githubApp) return c.json({ code:"invalid_request" },400);
    return c.json(await deps.githubApp.createManifestLaunch(user.id,body.organizationId,key));
  });
  app.get("/api/github/app/manifest/callback", async (c) => {
    const user=await deps.currentUser(c.req.raw); if(!user) return c.json({code:"unauthorized"},401); if(!user.isGlobalAdmin) return c.json({code:"forbidden"},403); const state=c.req.query("state"), code=c.req.query("code"); if(!state||!code||!deps.githubApp) return c.json({code:"invalid_request"},400);
    const result=await deps.githubApp.completeManifestRegistration(user.id,state,code); c.header("Set-Cookie",`github_install_state=${result.installCookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=600`); return c.redirect(result.location,302);
  });
  app.post("/api/github/app/install", async (c) => {
    const user=await deps.currentUser(c.req.raw); if(!user) return c.json({code:"unauthorized"},401); if(!user.isGlobalAdmin) return c.json({code:"forbidden"},403); const key=c.req.header("Idempotency-Key"); if(!key||!deps.githubApp) return c.json({code:"idempotency_required"},400); const body=await c.req.json<{organizationId?:string}>(); if(!body.organizationId) return c.json({code:"invalid_request"},400); const result=await deps.githubApp.beginInstallation(user.id,body.organizationId,key); c.header("Set-Cookie",`github_install_state=${result.installCookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=600`); return c.json({location:result.location});
  });
  app.get("/api/github/app/setup", async (c) => {
    const user=await deps.currentUser(c.req.raw); if(!user) return c.json({code:"unauthorized"},401); if(!user.isGlobalAdmin) return c.json({code:"forbidden"},403); const installationId=Number(c.req.query("installation_id")); const cookie=(c.req.header("Cookie")??"").split(";").map(v=>v.trim()).find(v=>v.startsWith("github_install_state="))?.slice(21); if(!cookie||!installationId||!deps.githubApp) return c.json({code:"invalid_request"},400); await deps.githubApp.completeInstallation(user.id,cookie,installationId); c.header("Set-Cookie","github_install_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=0"); return c.redirect("/onboarding",302);
  });
  app.post("/api/github/webhooks", async (c) => {
    const body = await readBody(c.req.raw);
    const secret = deps.githubApp ? await deps.githubApp.getWebhookSecret() : null;
    if (!secret || !validSignature(body, c.req.header("x-hub-signature-256") ?? null, secret)) return c.json({ error: "invalid signature" }, 401);
    let payload: unknown;
    try { payload = JSON.parse(body.toString()); } catch { return c.json({ error: "invalid payload" }, 400); }
    const eventName = c.req.header("x-github-event") ?? "";
    const event = payload as WorkflowJobPayload;
    const installationId = Number(event.installation?.id ?? 0);
    const accepted = await acceptDelivery(deps.db, c.req.header("x-github-delivery") ?? crypto.randomUUID(), installationId, payload);
    if (accepted && deps.githubApp && (eventName === "installation" || eventName === "installation_repositories")) await deps.githubApp.reconcileInstallationRepositories(payload);
    if (accepted && eventName === "workflow_job" && event.action && event.workflow_job) await applyWorkflowJobWebhook(event);
    return c.json({ accepted }, 202);
  });
}
