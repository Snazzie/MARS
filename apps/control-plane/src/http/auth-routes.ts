import { Hono } from "hono";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { createPkce, githubAuthorizeUrl } from "../github.ts";

export function registerAuthRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  app.get("/api/auth/github", (c) => {
    const flow = createPkce();
    const location = githubAuthorizeUrl(deps.baseUrl, deps.githubClientId, flow);
    c.header("Set-Cookie", `oauth_state=${flow.state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=600`);
    return c.redirect(location, 302);
  });
}
