# Browser Base URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep GitHub and OAuth callbacks on the public control-plane origin while returning development users to the current Vite UI.

**Architecture:** Validate public and browser origins once at startup. Pass both origins explicitly through HTTP dependencies and `GitHubAppService`; machine-facing URLs use the public origin, while successful human-facing destinations use the browser origin. `BROWSER_BASE_URL` defaults to `PUBLIC_BASE_URL`, so production behavior is unchanged.

**Tech Stack:** Bun, TypeScript, Hono, React/Vite development server, Bun test

## Global Constraints

- `PUBLIC_BASE_URL` remains authoritative for callbacks, webhooks, APIs, workers, cookies, and installers.
- `BROWSER_BASE_URL` is optional and defaults to `PUBLIC_BASE_URL`.
- Both values are absolute HTTP(S) origins without credentials, path segments, query parameters, or fragments.
- Invalid origin configuration fails control-plane startup.
- Local development uses `PUBLIC_BASE_URL=http://localhost:3000` and `BROWSER_BASE_URL=http://localhost:5173`.
- Production requires no new setting and retains its existing redirect behavior.
- OAuth return paths remain repository-owned allowlisted relative paths.

---

### Task 1: Validated Origin Configuration

**Files:**
- Create: `apps/control-plane/src/http-origin.ts`
- Create: `apps/control-plane/src/http-origin.test.ts`

**Interfaces:**
- Produces: `httpOrigin(name: string, value: string): string`
- Produces: `browserLocation(origin: string, path: "/" | "/onboarding" | "/repositories" | "/onboarding?github=repository-selection-required"): string`

- [ ] **Step 1: Write failing origin-validation tests**

```ts
import { expect, test } from "bun:test";
import { browserLocation, httpOrigin } from "./http-origin.ts";

test("accepts an HTTP origin and removes only a trailing slash", () => {
  expect(httpOrigin("PUBLIC_BASE_URL", "http://localhost:3000/")).toBe("http://localhost:3000");
});

test.each([
  "ftp://localhost:3000",
  "http://user:pass@localhost:3000",
  "http://localhost:3000/api",
  "http://localhost:3000/?query=yes",
  "http://localhost:3000/#fragment",
])("rejects non-origin URL %s", (value) => {
  expect(() => httpOrigin("BROWSER_BASE_URL", value)).toThrow("BROWSER_BASE_URL must be an absolute HTTP(S) origin");
});

test("resolves repository-owned browser paths against the browser origin", () => {
  expect(browserLocation("http://localhost:5173", "/onboarding?github=repository-selection-required"))
    .toBe("http://localhost:5173/onboarding?github=repository-selection-required");
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test apps/control-plane/src/http-origin.test.ts`

Expected: FAIL because `http-origin.ts` does not exist.

- [ ] **Step 3: Implement strict origin parsing and browser destination construction**

```ts
const message = (name: string) => `${name} must be an absolute HTTP(S) origin`;

export function httpOrigin(name: string, value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message(name)); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(message(name));
  }
  return url.origin;
}

export function browserLocation(origin: string, path: "/" | "/onboarding" | "/repositories" | "/onboarding?github=repository-selection-required"): string {
  return new URL(path, `${origin}/`).toString();
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test apps/control-plane/src/http-origin.test.ts && bun run --filter @mars/control-plane typecheck`

Expected: all origin tests pass and the unchanged control plane typechecks.

- [ ] **Step 5: Commit the origin utility**

```bash
git add apps/control-plane/src/http-origin.ts apps/control-plane/src/http-origin.test.ts
git commit -m "refactor: validate control-plane origins"
```

---

### Task 2: OAuth Browser Redirects

**Files:**
- Modify: `apps/control-plane/src/http/types.ts:16-44`
- Modify: `apps/control-plane/src/http/test-deps.ts:6-34`
- Modify: `apps/control-plane/src/http/auth-routes.ts:18-37`
- Modify: `apps/control-plane/src/http/app.test.ts:138-147`
- Modify: `apps/control-plane/src/index.ts:20-27,63-64`

**Interfaces:**
- Consumes: `browserLocation()` from Task 1
- Produces: required `ControlPlaneHttpDeps.browserBaseUrl: string`
- Preserves: OAuth authorization and callback URL construction using `baseUrl`
- Produces: startup values `env.BASE` and `env.BROWSER_BASE`

- [ ] **Step 1: Add failing HTTP dependency and OAuth redirect tests**

Extend `fakeHttpDeps` coverage so overriding only `baseUrl` also defaults `browserBaseUrl` to the same value. Add a callback test with `baseUrl: "http://localhost:3000"` and `browserBaseUrl: "http://localhost:5173"`; supply deterministic setup-state/database rows and GitHub fetch responses already expected by `exchangeOAuth`, organization sync, and personal-workspace sync.

The observable assertions are:

```ts
expect(oauthAuthorizeUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Fgithub%2Fcallback");
expect(callback.headers.get("location")).toBe("http://localhost:5173/onboarding");
expect(repositoryCallback.headers.get("location")).toBe("http://localhost:5173/repositories");
expect(callback.headers.get("set-cookie")).toContain("mars_session=");
```

- [ ] **Step 2: Run the OAuth tests and verify RED**

Run: `bun test apps/control-plane/src/http/app.test.ts --test-name-pattern "browser origin|dashboard return path"`

Expected: FAIL because the callback still returns a relative port-3000 destination or because `browserBaseUrl` is not yet part of `ControlPlaneHttpDeps`.

- [ ] **Step 3: Add and default the HTTP browser-origin dependency**

Add `browserBaseUrl: string` beside `baseUrl` in `ControlPlaneHttpDeps`. In `fakeHttpDeps`, derive defaults before spreading overrides:

```ts
const baseUrl = overrides.baseUrl ?? "https://control-plane.test";
const browserBaseUrl = overrides.browserBaseUrl ?? baseUrl;
return { baseUrl, browserBaseUrl, /* existing defaults */, ...overrides };
```
- [ ] **Step 4: Wire validated origins into startup**

In `apps/control-plane/src/index.ts`, parse the public origin once and derive the browser origin from its optional override:

```ts
const baseUrl = httpOrigin("PUBLIC_BASE_URL", required("PUBLIC_BASE_URL"));
const browserBaseUrl = httpOrigin("BROWSER_BASE_URL", Bun.env.BROWSER_BASE_URL?.trim() || baseUrl);
```

In the existing `env` object, change `BASE: required("PUBLIC_BASE_URL")` to `BASE: baseUrl` and insert `BROWSER_BASE: browserBaseUrl` immediately before `WEBHOOK_URL`. Pass `env.BROWSER_BASE` to `createControlPlaneApp`. Keep webhook, worker, installer, and adapter construction on `env.BASE`. Task 3 adds the same explicit value to `GitHubAppService`.


- [ ] **Step 5: Route successful OAuth completion to the browser origin**

Keep `githubAuthorizeUrl`, `exchangeOAuth`, and `cookieAttributes` on `deps.baseUrl`. Replace the final relative redirect with:

```ts
const path = returnTo ?? (onboarding?.completed_at ? "/" : "/onboarding");
return c.redirect(browserLocation(deps.browserBaseUrl, path), 302);
```

The allowlist still limits `returnTo` to `"/repositories"`.

- [ ] **Step 6: Run OAuth tests and typecheck**

Run: `bun test apps/control-plane/src/http-origin.test.ts apps/control-plane/src/http/app.test.ts --test-name-pattern "browser origin|dashboard return path|unsafe OAuth" && bun run --filter @mars/control-plane typecheck`

Expected: selected tests pass; callback and cookie origins satisfy their separate contracts.

- [ ] **Step 7: Commit OAuth routing**

```bash
git add apps/control-plane/src/index.ts apps/control-plane/src/http/types.ts apps/control-plane/src/http/test-deps.ts apps/control-plane/src/http/auth-routes.ts apps/control-plane/src/http/app.test.ts
git commit -m "fix: return OAuth callbacks to browser origin"
```

---

### Task 3: GitHub App Browser Redirects

**Files:**
- Modify: `apps/control-plane/src/github-app.ts:23-35,119-150`
- Modify: `apps/control-plane/src/github-app.test.ts:23-31,200-221`
- Modify: `apps/control-plane/src/http/github-routes.ts:40-59`
- Modify: `apps/control-plane/src/http/app.test.ts:199-220`

**Interfaces:**
- Consumes: validated `browserBaseUrl` and `browserLocation()` from Task 1
- Changes: `GitHubAppService` constructor requires `{ baseUrl: string; browserBaseUrl: string }`
- Preserves: manifest callbacks, setup callbacks, and webhooks on `baseUrl`

- [ ] **Step 1: Write failing existing-install resume test**

Update the signed-webhook resume fixture to construct the service with different origins:

```ts
const github = new GitHubAppService({
  db: sql,
  fetch: async () => { throw new Error("GitHub should not be called"); },
  secretBox: new SecretBox(masterKey),
  baseUrl: "https://control-plane.test",
  browserBaseUrl: "http://localhost:5173",
});
expect(await github.beginInstallation("admin-1", organizationId, "resume-key"))
  .toEqual({ location: "http://localhost:5173/onboarding" });
```

Also update the shared service factory and every direct constructor to pass `browserBaseUrl`, normally equal to `baseUrl`.

- [ ] **Step 2: Write failing GitHub setup route tests**

Set `browserBaseUrl: "http://localhost:5173"` in the existing setup fixtures and assert:

```ts
expect(success.headers.get("location")).toBe("http://localhost:5173/onboarding");
expect(remediation.headers.get("location")).toBe("http://localhost:5173/onboarding?github=repository-selection-required");
expect(nonOnboarding.headers.get("location")).toBe("http://localhost:5173/");
```

Retain assertions that setup cookies are cleared and errors remain HTTP 409.

- [ ] **Step 3: Run GitHub tests and verify RED**

Run: `bun test apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts --test-name-pattern "resumes onboarding|repository selection|non-onboarding|browser origin"`

Expected: FAIL with port-3000 or relative redirect locations.

- [ ] **Step 4: Separate service callback and browser origins**

Store both constructor values:

```ts
private readonly baseUrl: string;
private readonly browserBaseUrl: string;
```

Use `baseUrl` for manifest `redirect_url`, `setup_url`, callback URLs, and the default webhook. Use `browserLocation(this.browserBaseUrl, "/onboarding")` only when an already-approved installation resumes onboarding.

- [ ] **Step 5: Use absolute browser destinations in GitHub setup routes**

After `completeInstallation`, redirect with:

```ts
return c.redirect(browserLocation(deps.browserBaseUrl, onboarding ? "/onboarding" : "/"), 302);
```

For `repository_selection_required`, redirect to:

```ts
browserLocation(deps.browserBaseUrl, "/onboarding?github=repository-selection-required")
```

Do not change inbound callback routes or webhook paths.

- [ ] **Step 6: Run complete control-plane tests and typecheck**

Run: `bun test apps/control-plane/src/http-origin.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts && bun run --filter @mars/control-plane typecheck`

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 7: Commit source behavior**

```bash
git add apps/control-plane/src/http-origin.ts apps/control-plane/src/http-origin.test.ts apps/control-plane/src/index.ts apps/control-plane/src/github-app.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/types.ts apps/control-plane/src/http/test-deps.ts apps/control-plane/src/http/auth-routes.ts apps/control-plane/src/http/github-routes.ts apps/control-plane/src/http/app.test.ts
git commit -m "fix: return dev callbacks to Vite"
```

---

### Task 4: Local Runtime and End-to-End Verification

**Files:**
- Modify locally: `.env:1-2` (ignored; do not commit secrets)
- Verify: `apps/control-plane/src/index.ts`
- Verify: `apps/web/src/routes/OnboardingPage.tsx`

**Interfaces:**
- Consumes: `BROWSER_BASE_URL` startup configuration from Task 2
- Produces: local callback path `:3000 callback -> :5173 current UI`

- [ ] **Step 1: Configure the local browser origin**

Add directly after `PUBLIC_BASE_URL` in the local `.env`:

```dotenv
BROWSER_BASE_URL=http://localhost:5173
```

Do not print, stage, or commit other `.env` values.

- [ ] **Step 2: Restart the development stack**

Start `bun run dev -- --kill` through the harness process supervisor rather than a finite shell command. Wait for both `Mars control plane listening on http://localhost:3000/` and `VITE ... ready` before browser interaction.

- [ ] **Step 3: Verify machine-facing URLs remain on port 3000**

Exercise the GitHub manifest launch through the UI with request interception. Assert `redirect_url` and `setup_url` use `http://localhost:3000`. Assert `hook_attributes.url` equals the currently configured `GITHUB_WEBHOOK_URL` rather than port 5173.

Also request a worker installer and confirm its injected `PUBLIC_BASE_URL` remains `http://localhost:3000`.

- [ ] **Step 4: Verify browser returns use Vite**

Browser-drive mocked successful OAuth and GitHub setup return paths through port 3000. Confirm each final URL begins with `http://localhost:5173/`, the page contains `Connect GitHub account` or the next server-derived onboarding step, and the loaded script is `/src/index.tsx` rather than `/index.js`.

- [ ] **Step 5: Run final verification**

Run:

```bash
bun test apps/control-plane/src/http-origin.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts apps/web/src/routes/OnboardingPage.test.tsx
bun run --filter @mars/control-plane typecheck
bun run --filter @mars/web typecheck
git diff --check
```

Expected: zero test failures, both typechecks exit 0, and diff check is clean.

- [ ] **Step 6: Publish the implementation**

Push the implementation commit directly to `main` per repository workflow:

```bash
git push origin main
```
