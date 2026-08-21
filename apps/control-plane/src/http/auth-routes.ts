import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { createPkce, githubAuthorizeUrl, exchangeOAuth, syncGithubOrganizations, syncGithubPersonalWorkspace } from "../github.ts";
import { createSession, deleteSession, sha256 } from "../auth.ts";
import { browserLocation } from "../http-origin.ts";

const cookieAttributes = (baseUrl: string, path: string, maxAge: number): string => { const secure = new URL(baseUrl).protocol === "https:" ? "; Secure" : ""; return `HttpOnly${secure}; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`; };
function cookieValue(header: string | undefined, name: string): string | null { const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`)); return value ? value.slice(name.length + 1) : null; }
function localReturnTo(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/api/") || value.includes("\\")) return null;
  return value;
}
function decodeReturnTo(value: string | null): string | null {
  try { return localReturnTo(value ? decodeURIComponent(value) : undefined); } catch { return null; }
}
const oauthStarts = new Map<string, number[]>();
function allowOAuthStart(client: string): boolean {
  const now = Date.now(), cutoff = now - 60_000;
  const recent = (oauthStarts.get(client) ?? []).filter((value) => value > cutoff);
  if (recent.length >= 10) return false;
  recent.push(now); oauthStarts.set(client, recent);
  const total = [...oauthStarts.values()].reduce((sum, values) => sum + values.length, 0);
  return total <= 100;
}
export function registerAuthRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.post("/api/auth/logout", async (c) => {
    const origin = deps.setup.publicOrigin();
    await deleteSession(deps.db, cookieValue(c.req.header("Cookie"), "whitesmith_session") ?? undefined);
    if (origin) c.header("Set-Cookie", `whitesmith_session=; ${cookieAttributes(origin, "/", 0)}`);
    return c.json({ ok: true });
  });
  app.get("/api/auth/github", async (c) => {
    const origin = deps.setup.publicOrigin();
    const credentials = await deps.githubApp?.getOAuthCredentials();
    if (!origin || !credentials) return c.json({ code: "setup_required", message: "Complete first-run setup" }, 503);
    const client = deps.requestSource(c.req.raw);
    if (!allowOAuthStart(client)) return c.json({ code: "oauth_rate_limited", message: "Too many sign-in attempts" }, 429);
    const [outstanding] = await deps.db`SELECT count(*)::int AS count FROM github_setup_states WHERE purpose='oauth' AND consumed_at IS NULL AND expires_at>now()`;
    if (Number(outstanding?.count ?? 0) >= 500) return c.json({ code: "oauth_rate_limited", message: "Sign-in is temporarily busy" }, 429);
    const flow = createPkce();
    await deps.db`insert into github_setup_states(state_hash,purpose,encrypted_pkce_verifier,expires_at) values (${sha256(flow.state)},'oauth',${deps.secretBox.encrypt(flow.verifier)},now()+interval '10 minutes')`;
    const returnTo = localReturnTo(c.req.query("returnTo"));
    if (returnTo) c.header("Set-Cookie", `oauth_return_to=${encodeURIComponent(returnTo)}; ${cookieAttributes(origin, "/api/auth", 600)}`, { append: true });
    c.header("Set-Cookie", `oauth_state=${flow.state}; ${cookieAttributes(origin, "/api/auth", 600)}`, { append: true });
    return c.redirect(githubAuthorizeUrl(origin, credentials.clientId, flow), 302);
  });
  app.get("/api/auth/github/callback", async (c) => {
    const origin = deps.setup.publicOrigin();
    const credentials = await deps.githubApp?.getOAuthCredentials();
    if (!origin || !credentials) return c.json({ code: "setup_required", message: "Complete first-run setup" }, 503);
    const state = c.req.query("state") ?? "", cookie = c.req.header("Cookie");
    if (!state || cookieValue(cookie, "oauth_state") !== state) return c.json({ error: "invalid oauth state" }, 400);
    const encodedReturnTo = cookieValue(cookie, "oauth_return_to"), returnTo = decodeReturnTo(encodedReturnTo);
    const rows = await deps.db`update github_setup_states set consumed_at=now() where state_hash=${sha256(state)} and purpose='oauth' and consumed_at is null and expires_at>now() returning encrypted_pkce_verifier`;
    const row = rows[0] as { encrypted_pkce_verifier?: string } | undefined;
    if (!row?.encrypted_pkce_verifier) return c.json({ error: "invalid oauth state" }, 400);
    const flow = { state, verifier: deps.secretBox.decrypt(row.encrypted_pkce_verifier), createdAt: Date.now() };
    const user = await exchangeOAuth(c.req.query("code") ?? "", flow, credentials.clientId, credentials.clientSecret, origin);
    const setupCode = cookieValue(cookie, "whitesmith_setup");
    let userId: string;
    if (setupCode) {
      try { userId = await deps.setup.claimAdmin(user); }
      catch (error) {
        if (error instanceof Error && ["setup_unauthorized", "setup_admin_conflict"].includes(error.message)) return c.json({ error: "forbidden" }, 403);
        throw error;
      }
    } else {
      const [dbUser] = await deps.db`insert into users (github_user_id,login) values (${user.id},${user.login}) on conflict (github_user_id) do update set login=excluded.login returning id`;
      userId = String(dbUser.id);
    }
    await syncGithubOrganizations(deps.db, userId, user.accessToken);
    await syncGithubPersonalWorkspace(deps.db, userId, user);
    const [onboarding] = await deps.db`SELECT completed_at FROM system_onboarding WHERE singleton=true`;
    c.header("Set-Cookie", `whitesmith_session=${await createSession(deps.db, userId)}; ${cookieAttributes(origin, "/", 604800)}`);
    if (encodedReturnTo) c.header("Set-Cookie", `oauth_return_to=; ${cookieAttributes(origin, "/api/auth", 0)}`, { append: true });
    if (setupCode) c.header("Set-Cookie", `whitesmith_setup=; ${cookieAttributes(origin, "/", 0)}`, { append: true });
    return c.redirect(browserLocation(deps.browserOrigin() ?? origin, returnTo ?? (onboarding?.completed_at ? "/" : "/onboarding")), 302);
  });
}
