import { Hono } from "hono";
import { OnboardingDetail, OnboardingStatus, SelectOnboardingWorkerRequest, ApproveOnboardingRepositoriesRequest } from "@whitesmith/contracts";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { getOnboardingDetail, getOnboardingStatus, selectOnboardingWorker, approveOnboardingRepositories } from "@whitesmith/db";

const hasKey = (c: { req: { header(name:string): string|undefined } }) => Boolean(c.req.header("Idempotency-Key")?.trim());
export function registerOnboardingRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.get("/api/onboarding/status", async (c) => {
    const user = await deps.currentUser(c.req.raw);
    const status = await getOnboardingStatus(deps.db, { authenticated:Boolean(user), canManage:Boolean(user?.isGlobalAdmin) });
    return c.json(OnboardingStatus.parse(status), { headers:{ "cache-control":"no-store" } });
  });
  app.get("/api/onboarding", async (c) => {
    const user = await deps.currentUser(c.req.raw); if (!user) return c.json({ error:"unauthorized" },401); if (!user.isGlobalAdmin) return c.json({ error:"forbidden" },403);
    const detail=await getOnboardingDetail(deps.db, { authenticated:true, canManage:true }); const platform=detail.worker?.platform; const image=platform ? deps.defaultJobImages[platform] ?? null : null; return c.json(OnboardingDetail.parse({...detail,defaultImageDigest:image}), { headers:{ "cache-control":"no-store" } });
  });
  app.put("/api/onboarding/worker", async (c) => {
    const user = await deps.currentUser(c.req.raw); if (!user) return c.json({ error:"unauthorized" },401); if (!user.isGlobalAdmin) return c.json({ error:"forbidden" },403); if (!hasKey(c)) return c.json({ error:"Idempotency-Key required" },400);
    const parsed = SelectOnboardingWorkerRequest.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return c.json({ error:"invalid worker selection" },400);
    try { await selectOnboardingWorker(deps.db, parsed.data.workerId, user.id); return c.json({ ok:true }); } catch (error) { if (error instanceof Error && error.message === "worker_not_selectable") return c.json({ error:"worker not selectable" },404); throw error; }
  });
  app.post("/api/onboarding/repositories", async (c) => { const user=await deps.currentUser(c.req.raw); if(!user)return c.json({error:"unauthorized"},401); if(!user.isGlobalAdmin)return c.json({error:"forbidden"},403); if(!hasKey(c))return c.json({error:"Idempotency-Key required"},400); const parsed=ApproveOnboardingRepositoriesRequest.safeParse(await c.req.json().catch(()=>null)); if(!parsed.success)return c.json({error:"invalid repositories"},400); try { await approveOnboardingRepositories(deps.db,parsed.data.repositoryIds,user.id); return c.json({ok:true}); } catch(error) { if(error instanceof Error&&error.message==="repositories_not_selectable")return c.json({error:"repositories not selectable"},409); throw error; } });
}
