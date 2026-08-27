# Stable Bootstrap Hono Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-request enrollment codes with one show-once, hash-only deployment bootstrap code that creates inert pending worker requests, and migrate every ordinary control-plane HTTP route to Hono under `/api`.

**Architecture:** Hono 4.13.1 becomes the ordinary HTTP router and test surface; Bun retains only WebSocket upgrade dispatch/callbacks. A singleton database credential stores one SHA-256 bootstrap hash and generation metadata. Reusable code submissions create idempotent pending worker identities, while global-admin approval binds organization and limits before any protected worker behavior is enabled.

**Tech Stack:** Bun 1.2+, TypeScript, Hono 4.13.1, PostgreSQL 17/postgres.js, React 19, TanStack Query, Zod, bun:test.

## Global Constraints

- Every backend HTTP endpoint lives below `/api`; `/healthz` is removed in favor of `/api/healthz`.
- Browser SPA routes/assets remain outside `/api`; `/api/**` never receives an SPA fallback.
- Bun continues to own WebSocket upgrades at `/api/v1/**`; Hono owns all non-upgrade HTTP requests.
- Generate one random 256-bit deployment bootstrap code and display plaintext only on initialize/rotate responses.
- Persist only SHA-256(code), timestamps, generation, and actor metadata—never plaintext or ciphertext.
- The same code may create multiple pending requests until rotation; rotation rejects old-code new requests but preserves existing pending rows.
- Pending requests receive no jobs, JIT, durable commands, management API, organization data, or scheduler admission.
- Global-admin approval assigns organization and all four positive-safe-integer worker limits.
- Copied commands intentionally include the one-use bootstrap code in argv/history, per operator preference.
- Loopback HTTP installer commands use `--proto '=http'`; non-loopback installer URLs require HTTPS plus TLS 1.3.
- No compatibility aliases: remove obsolete `/healthz`, `/api/workers/enroll`, and `worker_join_codes` usage.

---

### Task 1: Hono application boundary and common middleware

**Files:**
- Modify: `apps/control-plane/package.json`
- Modify: `bun.lock`
- Create: `apps/control-plane/src/http/types.ts`
- Create: `apps/control-plane/src/http/app.ts`
- Create: `apps/control-plane/src/http/static-routes.ts`
- Create: `apps/control-plane/src/http/test-deps.ts`

**Interfaces:**
- Consumes: existing `SessionUser`, PostgreSQL handle, OAuth state map, run lifecycle services, worker socket/dispatcher dependencies.
- Produces: `createControlPlaneApp(deps: ControlPlaneHttpDeps): Hono<ControlPlaneEnv>` and `ControlPlaneEnv = { Variables: { user: SessionUser } }`.

- [ ] **Step 1: Add Hono 4.13.1**

Run:

```bash
bun add --cwd apps/control-plane hono@4.13.1
```

Expected: `apps/control-plane/package.json` and `bun.lock` record Hono 4.13.1.

- [ ] **Step 2: Write failing application-boundary tests**

Create `http/app.test.ts` with real `app.request()` assertions:

```ts
import { describe, expect, test } from "bun:test";
import { createControlPlaneApp } from "./app.ts";

const app = createControlPlaneApp(fakeHttpDeps());

describe("control-plane HTTP boundary", () => {
  test("serves health only below /api", async () => {
    expect((await app.request("/api/healthz")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(404);
  });

  test("never serves the SPA for an unknown API route", async () => {
    const response = await app.request("/api/not-a-route");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("serves client routes outside the API namespace", async () => {
    expect((await app.request("/settings")).status).toBe(200);
  });
});
```

`fakeHttpDeps()` must provide deterministic session lookup, file paths, request IDs, and no live network/database dependencies.

- [ ] **Step 3: Run the boundary tests and verify RED**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts
```

Expected: FAIL because `createControlPlaneApp` does not exist.

- [ ] **Step 4: Implement typed Hono foundation**

In `http/types.ts` define:

```ts
export type ControlPlaneEnv = { Variables: { user: SessionUser } };
export type ControlPlaneHttpDeps = {
  db: DashboardDb;
  baseUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  bootstrapGithubLogin: string;
  githubWebhookSecret: string;
  currentUser(request: Request): Promise<SessionUser | null>;
  requestId(): string;
  requestSource(request: Request): string;
  webRoot: URL;
  workerInstallerRoot: URL;
  onWorkerAdopted(workerId: string): void;
};
```

In `http/app.ts`:

```ts
export function createControlPlaneApp(deps: ControlPlaneHttpDeps) {
  const app = new Hono<ControlPlaneEnv>();
  const api = new Hono<ControlPlaneEnv>().basePath("/api");
  api.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/", api);
  registerStaticRoutes(app, deps);
  app.notFound((c) => c.req.path.startsWith("/api/")
    ? c.json({ code: "not_found", message: "Resource not found", requestId: deps.requestId() }, 404)
    : c.text("Not found", 404));
  app.onError((cause, c) => {
    console.error(cause);
    return c.req.path.startsWith("/api/")
      ? c.json({ code: "internal_error", message: "Internal server error", requestId: deps.requestId() }, 500)
      : c.text("Internal server error", 500);
  });
  return app;
}
```

Add `requireSession(deps)` middleware using `createMiddleware<ControlPlaneEnv>()`; it sets `c.set("user", user)` or returns the existing typed 401 DTO.

Create `http/static-routes.ts` in this task. Register `/`, `/index.html`, `/index.js`, `/styles.css`, and the known SPA client routes with `Bun.file`, preserving `Cache-Control: no-cache`. `http/test-deps.ts` returns a complete deterministic `ControlPlaneHttpDeps` fixture with an empty fake DB, fixed IDs/configuration, and no network calls.

- [ ] **Step 5: Keep the production server on the existing router until route parity**

Do not modify `index.ts` yet. Task 2 migrates every current route family and performs one clean production cutover only after Hono parity tests pass.

- [ ] **Step 6: Run boundary tests and typecheck**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts
bun run --filter '@mars/control-plane' typecheck
```

Expected: the standalone Hono app passes `/api/healthz`, `/healthz`, unknown API, asset, and SPA-fallback tests while the live server remains unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/package.json bun.lock apps/control-plane/src/http
git commit -m "feat: add typed hono application boundary"
```

---

### Task 2: Migrate every existing HTTP route and cut over once

**Files:**
- Create: `apps/control-plane/src/http/auth-routes.ts`
- Create: `apps/control-plane/src/http/github-routes.ts`
- Create: `apps/control-plane/src/http/dashboard-routes.ts`
- Create: `apps/control-plane/src/http/worker-routes.ts`
- Modify: `apps/control-plane/src/http/static-routes.ts`
- Modify: `apps/control-plane/src/dashboard-api.ts`
- Modify: `apps/control-plane/src/dashboard-api.test.ts`
- Modify: `apps/control-plane/src/http/app.ts`
- Modify: `apps/control-plane/src/index.ts`

**Interfaces:**
- Consumes: `ControlPlaneEnv`, `ControlPlaneHttpDeps`, `requireSession`, existing DB query/service functions.
- Produces: `registerAuthRoutes`, `registerGithubRoutes`, `registerDashboardRoutes`, and `registerWorkerRoutes`; each accepts the Hono app and dependencies. `registerStaticRoutes` comes from Task 1.

- [ ] **Step 1: Write failing Hono route tests for every existing HTTP family**

Use `app.request()` to cover:

```ts
expect((await app.request("/api/auth/github")).status).toBe(302);
expect((await app.request("/api/organizations", { headers: sessionHeaders })).status).toBe(200);
expect((await app.request("/api/organizations/org/settings", { headers: sessionHeaders })).status).toBe(200);
expect((await app.request("/api/organizations", { headers: {} })).status).toBe(401);
expect((await app.request("/api/github/webhooks", { method: "POST", body: "{}" })).status).toBe(401);
expect((await app.request("/index.js")).headers.get("cache-control")).toBe("no-cache");
expect((await app.request("/api/workers/installer?audience=macos-arm64")).status).toBe(200);
expect((await app.request("/api/workers/enroll", { method: "POST", headers: sessionHeaders, body: "{}" })).status).not.toBe(404);
```

Include route-specific assertions already present in `dashboard-api.test.ts`: tenant 404, invalid cursor 400, idempotency requirement, and global-admin restrictions.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/dashboard-api.test.ts
```

Expected: FAIL because the route modules are not registered in the standalone Hono app.

- [ ] **Step 3: Register explicit Hono auth and GitHub routes**

Move OAuth start/callback and webhook logic without changing their service functions. Use `c.req.raw`, `c.redirect()`, `c.header("Set-Cookie", ...)`, and `c.json()`. Preserve raw webhook-body verification before JSON parsing and the 2 MiB body bound.

- [ ] **Step 4: Convert dashboard routing to explicit Hono methods**

Replace `createDashboardApi(request, user)` path matching with registrations such as:

```ts
protectedApi.get("/organizations", listOrganizationsHandler);
protectedApi.get("/organizations/:organizationId/overview", overviewHandler);
protectedApi.get("/organizations/:organizationId/runs", runsHandler);
protectedApi.get("/organizations/:organizationId/runs/:runId", runHandler);
protectedApi.get("/organizations/:organizationId/repositories", repositoriesHandler);
protectedApi.get("/organizations/:organizationId/workers", workersHandler);
protectedApi.get("/organizations/:organizationId/pools", poolsHandler);
protectedApi.get("/organizations/:organizationId/settings", getSettingsHandler);
protectedApi.put("/organizations/:organizationId/settings", updateSettingsHandler);
```

Use `c.req.param()`, `c.req.query()`, and `await c.req.json()` with the existing Zod schemas. Keep cross-tenant 404 behavior and typed errors. Remove `/api/v1/organizations` aliases.

- [ ] **Step 5: Migrate the current worker HTTP routes for parity**

Register the existing public join and installer endpoints plus protected list/enroll/adopt endpoints in `worker-routes.ts`. Preserve current behavior only for this cutover task; Task 4 replaces per-request enrollment with stable bootstrap routes. This makes the Hono cutover complete without temporarily removing worker provisioning.

- [ ] **Step 6: Verify SPA and asset routes from Task 1**

Keep `index.html`, `dist/index.js`, and `dist/index.css` on their known Hono paths with `Cache-Control: no-cache`. Confirm no wildcard catches `/api/**`.

- [ ] **Step 7: Perform one clean production cutover**

Construct `createControlPlaneApp(httpDeps)` in `index.ts`. Keep the existing WebSocket upgrade branch and callbacks; delegate every non-upgrade request to `app.fetch(request)`. Remove route regexes, manual `json()` dispatch, and `createDashboardApi` request dispatch in the same change. No legacy HTTP fallback remains.

Use a `WeakMap<Request, string>` in the composition root to attach `bunServer.requestIP(request)?.address ?? "unknown"` before calling `app.fetch(request)`. Expose it through `httpDeps.requestSource(request)` so public request rate limiting never trusts a client header.

- [ ] **Step 8: Run focused and full HTTP tests**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/dashboard-api.test.ts
bun run --filter '@mars/control-plane' typecheck
```

Expected: every pre-existing route family passes through Hono with typed 401/404/500 behavior; WebSocket tests remain unchanged.

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane/src/http apps/control-plane/src/dashboard-api.ts apps/control-plane/src/dashboard-api.test.ts apps/control-plane/src/index.ts
git commit -m "refactor: migrate control plane APIs to hono"
```

---

### Task 3: Persist the show-once stable bootstrap credential

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `apps/control-plane/src/worker-bootstrap.ts`
- Create: `apps/control-plane/src/worker-bootstrap.test.ts`
- Modify: `apps/control-plane/src/workers.ts`

**Interfaces:**
- Produces:
  - `initializeWorkerBootstrap(db, actorId): Promise<BootstrapReveal>`
  - `rotateWorkerBootstrap(db, actorId): Promise<BootstrapReveal>`
  - `getWorkerBootstrapStatus(db): Promise<BootstrapStatus>`
  - `verifyWorkerBootstrap(db, code): Promise<boolean>`
- `BootstrapReveal = { code: string; generation: number; createdAt: string }` exists only in function return memory.
- `BootstrapStatus = { initialized: boolean; generation: number | null; createdAt: string | null; rotatedAt: string | null }` never contains code.

- [ ] **Step 1: Write failing credential lifecycle tests**

Use a deterministic fake database or transaction harness to assert:

```ts
const reveal = await initializeWorkerBootstrap(db, "admin-1");
expect(reveal.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(await verifyWorkerBootstrap(db, reveal.code)).toBe(true);
expect(persistedRow).not.toHaveProperty("code");
expect(persistedRow.codeHash).toBeInstanceOf(Uint8Array);
await expect(initializeWorkerBootstrap(db, "admin-1")).rejects.toThrow("already initialized");

const rotated = await rotateWorkerBootstrap(db, "admin-2");
expect(rotated.code).not.toBe(reveal.code);
expect(await verifyWorkerBootstrap(db, reveal.code)).toBe(false);
expect(await verifyWorkerBootstrap(db, rotated.code)).toBe(true);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/control-plane/src/worker-bootstrap.test.ts
```

Expected: FAIL because lifecycle functions do not exist.

- [ ] **Step 3: Replace per-request code schema**

Add singleton table:

```sql
CREATE TABLE IF NOT EXISTS worker_bootstrap_credentials (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  code_hash bytea NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  rotated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);
DROP TABLE IF EXISTS worker_join_codes;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_requested_at timestamptz;
```

Add partial unique indexes for active `vm_uuid` and active public-key fingerprints covering `pending|adopted`; rejected/revoked identities may request again.

- [ ] **Step 4: Implement initialize, verify, and rotation**

Generate `randomBytes(32).toString("base64url")`; persist `sha256(Buffer.from(code, "base64url"))`. Initialize via singleton insert. Rotate in one transaction with a row lock, increment generation, replace hash, set actor/timestamps, and insert audit events containing generation only.

Delete `createEnrollmentCode` and `consumeJoin`; no plaintext compatibility path remains.

- [ ] **Step 5: Run tests and package checks**

Run:

```bash
bun test apps/control-plane/src/worker-bootstrap.test.ts
bun run --filter '@mars/db' typecheck
bun run --filter '@mars/control-plane' typecheck
```

Expected: lifecycle tests pass and no old worker-code symbols remain.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts apps/control-plane/src/worker-bootstrap.ts apps/control-plane/src/worker-bootstrap.test.ts apps/control-plane/src/workers.ts
git commit -m "feat: add stable worker bootstrap credential"
```

---

### Task 4: Authenticate idempotent pending worker requests

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/dashboard.ts`
- Create: `apps/control-plane/src/worker-requests.ts`
- Create: `apps/control-plane/src/worker-requests.test.ts`
- Modify: `apps/control-plane/src/http/worker-routes.ts`
- Modify: `apps/control-plane/src/http/app.ts`
- Modify: `apps/control-plane/src/workers.ts`
- Modify: `apps/control-plane/src/worker-dispatch.test.ts`

**Interfaces:**
- Produces `WorkerBootstrapRequest`, `PendingWorkerRequest`, `ApproveWorkerRequest`, and `requestPendingWorker(db, input)`.
- Public endpoint: `POST /api/workers/join`.
- Protected endpoints:
  - `GET /api/workers/bootstrap`
  - `POST /api/workers/bootstrap/initialize`
  - `POST /api/workers/bootstrap/rotate`
  - `GET /api/workers/pending`
  - `POST /api/workers/pending/:workerId/approve`
  - `POST /api/workers/pending/:workerId/reject`

- [ ] **Step 1: Define failing request-state tests**

Cover:

```ts
expect((await requestPendingWorker(db, first)).status).toBe("created");
expect((await requestPendingWorker(db, first)).status).toBe("existing");
await expect(requestPendingWorker(db, { ...first, publicKey: otherKey }))
  .rejects.toMatchObject({ code: "identity_conflict" });
expect(await requestWithOldCodeAfterRotation()).toMatchObject({ status: 401 });
expect(await pendingBeforeRotation()).toRemainPending();
```

Also assert two different machine/key pairs can use the same bootstrap code and create distinct pending rows.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/control-plane/src/worker-requests.test.ts
```

Expected: FAIL because stable request service/contracts do not exist.

- [ ] **Step 3: Implement validated request contracts**

`WorkerBootstrapRequest` must require base64url code, immutable supported platform, public key, VM/machine UUID, reported limits, and doctor/capacity data. All numeric values use existing positive-safe-integer schemas. `PendingWorkerRequest` excludes the bootstrap code.

- [ ] **Step 4: Implement idempotent request transaction**

Within a transaction:

1. Verify the stable hash before identity writes.
2. Acquire a transaction-scoped advisory lock derived from machine UUID.
3. Query active rows matching VM UUID or fingerprint.
4. Exact same UUID+fingerprint: update `last_requested_at`, connection/doctor/capacity, return existing pending ID.
5. One-sided match: insert audit event and return typed 409 conflict.
6. No match: insert organization-null `pending` worker and audit `worker.requested`.

Use one generic 401 for invalid/rotated codes. Add a dependency-injected in-memory limiter keyed by `deps.requestSource(c.req.raw)`: five invalid attempts per minute, returning 429 thereafter. Successful requests clear that key.

- [ ] **Step 5: Implement global-admin bootstrap and pending routes in Hono**

Initialize/rotate require global admin plus `Idempotency-Key`; reveal responses are `Cache-Control: no-store`. Status never returns code. Approval body contains target `organizationId` and validated limits; approval atomically assigns tenant/limits and changes admission state. Reject changes only the pending row.

Remove `/api/workers/enroll` and the old direct adopt route.

- [ ] **Step 6: Prove pending workers remain powerless**

Extend worker socket/dispatch/scheduler tests so a pending request cannot authenticate a protected socket, receive replayed commands, or schedule. Approved workers retain existing challenge/signature behavior.

- [ ] **Step 7: Run focused tests**

Run:

```bash
bun test apps/control-plane/src/worker-bootstrap.test.ts apps/control-plane/src/worker-requests.test.ts apps/control-plane/src/worker-dispatch.test.ts tests/worker-dispatch.test.ts
bun run typecheck
```

Expected: stable reuse/idempotency/rotation/approval tests pass; pending dispatch tests remain fail-closed.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts apps/control-plane/src/http/worker-routes.ts apps/control-plane/src/http/app.ts apps/control-plane/src/worker-requests.ts apps/control-plane/src/worker-requests.test.ts apps/control-plane/src/workers.ts apps/control-plane/src/worker-dispatch.test.ts tests/worker-dispatch.test.ts
git commit -m "feat: gate pending workers behind admin approval"
```

---

### Task 5: Make every installer accept the bootstrap code argument

**Files:**
- Modify: `deploy/workers/install-worker.sh`
- Modify: `deploy/workers/install-worker-macos.sh`
- Modify: `deploy/workers/install-worker.ps1`
- Create: `tests/installer-arguments.test.ts`

**Interfaces:**
- Linux/macOS: exactly `--code <base64url>`.
- Windows: mandatory `[Parameter(Mandatory=$true)][string]$Code`.
- Produces the existing code handoff to worker join without an interactive prompt.

- [ ] **Step 1: Write failing argument tests**

Use Bun subprocesses with no hardware side effects. Missing/empty/unknown/duplicate arguments must fail before checking KVM, Tart, Hyper-V, environment, or installed binaries. Assert valid parsing through a sourced parser function for POSIX and static PowerShell parameter metadata.

```ts
expect(await runMacInstaller([])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("--code") });
expect(await runLinuxInstaller(["--unknown"])).toMatchObject({ exitCode: 2 });
expect(readPowerShell()).toContain("[Parameter(Mandatory=$true)]");
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test tests/installer-arguments.test.ts
```

Expected: FAIL because installers still prompt interactively.

- [ ] **Step 3: Implement strict POSIX parsers**

At the top of each shell installer:

```sh
JOIN_CODE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --code) [ -z "$JOIN_CODE" ] && [ "$#" -ge 2 ] || usage; JOIN_CODE=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$JOIN_CODE" ] || usage
```

Require the 43-character base64url format before host changes. Remove TTY/read requirements. Keep cleanup/trap unsetting the variable.

- [ ] **Step 4: Implement mandatory PowerShell `-Code`**

Add a file-level `param` block, validate base64url length, and clear `$Code` in `finally`. Remove `Read-Host`. Ensure code is handed to the Windows join/bootstrap material rather than merely accepted.

- [ ] **Step 5: Run installer tests**

Run:

```bash
bun test tests/installer-arguments.test.ts
```

Expected: all argument validation passes without provisioning hardware.

- [ ] **Step 6: Commit**

```bash
git add deploy/workers tests/installer-arguments.test.ts
git commit -m "feat: pass bootstrap code to worker installers"
```

---

### Task 6: Generate show-once commands containing the stable code

**Files:**
- Modify: `apps/web/src/components/EnrollmentWizard.tsx`
- Modify: `apps/web/src/components/EnrollmentWizard.test.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/routes/WorkersPage.tsx`

**Interfaces:**
- `buildInstallerCommand(installer: string, audience: RuntimePlatform, code: string): string`.
- API client produces `getWorkerBootstrapStatus`, `initializeWorkerBootstrap`, and `rotateWorkerBootstrap`.

- [ ] **Step 1: Update command tests to fail on missing embedded code**

Assert exact target syntax and quoting:

```ts
expect(buildInstallerCommand(localMacUrl, "macos-arm64", code))
  .toContain(`zsh "$mars_installer" --code '${code}'`);
expect(buildInstallerCommand(httpsLinuxUrl, "linux-x64", code))
  .toContain(`bash "$mars_installer" --code '${code}'`);
expect(buildInstallerCommand(httpsWindowsUrl, "windows-x64", code))
  .toContain(`-Code '${code}'`);
```

Include metacharacter quoting tests even though generated codes are base64url.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/web/src/components/EnrollmentWizard.test.ts
```

Expected: FAIL because the helper does not accept/embed code.

- [ ] **Step 3: Implement three-argument command generation**

Preserve temporary-file cleanup and protocol policy. Place the code only in the final interpreter invocation; never add it to installer URL. Throw on unsupported audience, invalid URL protocol, or empty code.

- [ ] **Step 4: Replace per-request enrollment wizard**

The Workers action reads bootstrap status:

- uninitialized: **Initialize worker bootstrap**;
- initialized: **Rotate bootstrap code** with an explicit destructive confirmation;
- successful initialize/rotate: show the code once and all three exact command blocks;
- each block has **Copy install command** that copies the displayed text;
- closing the reveal clears component state; reopening cannot reveal and shows rotate-only state.

Remove vCPU/memory/storage fields and `enrollWorker` calls. Set `Cache-Control: no-store` behavior through the API and do not place the code in TanStack Query cache; mutation result lives only in local component state.

- [ ] **Step 5: Run component tests and React Doctor**

Run:

```bash
bun test apps/web/src/components/EnrollmentWizard.test.ts
npx -y react-doctor@latest apps/web --verbose --scope changed
bun run --filter '@mars/web' typecheck
bun run --filter '@mars/web' build
```

Expected: command/component tests pass, React Doctor reports no new issue, build exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/EnrollmentWizard.tsx apps/web/src/components/EnrollmentWizard.test.ts apps/web/src/api.ts apps/web/src/routes/WorkersPage.tsx
git commit -m "feat: show stable bootstrap commands once"
```

---

### Task 7: Add global pending-request approval UI

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/routes/WorkersPage.tsx`
- Create: `apps/web/src/components/PendingWorkerRequests.tsx`
- Create: `apps/web/src/components/PendingWorkerRequests.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes `PendingWorkerRequest[]`, selected organization ID, and four approval limits.
- Produces calls to approve/reject Hono routes and invalidates `['pending-workers']` plus `['org', organizationId, 'workers']`.

- [ ] **Step 1: Write failing pending-request UI tests**

Render with a QueryClient and assert fingerprint, platform, machine identity, reported limits, organization target, four editable limit inputs, Approve, and Reject. Assert pending empty/error states and that approval submits organization plus limits.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/web/src/components/PendingWorkerRequests.test.tsx
```

Expected: FAIL because the component/API functions do not exist.

- [ ] **Step 3: Implement pending-request query and cards**

Global admins see pending requests above organization workers. Each card displays copyable fingerprint and machine facts. Approve defaults limit fields from reported limits but validates against contracts; it assigns the currently selected organization. Reject requires no bootstrap rotation.

- [ ] **Step 4: Implement invalidation and user-visible errors**

Use organization-rooted keys for adopted workers and a global-admin-only `['pending-workers']` key. 401 renders sign-in, 403 hides bootstrap controls with an authorization message, 409 identity conflicts remain visible and copyable.

- [ ] **Step 5: Run UI tests and build**

Run:

```bash
bun test apps/web/src/components/PendingWorkerRequests.test.tsx
bun run --filter '@mars/web' typecheck
bun run --filter '@mars/web' build
```

Expected: PASS and no blank/error-only Workers view.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/routes/WorkersPage.tsx apps/web/src/components/PendingWorkerRequests.tsx apps/web/src/components/PendingWorkerRequests.test.tsx apps/web/src/styles.css
git commit -m "feat: approve pending worker requests in UI"
```

---

### Task 8: End-to-end verification and cleanup

**Files:**
- Modify only files required by failures found below.

**Interfaces:**
- Verifies the complete Hono + stable bootstrap + pending approval contract.

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
```

Expected: zero failures; build may retain only the already-known Astryx `@property` warnings.

- [ ] **Step 2: Start the control plane and verify Hono route boundaries**

Exercise:

```text
GET  /api/healthz                         -> 200 JSON
GET  /healthz                             -> 404
GET  /api/not-a-route                     -> 404 JSON, never HTML
GET  /settings                            -> 200 SPA
GET  /api/workers/installer?...           -> 200 artifact
```

Confirm index/assets use `Cache-Control: no-cache`, reveal responses use `no-store`, and browser console has no error/warning.

- [ ] **Step 3: Exercise show-once bootstrap in Chromium**

As global admin initialize the bootstrap, save the revealed code/commands, close/reopen, and confirm plaintext is gone. Generate no second credential without explicit rotation. Copy each platform command and compare clipboard text to the displayed block.

- [ ] **Step 4: Exercise reusable request and approval**

Submit two fixture machines with the same code; expect two pending rows. Replay one exact identity; expect the same pending ID. Submit same VM UUID with another key; expect typed 409. Approve one into `SpeedHQ` with limits; reject the other. Confirm only the approved worker enters the tenant list and pending/rejected workers never receive commands.

- [ ] **Step 5: Exercise rotation**

Rotate, save the replacement once, then prove: old code returns generic 401 for new requests, new code creates pending, and pre-rotation pending records remain actionable.

- [ ] **Step 6: Verify persistence contains no plaintext code**

Query only column names/types and hashes; scan serialized commands, audits, workers, logs, and Hono errors for the revealed code. Expected: plaintext appears only in the initialize/rotate response, browser-local reveal state, copied command, and installer argv accepted by design.

- [ ] **Step 7: Remove obsolete code and scaffolding**

Delete unused per-request enrollment DTOs, helpers, route aliases, interactive installer prompts, `worker_join_codes` references, and any legacy fetch dispatcher. Re-run the full automated suite after cleanup.

- [ ] **Step 8: Commit final cleanup**

```bash
git add -A
git commit -m "test: verify stable bootstrap enrollment"
```
