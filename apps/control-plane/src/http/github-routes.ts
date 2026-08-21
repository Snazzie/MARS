import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { readBody, validSignature, acceptDelivery, completeDelivery, failDelivery } from "../webhook.ts";
import { applyWorkflowJobWebhook, type WorkflowJobPayload } from "../runs.ts";
import { browserLocation } from "../http-origin.ts";

const setupFailure = (cause: unknown): string | null => {
  const code = cause instanceof Error ? cause.message : "";
  return ["setup_state_expired", "github_manifest_invalid", "github_app_unconfigured", "wrong_github_account", "wrong_organization", "github_token_missing", "repository_selection_required", "github_installation_persist_failed", "github_organization_already_connected"].includes(code) ? code : null;
};

export function registerGithubRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.post("/api/setup/github-app", async (c) => {
    const key = c.req.header("Idempotency-Key");
    if (!key) return c.json({ code: "idempotency_required" }, 400);
    const body = await c.req.json().catch(() => null) as { setupCode?: string; publicBaseUrl?: string } | null;
    if (!body?.setupCode) return c.json({ code: "unauthorized", message: "Invalid setup code" }, 401);
    if (!body.publicBaseUrl) return c.json({ code: "invalid_request" }, 400);
    if (!deps.githubApp) return c.json({ code: "setup_required", message: "Complete first-run setup" }, 503);
    try {
      const origin = await deps.setup.configure(body.setupCode, body.publicBaseUrl);
      const result = await deps.githubApp.createManifestLaunch("setup", "setup", key);
      c.header("Set-Cookie", `whitesmith_setup=${encodeURIComponent(body.setupCode)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=900${origin.startsWith("https://") ? "; Secure" : ""}`);
      return c.json(result);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "setup_unauthorized") return c.json({ code: "unauthorized", message: "Invalid setup code" }, 401);
      throw cause;
    }
  });

  app.get("/api/github/app/manifest/callback", async (c) => {
    const state = c.req.query("state"), code = c.req.query("code");
    const cookie = (c.req.header("Cookie") ?? "").split(";").map((value) => value.trim()).find((value) => value.startsWith("whitesmith_setup="))?.slice(15);
    if (!state || !code || !cookie || !deps.githubApp || !(await deps.setup.authorize(decodeURIComponent(cookie)))) return c.json({ code: "unauthorized" }, 401);
    try {
      const result = await deps.githubApp.completeManifestRegistration("setup", state, code);
      return c.redirect(result.location, 302);
    } catch (cause) { const setupCode = setupFailure(cause); if (setupCode) return c.json({ code: setupCode }, 409); throw cause; }
  });

  app.post("/api/github/app/install", async (c) => {
    const user = await deps.currentUser(c.req.raw); if (!user) return c.json({ code: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ code: "forbidden" }, 403);
    const key = c.req.header("Idempotency-Key"); if (!key || !deps.githubApp) return c.json({ code: "idempotency_required" }, 400);
    const body = await c.req.json<{ organizationId?: string }>(); if (!body.organizationId) return c.json({ code: "invalid_request" }, 400);
    try {
      const result = await deps.githubApp.beginInstallation(user.id, body.organizationId, key);
      if (result.installCookie) c.header("Set-Cookie", `github_install_state=${result.installCookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=600`);
      return c.json({ location: result.location });
    } catch (cause) { const setupCode = setupFailure(cause); if (setupCode) return c.json({ code: setupCode }, 409); throw cause; }
  });

  app.get("/api/github/app/setup", async (c) => {
    const user = await deps.currentUser(c.req.raw); if (!user) return c.json({ code: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ code: "forbidden" }, 403);
    const installationId = Number(c.req.query("installation_id"));
    const cookie = (c.req.header("Cookie") ?? "").split(";").map((value) => value.trim()).find((value) => value.startsWith("github_install_state="))?.slice(21);
    if (c.req.query("setup_action") !== "install") return c.json({ code: "invalid_request" }, 400);
    if (!cookie || !installationId || !deps.githubApp) return c.json({ code: "invalid_request" }, 400);
    try {
      const onboarding = await deps.githubApp.completeInstallation(user.id, cookie, installationId);
      c.header("Set-Cookie", "github_install_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=0");
      return c.redirect(browserLocation(deps.browserOrigin() ?? "", onboarding ? "/onboarding" : "/"), 302);
    } catch (cause) {
      const setupCode = setupFailure(cause);
      if (setupCode === "repository_selection_required") {
        c.header("Set-Cookie", "github_install_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=0");
        return c.redirect(browserLocation(deps.browserOrigin() ?? "", "/onboarding?github=repository-selection-required"), 302);
      }
      if (setupCode) return c.json({ code: setupCode }, 409);
      throw cause;
    }
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
    const deliveryId = c.req.header("x-github-delivery") ?? crypto.randomUUID();
    const accepted = await acceptDelivery(deps.db, deliveryId, installationId, payload, eventName);
    if (!accepted) return c.json({ accepted: false }, 202);
    try {
      if (deps.githubApp && (eventName === "installation" || eventName === "installation_repositories")) await deps.githubApp.reconcileInstallationRepositories(payload);
      if (eventName === "workflow_job" && event.action && event.workflow_job) await applyWorkflowJobWebhook(event);
      await completeDelivery(deps.db, deliveryId);
    } catch (error) {
      await failDelivery(deps.db, deliveryId, error);
      throw error;
    }
    return c.json({ accepted: true }, 202);
  });
}
