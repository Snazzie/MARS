import { Hono } from "hono";
import { OnboardingDetail, OnboardingStatus, SelectOnboardingWorkerRequest, StartOnboardingVerificationRequest, StartOnboardingVerificationResult, VerifyOnboardingRepositoriesResult } from "@mars/contracts";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { dashboardMutation, completeOnboardingIfReady, getOnboardingDetail, getOnboardingRepositoryOrganization, getOnboardingStatus, getVerifiedOnboardingRepositories, invalidateDashboard, recordOnboardingVerification, selectOnboardingWorker } from "@mars/db";
import { ensureDefaultPools } from "../default-pools.ts";
import { discoverWorkflowFiles } from "../workflow-pr.ts";

const hasKey = (c: { req: { header(name:string): string|undefined } }) => Boolean(c.req.header("Idempotency-Key")?.trim());
const onboardingGithubFailure = (cause: unknown): string | null => {
  const code = cause instanceof Error ? cause.message : "";
  return ["github_app_unconfigured", "github_installation_persist_failed", "github_token_missing"].includes(code) ? code : null;
};
export function registerOnboardingRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.post("/api/onboarding/github/install", async (c) => {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ code: "unauthorized", message: "Authentication required" }, 401);
    if (!user.isGlobalAdmin) return c.json({ code: "forbidden", message: "Administrator access required" }, 403);
    const key = c.req.header("Idempotency-Key")?.trim();
    if (!key) return c.json({ code: "invalid_request", message: "Idempotency-Key required" }, 400);
    if (!deps.githubApp) return c.json({ code: "github_app_unavailable", message: "GitHub App service is unavailable" }, 503);
    try {
      const result = await deps.githubApp.beginUnboundInstallation(user.id, key);
      if (result.installCookie) c.header("Set-Cookie", `github_install_state=${result.installCookie}; HttpOnly; Secure; SameSite=Lax; Path=/api/github/app; Max-Age=600`);
      return c.json({ location: result.location });
    } catch (cause) {
      const code = onboardingGithubFailure(cause);
      if (code) return c.json({ code }, 409);
      throw cause;
    }
  });

  app.get("/api/onboarding/status", async (c) => {
    const user = await deps.currentUser(c.req.raw);
    const status = await getOnboardingStatus(deps.db, { authenticated:Boolean(user), canManage:Boolean(user?.isGlobalAdmin) }, { publicBaseUrlManaged: deps.setup.publicOriginManaged() });
    return c.json(OnboardingStatus.parse(status), { headers:{ "cache-control":"no-store" } });
  });
  app.get("/api/onboarding", async (c) => {
    const user = await deps.currentUser(c.req.raw); if (!user) return c.json({ error:"unauthorized" },401); if (!user.isGlobalAdmin) return c.json({ error:"forbidden" },403);
    let detail = await getOnboardingDetail(deps.db, { authenticated: true, canManage: true }, {}, { publicBaseUrlManaged: deps.setup.publicOriginManaged() });
    if (detail.step === "labels" && !detail.pool) {
      await ensureDefaultPools(deps.db, deps.defaultJobImages);
      detail = await getOnboardingDetail(deps.db, { authenticated: true, canManage: true }, {}, { publicBaseUrlManaged: deps.setup.publicOriginManaged() });
    }
    const defaultImageDigests = {
      "linux-x64": deps.defaultJobImages["linux-x64"] ?? null,
      "windows-x64": deps.defaultJobImages["windows-x64"] ?? null,
      "macos-arm64": deps.defaultJobImages["macos-arm64"] ?? null,
    };
    return c.json(OnboardingDetail.parse({ ...detail, defaultImageDigests }), { headers: { "cache-control": "no-store" } });
  });
  app.put("/api/onboarding/worker", async (c) => {
    const user = await deps.currentUser(c.req.raw); if (!user) return c.json({ error:"unauthorized" },401); if (!user.isGlobalAdmin) return c.json({ error:"forbidden" },403); if (!hasKey(c)) return c.json({ error:"Idempotency-Key required" },400);
    const parsed = SelectOnboardingWorkerRequest.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return c.json({ error:"invalid worker selection" },400);
    try { await selectOnboardingWorker(deps.db, parsed.data.workerId, user.id); return c.json({ ok:true }); } catch (error) { if (error instanceof Error && error.message === "worker_not_selectable") return c.json({ error:"worker not selectable" },404); throw error; }
  });
  app.post("/api/onboarding/repositories/verify", async (c) => {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ code: "unauthorized", message: "Authentication required" }, 401);
    if (!user.isGlobalAdmin) return c.json({ code: "forbidden", message: "Administrator access required" }, 403);
    if (!hasKey(c)) return c.json({ code: "invalid_request", message: "Idempotency-Key required" }, 400);
    if (!deps.githubApp) return c.json({ code: "github_app_unavailable", message: "GitHub App service is unavailable" }, 503);
    const organizationId = await getOnboardingRepositoryOrganization(deps.db, user.id);
    if (!organizationId) return c.json({ code: "repository_selection_required", message: "Install the GitHub App before verifying repository access" }, 409);
    try {
      await deps.githubApp.refreshInstallationRepositories(organizationId);
    } catch {
      return c.json({ code: "repository_sync_failed", message: "GitHub repository access could not be refreshed" }, 502);
    }
    const verified = await getVerifiedOnboardingRepositories(deps.db, user.id);
    if (!verified) return c.json({ code: "repository_selection_required", message: "Select at least one repository in the GitHub App installation, then verify again" }, 409);
    await invalidateDashboard(deps.db, organizationId, ["onboarding", "repositories"]);
    return c.json(VerifyOnboardingRepositoriesResult.parse({ ok: true, ...verified }));
  });
  app.post("/api/onboarding/skip-labels", async (c) => {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ code: "unauthorized", message: "Authentication required" }, 401);
    if (!user.isGlobalAdmin) return c.json({ code: "forbidden", message: "Administrator access required" }, 403);
    if (!hasKey(c)) return c.json({ code: "invalid_request", message: "Idempotency-Key required" }, 400);
    if (!(await completeOnboardingIfReady(deps.db, { skipVerification: true }))) {
      return c.json({ code: "onboarding_not_ready", message: "Create an enabled default runner pool before skipping trigger-label verification" }, 409);
    }
    return c.json({ ok: true });
  });
  app.post("/api/onboarding/verification", async (c) => {
    const user = await deps.currentUser(c.req.raw);
    if (!user) return c.json({ code: "unauthorized", message: "Authentication required" }, 401);
    if (!user.isGlobalAdmin) return c.json({ code: "forbidden", message: "Administrator access required" }, 403);
    if (!hasKey(c)) return c.json({ code: "invalid_request", message: "Idempotency-Key required" }, 400);
    if (!deps.githubApp) return c.json({ code: "github_app_unavailable", message: "GitHub App service is unavailable" }, 503);
    const parsed = StartOnboardingVerificationRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "invalid_request", message: "Choose a repository workflow to verify" }, 400);
    const detail = await getOnboardingDetail(deps.db, { authenticated: true, canManage: true }, {}, { publicBaseUrlManaged: deps.setup.publicOriginManaged() });
    const organizationId = detail.github.organizationId;
    const pool = detail.pool;
    const repository = detail.github.repositories.find((candidate) => candidate.id === parsed.data.repositoryId && candidate.available);
    if (!organizationId || !pool || !repository) return c.json({ code: "onboarding_not_ready", message: "Repository access and an enabled runner pool are required" }, 409);
    if (pool.platform === "linux-x64") return c.json({ code: "runtime_unsupported", message: "Linux runner verification is not available in this release" }, 422);
    if (["queued", "running", "reaping"].includes(detail.verification.state)) return c.json({ code: "verification_in_progress", message: "Runner verification is already in progress" }, 409);
    try {
      const listing = await deps.githubApp.listRepositoryRunnerWorkflows({ organizationId, repositoryId: repository.id });
      const workflow = discoverWorkflowFiles(listing.files).find((candidate) => candidate.path === parsed.data.workflowPath);
      const targetsPool = workflow?.jobs.some((job) => {
        const labels = typeof job.currentRunsOn === "string" ? [job.currentRunsOn] : job.currentRunsOn;
        return pool.triggerLabel != null && labels.includes(pool.triggerLabel);
      });
      if (!targetsPool) return c.json({ code: "workflow_not_targeting_pool", message: `The workflow must request ${pool.triggerLabel ?? "the selected runner pool"}` }, 422);
      if (!(await dashboardMutation(deps.db, organizationId, c.req.header("Idempotency-Key")!.trim()))) return c.json({ code: "mutation_in_progress", message: "This verification request is already in progress" }, 409);
      await recordOnboardingVerification(deps.db, user.id, { ...parsed.data, poolId: pool.id, error: "Dispatch started but the GitHub run has not been identified yet" });
      const dispatched = await deps.githubApp.dispatchRepositoryWorkflow({ organizationId, ...parsed.data });
      await recordOnboardingVerification(deps.db, user.id, { ...parsed.data, poolId: pool.id, githubRunId: dispatched.githubRunId });
      await invalidateDashboard(deps.db, organizationId, ["onboarding", "runs"]);
      return c.json(StartOnboardingVerificationResult.parse({ state: "queued", githubRunId: dispatched.githubRunId }));
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "verification_dispatch_failed";
      await recordOnboardingVerification(deps.db, user.id, { ...parsed.data, poolId: pool.id, error: code });
      return c.json({ code: "verification_dispatch_failed", message: code }, 502);
    }
  });
}
