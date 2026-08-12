import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { createPkce, githubAuthorizeUrl, exchangeOAuth, ensureBootstrapAdmin, syncGithubOrganizations } from "../github.ts";
import { createSession, SecretBox, sha256 } from "../auth.ts";

const cookieAttributes = (baseUrl: string, path: string, maxAge: number): string => { const secure = new URL(baseUrl).protocol === "https:" ? "; Secure" : ""; return `HttpOnly${secure}; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`; };
function cookieValue(header: string | undefined, name: string): string | null { const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`)); return value ? value.slice(name.length + 1) : null; }
export function registerAuthRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.get("/api/auth/github", async (c) => {
    const flow = createPkce();
    const encrypted = deps.secretBox.encrypt(flow.verifier);
    await deps.db`insert into github_setup_states(state_hash,purpose,encrypted_pkce_verifier,expires_at) values (${sha256(flow.state)},'oauth',${encrypted},now()+interval '10 minutes')`;
    const returnTo = c.req.query("returnTo");
    if (returnTo === "/repositories") c.header("Set-Cookie", `oauth_return_to=${encodeURIComponent(returnTo)}; ${cookieAttributes(deps.baseUrl, "/api/auth", 600)}`, { append: true });
    c.header("Set-Cookie", `oauth_state=${flow.state}; ${cookieAttributes(deps.baseUrl, "/api/auth", 600)}`, { append: true });
    return c.redirect(githubAuthorizeUrl(deps.baseUrl, deps.githubClientId, flow), 302);
  });
  app.get("/api/auth/github/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const cookie = c.req.header("Cookie");
    if (!state || cookieValue(cookie, "oauth_state") !== state) return c.json({ error:"invalid oauth state" },400);
    const encodedReturnTo = cookieValue(cookie, "oauth_return_to");
    let returnTo: string | null = null;
    try { const decoded = encodedReturnTo ? decodeURIComponent(encodedReturnTo) : ""; if (decoded === "/repositories") returnTo = decoded; } catch { /* malformed return paths fall back to server routing */ }
    const rows = await deps.db`update github_setup_states set consumed_at=now() where state_hash=${sha256(state)} and purpose='oauth' and consumed_at is null and expires_at>now() returning encrypted_pkce_verifier`;
    const row = rows[0] as { encrypted_pkce_verifier?: string } | undefined; if (!row?.encrypted_pkce_verifier) return c.json({ error:"invalid oauth state" },400);
    const flow = { state, verifier:deps.secretBox.decrypt(row.encrypted_pkce_verifier), createdAt:Date.now() }; const user = await exchangeOAuth(c.req.query("code") ?? "", flow, deps.githubClientId, deps.githubClientSecret, deps.baseUrl);
    const [dbUser] = await deps.db`insert into users (github_user_id,login) values (${user.id},${user.login}) on conflict (github_user_id) do update set login=excluded.login returning id,is_global_admin`;
    if (user.login.toLowerCase() !== deps.bootstrapGithubLogin.trim().toLowerCase() && !dbUser.is_global_admin) return c.json({ error:"forbidden" },403);
    if (user.login.toLowerCase() === deps.bootstrapGithubLogin.trim().toLowerCase() && !dbUser.is_global_admin) { try { await ensureBootstrapAdmin(deps.db, user.id, user.login, deps.bootstrapGithubLogin); } catch (error) { if (error instanceof Error && error.message === "bootstrap admin already consumed") return c.json({ error:"forbidden" },403); throw error; } }
    await syncGithubOrganizations(deps.db, String(dbUser.id), user.accessToken);
    const [onboarding] = await deps.db`SELECT completed_at FROM system_onboarding WHERE singleton=true`;
    c.header("Set-Cookie", `whitesmith_session=${await createSession(deps.db, String(dbUser.id))}; ${cookieAttributes(deps.baseUrl, "/", 604800)}`);
    if (encodedReturnTo) c.header("Set-Cookie", `oauth_return_to=; ${cookieAttributes(deps.baseUrl, "/api/auth", 0)}`, { append: true });
    return c.redirect(returnTo ?? (onboarding?.completed_at ? "/" : "/onboarding"), 302);
  });
}
