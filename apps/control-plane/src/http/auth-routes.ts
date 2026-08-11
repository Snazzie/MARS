import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { createPkce, githubAuthorizeUrl, exchangeOAuth, ensureBootstrapAdmin, syncGithubOrganizations, type OAuthState } from "../github.ts";
import { createSession } from "../auth.ts";

const flows = new Map<string, OAuthState>();

const cookie = (value: string) => `whitesmith_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
export function registerAuthRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.get("/api/auth/github", (c) => { const flow = createPkce(); flows.set(flow.state, flow); c.header("Set-Cookie", `oauth_state=${flow.state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=600`); return c.redirect(githubAuthorizeUrl(deps.baseUrl, deps.githubClientId, flow), 302); });
  app.get("/api/auth/github/callback", async (c) => {
    const state = c.req.query("state") ?? ""; const flow = flows.get(state); flows.delete(state);
    if (!flow || c.req.header("Cookie")?.includes(`oauth_state=${state}`) !== true) return c.json({ error: "invalid oauth state" }, 400);
    const user = await exchangeOAuth(c.req.query("code") ?? "", flow, deps.githubClientId, deps.githubClientSecret, deps.baseUrl);
    const [row] = await deps.db`insert into users (github_user_id,login) values (${user.id},${user.login}) on conflict (github_user_id) do update set login=excluded.login returning id,is_global_admin`;
    if (user.login.toLowerCase() === deps.bootstrapGithubLogin.toLowerCase() && !row.is_global_admin) await ensureBootstrapAdmin(deps.db, user.id, user.login, deps.bootstrapGithubLogin);
    await syncGithubOrganizations(deps.db, String(row.id), user.accessToken);
    c.header("Set-Cookie", cookie(await createSession(deps.db, String(row.id)))); return c.redirect("/", 302);
  });
}
