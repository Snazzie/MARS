import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "@mars/db";
import { SecretBox } from "./auth.ts";

export interface OAuthState { state: string; verifier: string; createdAt: number; }
export function createPkce(): OAuthState { const verifier = randomBytes(32).toString("base64url"); const state = randomBytes(32).toString("base64url"); return { state, verifier, createdAt: Date.now() }; }
export function pkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }
export function githubAuthorizeUrl(base: string, clientId: string, flow: OAuthState): string { const u = new URL("https://github.com/login/oauth/authorize"); u.searchParams.set("client_id", clientId); u.searchParams.set("redirect_uri", `${base}/api/auth/github/callback`); u.searchParams.set("scope", "read:user read:org"); u.searchParams.set("state", flow.state); u.searchParams.set("code_challenge", pkceChallenge(flow.verifier)); u.searchParams.set("code_challenge_method", "S256"); return u.toString(); }
export interface OAuthUser { id: number; login: string; accessToken: string; }
export interface GithubOrganization { id: number; login: string; }
export async function exchangeOAuth(code: string, state: OAuthState, clientId: string, clientSecret: string, base: string): Promise<OAuthUser> { if (Date.now() - state.createdAt > 10 * 60_000) throw new Error("oauth state expired"); const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${base}/api/auth/github/callback`, code_verifier: state.verifier }) }); if (!response.ok) throw new Error("oauth exchange failed"); const token = (await response.json() as { access_token?: string }).access_token; if (!token) throw new Error("oauth token missing"); const profile = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "mars-control-plane" } }); if (!profile.ok) throw new Error("github profile lookup failed"); const value = await profile.json() as { id?: number; login?: string }; if (typeof value.id !== "number" || typeof value.login !== "string") throw new Error("github profile invalid"); return { id: value.id, login: value.login, accessToken: token }; }
export async function listGithubOrganizations(accessToken: string): Promise<GithubOrganization[]> {
  const organizations: GithubOrganization[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/user/orgs?per_page=100&page=${page}`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "mars-control-plane" } });
    if (!response.ok) throw new Error("github organization lookup failed");
    const rows = await response.json() as Array<{ id?: number; login?: string }>;
    organizations.push(...rows.filter((organization): organization is GithubOrganization => typeof organization.id === "number" && typeof organization.login === "string" && organization.login.length > 0));
    if (rows.length < 100) return organizations;
  }
}
export async function ensureBootstrapAdmin(sql: Sql<{}>, githubId: number, login: string, allowlisted: string): Promise<void> {
  if (login.toLowerCase() !== allowlisted.trim().toLowerCase()) throw new Error("bootstrap login mismatch");
  await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext('mars:bootstrap-admin'))`;
    const rows = await tx`select id,is_global_admin as "isGlobalAdmin" from users where github_user_id=${githubId}`;
    if (!rows.length) throw new Error("bootstrap user missing");
    if (rows[0].isGlobalAdmin) return;
    const consumed = await tx`select admin_user_id from system_onboarding where singleton=true`;
    if (consumed[0]?.admin_user_id) throw new Error("bootstrap admin already consumed");
    await tx`update users set is_global_admin=true where id=${rows[0].id}`;
    await tx`insert into system_onboarding(singleton,admin_user_id) values(true,${rows[0].id}) on conflict(singleton) do update set admin_user_id=excluded.admin_user_id`;
  });
}
export function encryptGithubSecret(box: SecretBox, value: string): string { return box.encrypt(value); }
