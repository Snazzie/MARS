import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { readBody, validSignature, acceptDelivery } from "../webhook.ts";
import { applyWorkflowJobWebhook, type WorkflowJobPayload } from "../runs.ts";

export function registerGithubRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.post("/api/github/webhooks", async (c) => {
    const body = await readBody(c.req.raw);
    if (!validSignature(body, c.req.header("x-hub-signature-256") ?? null, deps.githubWebhookSecret)) return c.json({ error: "invalid signature" }, 401);
    let payload: unknown;
    try { payload = JSON.parse(body.toString()); } catch { return c.json({ error: "invalid payload" }, 400); }
    const event = payload as WorkflowJobPayload;
    const installationId = Number(event.installation?.id ?? 0);
    const accepted = await acceptDelivery(deps.db, c.req.header("x-github-delivery") ?? crypto.randomUUID(), installationId, payload);
    if (accepted && event.action && event.workflow_job) await applyWorkflowJobWebhook(event);
    return c.json({ accepted }, 202);
  });
}
