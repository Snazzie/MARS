import { and, eq, isNull, gt, sql } from "drizzle-orm";
import { defineQueries, schema } from "@mars/db";

const authRouteQueries = defineQueries((db) => ({
  outstandingOAuth: db.select({ count: sql<number>`count(*)::int` }).from(schema.githubSetupStates).where(and(eq(schema.githubSetupStates.purpose, "oauth"), isNull(schema.githubSetupStates.consumedAt), gt(schema.githubSetupStates.expiresAt, sql`now()`))).prepare("http_oauth_outstanding"),
  insertOAuthState: db.insert(schema.githubSetupStates).values({ stateHash: sql`decode(${sql.placeholder("stateHash")},'hex')`, purpose: "oauth", encryptedPkceVerifier: sql.placeholder("verifier"), expiresAt: sql`now()+interval '10 minutes'` }).prepare("http_oauth_insert_state"),
  consumeOAuthState: db.update(schema.githubSetupStates).set({ consumedAt: sql`now()` }).where(and(eq(schema.githubSetupStates.stateHash, sql`decode(${sql.placeholder("stateHash")},'hex')`), eq(schema.githubSetupStates.purpose, "oauth"), isNull(schema.githubSetupStates.consumedAt), gt(schema.githubSetupStates.expiresAt, sql`now()`))).returning({ encryptedPkceVerifier: schema.githubSetupStates.encryptedPkceVerifier }).prepare("http_oauth_consume_state"),
  onboarding: db.select({ completedAt: schema.systemOnboarding.completedAt }).from(schema.systemOnboarding).where(eq(schema.systemOnboarding.singleton, true)).prepare("http_auth_onboarding"),
}));
import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { createPkce, githubAuthorizeUrl, exchangeOAuth } from "../github.ts";
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
function setupRequiredRedirect(accept: string | undefined, browserOrigin: string | null): string | null {
  const acceptsHtml = accept?.split(",").some((mediaType) => mediaType.split(";", 1)[0]?.trim().toLowerCase() === "text/html") ?? false;
  if (!acceptsHtml) return null;
  return browserOrigin ? browserLocation(browserOrigin, "/onboarding") : "/onboarding";
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
    await deleteSession(deps.db, cookieValue(c.req.header("Cookie"), "mars_session") ?? undefined);
    if (origin) c.header("Set-Cookie", `mars_session=; ${cookieAttributes(origin, "/", 0)}`);
    return c.json({ ok: true });
  });
  app.get("/api/auth/github", async (c) => {
    const origin = deps.setup.publicOrigin();
    const credentials = await deps.githubApp?.getOAuthCredentials();
    if (!origin || !credentials) {
      const redirect = setupRequiredRedirect(c.req.header("Accept"), deps.browserOrigin());
      if (redirect) return c.redirect(redirect, 302);
      return c.json({ code: "setup_required", message: "Complete first-run setup" }, 503);
    }
    const client = deps.requestSource(c.req.raw);
    if (!allowOAuthStart(client)) return c.json({ code: "oauth_rate_limited", message: "Too many sign-in attempts" }, 429);
    const [outstanding] = await authRouteQueries(deps.db).outstandingOAuth.execute();
    if (Number(outstanding?.count ?? 0) >= 500) return c.json({ code: "oauth_rate_limited", message: "Sign-in is temporarily busy" }, 429);
    const flow = createPkce();
    await authRouteQueries(deps.db).insertOAuthState.execute({ stateHash: sha256(flow.state).toString("hex"), verifier: deps.secretBox.encrypt(flow.verifier) });
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
    const rows = await authRouteQueries(deps.db).consumeOAuthState.execute({ stateHash: sha256(state).toString("hex") });
    const row = rows[0] as { encryptedPkceVerifier?: string } | undefined;
    if (!row?.encryptedPkceVerifier) return c.json({ error: "invalid oauth state" }, 400);
    const flow = { state, verifier: deps.secretBox.decrypt(row.encryptedPkceVerifier), createdAt: Date.now() };
    const user = await exchangeOAuth(c.req.query("code") ?? "", flow, credentials.clientId, credentials.clientSecret, origin);
    let authentication: { userId: string; firstAdmin: boolean };
    try { authentication = await deps.setup.authenticate(user); }
    catch (error) {
      if (error instanceof Error && error.message === "account_not_authorized") {
        if (c.req.header("Accept")?.includes("text/html")) return c.redirect(browserLocation(deps.browserOrigin() ?? origin, "/onboarding?signin=not-authorized"), 302);
        return c.json({ code: "account_not_authorized", message: "Sign in with an account that belongs to an installed GitHub organization. Contact the installation administrator for access." }, 403);
      }
      if (error instanceof Error && ["setup_state_expired", "setup_admin_conflict"].includes(error.message)) return c.json({ error: "forbidden" }, 403);
      throw error;
    }
    const userId = authentication.userId;
    const [onboarding] = await authRouteQueries(deps.db).onboarding.execute();
    c.header("Set-Cookie", `mars_session=${await createSession(deps.db, userId)}; ${cookieAttributes(origin, "/", 604800)}`);
    if (encodedReturnTo) c.header("Set-Cookie", `oauth_return_to=; ${cookieAttributes(origin, "/api/auth", 0)}`, { append: true });
    return c.redirect(browserLocation(deps.browserOrigin() ?? origin, returnTo ?? (onboarding?.completedAt ? "/" : "/onboarding")), 302);
  });
}
