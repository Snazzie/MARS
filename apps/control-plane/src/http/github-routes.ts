import { Hono } from "hono";
import { ControlPlaneSetupRequest } from "@mars/contracts";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { readBody, validSignature, acceptDelivery, completeDelivery, failDelivery } from "../webhook.ts";
import { applyWorkflowJobWebhook, type WorkflowJobPayload } from "../runs.ts";
import { browserLocation } from "../http-origin.ts";

const setupFailure = (cause: unknown): string | null => {
  const code = cause instanceof Error ? cause.message : "";
  return ["setup_state_expired", "github_manifest_invalid", "github_app_unconfigured", "wrong_github_account", "wrong_organization", "github_token_missing", "repository_selection_required", "github_installation_persist_failed", "github_organization_already_connected"].includes(code) ? code : null;
};
const clearInstallCookie = (c: { header(name: string, value: string): void }) => c.header("Set-Cookie", "github_install_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=0");

export function registerGithubRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.post("/api/setup/github-app", async (c) => {
    const key = c.req.header("Idempotency-Key");
    if (!key) return c.json({ code: "idempotency_required" }, 400);
    const parsed = ControlPlaneSetupRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "invalid_request" }, 400);
    if (!deps.githubApp) return c.json({ code: "setup_required", message: "Complete first-run setup" }, 503);
    try {
      await deps.setup.configure(parsed.data.publicBaseUrl);
      return c.json(await deps.githubApp.createManifestLaunch("setup", "setup", key));
    } catch (cause) {
      if (cause instanceof Error && cause.message === "configured_origin_mismatch") return c.json({ code: "configured_origin_mismatch" }, 400);
      if (cause instanceof Error && cause.message.startsWith("PUBLIC_BASE_URL must be")) return c.json({ code: "invalid_origin", message: cause.message }, 400);
      const setupCode = setupFailure(cause);
      if (setupCode) return c.json({ code: setupCode }, 409);
      throw cause;
    }
  });

  app.post("/api/github/app/manifest", async (c) => {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ code: "unauthorized" }, 401);
    if (!user.isGlobalAdmin) return c.json({ code: "forbidden" }, 403);
    const key = c.req.header("Idempotency-Key");
    if (!key) return c.json({ code: "idempotency_required" }, 400);
    const body = await c.req.json().catch(() => null) as { organizationId?: unknown } | null;
    if (!body || typeof body.organizationId !== "string" || !body.organizationId) return c.json({ code: "invalid_request" }, 400);
    if (!deps.githubApp) return c.json({ code: "setup_required", message: "Complete first-run setup" }, 503);
    try {
      return c.json(await deps.githubApp.createManifestLaunch(user.id, body.organizationId, key));
    } catch (cause) {
      const setupCode = setupFailure(cause);
      if (setupCode) return c.json({ code: setupCode }, 409);
      throw cause;
    }
  });

  app.get("/api/github/app/manifest/callback", async (c) => {
    const state = c.req.query("state"), code = c.req.query("code");
    if (!state || !code || !deps.githubApp) return c.json({ code: "invalid_request" }, 400);
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
      clearInstallCookie(c);
      return c.redirect(browserLocation(deps.browserOrigin() ?? "", onboarding ? "/onboarding" : "/"), 302);
    } catch (cause) {
      const setupCode = setupFailure(cause);
      if (setupCode === "repository_selection_required") {
        clearInstallCookie(c);
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
