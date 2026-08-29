# GitHub Organization Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Mars administrators install the GitHub App into any eligible organization selected on GitHub, including organizations absent from the local OAuth organization list.

**Architecture:** Add an unbound onboarding installation state with `organizationId = null`. GitHub selects the account; the callback retrieves the immutable account ID/type, finds or creates the matching Mars workspace, persists the installation, and redirects to onboarding. Existing explicitly bound installations retain strict mismatch validation.

**Tech Stack:** Bun, TypeScript, Hono, React, TanStack Query, PostgreSQL tagged-template SQL, `bun:test`.

## Global Constraints

- GitHub account matching uses immutable numeric ID and `User`/`Organization` type, never login.
- Setup state is consumed only after account validation and persistence succeed.
- New workspace creation is limited to the initiating authenticated global administrator.
- Preserve personal GitHub workspaces, bound-installation mismatch errors, repository selection, and onboarding verification.
- Do not expose GitHub access tokens or App credentials to the browser.
- Skip formatters, linters, and project-wide test suites during individual tasks; run focused tests per task.

---

### Task 1: Add unbound installation service contracts

**Files:**
- Modify: `apps/control-plane/src/github-app.ts`
- Test: `apps/control-plane/src/github-app.test.ts`

**Interfaces:**
- `beginOrganizationInstallation(userId, organizationId, idempotencyKey)` remains available for existing organization settings.
- Add an onboarding-specific unbound begin method returning `{ location: string; installCookie?: string }`.
- `completeInstallation` accepts setup states whose `organizationId` is null and resolves the target workspace from GitHub account identity.

- [ ] **Step 1: Write failing service tests**

Add tests that:

```ts
const launch = await github.beginUnboundInstallation("admin-1", "key");
expect(launch.location).toContain("/installations/new");
const state = [...fakeDb.setupStates.values()][0] as { organizationId: string | null; purpose: string };
expect(state).toMatchObject({ organizationId: null, purpose: "organization_install" });
```

Add a stateful callback test where GitHub returns `{ account: { id: 123, type: "Organization", login: "speedhq" } }`, no existing workspace has ID 123, and the service creates the workspace, owner membership, installation, and repositories without throwing `wrong_organization`.

Add a failure test asserting an installation account mismatch for an explicitly bound state still throws `wrong_organization` and leaves the state unconsumed.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
bun test apps/control-plane/src/github-app.test.ts
```

Expected: the new unbound-installation tests fail because no unbound begin method or account-based workspace resolution exists.

- [ ] **Step 3: Implement account resolution and persistence**

Add helpers in `github-app.ts`:

```ts
private async findGithubAccount(githubAccountId: number, accountType: "User" | "Organization"): Promise<{ id: string; login: string } | null>
private async createGithubOrganization(userId: string, accountId: number, login: string): Promise<string>
```

For SQL, query `organizations` by both `github_org_id` and `github_account_type`. If an organization account is absent, insert it with the GitHub login and create an owner membership for `userId`. For the in-memory test database, add equivalent map behavior or extend the existing test fixture state without changing production persistence semantics.

Change `completeInstallation` so:

1. Fetches `/app/installations/:id` and validates account ID/type.
2. For a bound state, compares against `organizationGithubAccount` and preserves the current `wrong_organization` behavior.
3. For an unbound state, resolves an existing matching workspace or creates one for the initiating administrator.
4. Consumes setup state only after resolution succeeds.
5. Persists installation/repositories against the resolved workspace.
6. Updates first-run onboarding organization linkage for `purpose === "install"` or the unbound onboarding purpose as appropriate.

Add `beginUnboundInstallation(userId, idempotencyKey)` that saves `{ purpose: "organization_install", userId, organizationId: null, ... }` and returns the standard GitHub installation URL plus encrypted cookie.

- [ ] **Step 4: Run focused tests and confirm pass**

Run:

```bash
bun test apps/control-plane/src/github-app.test.ts
```

Expected: all GitHub App tests pass, including existing bound and personal-account cases.

- [ ] **Step 5: Commit the service change**

```bash
git add apps/control-plane/src/github-app.ts apps/control-plane/src/github-app.test.ts
git commit -m "feat(github): resolve unbound installations"
```

### Task 2: Expose unbound onboarding installation endpoint

**Files:**
- Modify: `apps/control-plane/src/http/onboarding-routes.ts`
- Test: `apps/control-plane/src/http/app.test.ts`

**Interfaces:**
- `POST /api/onboarding/github/install` accepts only an idempotency key and returns `{ location: string }`.
- Existing `POST /api/organizations/:organizationId/github/install` remains bound and unchanged.

- [ ] **Step 1: Write failing route tests**

Add an authenticated global-admin test that calls:

```ts
const response = await app.request("/api/onboarding/github/install", {
  method: "POST",
  headers: { "Idempotency-Key": "unbound-install" },
});
expect(response.status).toBe(200);
expect((await response.json()).location).toContain("/installations/new");
```

Add tests for missing authentication, non-admin access, missing idempotency key, and missing GitHub App service.

- [ ] **Step 2: Run focused route tests and confirm failure**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts
```

Expected: the new endpoint test returns 404.

- [ ] **Step 3: Implement the endpoint**

Register the route before the existing organization-specific GitHub routes. Require the current user and global-admin status, require `Idempotency-Key`, require `deps.githubApp`, then call `beginUnboundInstallation(user.id, key)`. Set the same `github_install_state` cookie attributes used by existing installation routes and return `{ location }`. Map known setup errors using the existing route error convention.

- [ ] **Step 4: Verify focused route tests**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts
```

Expected: all HTTP tests pass.

### Task 3: Route GitHub callback to resolved workspace

**Files:**
- Modify: `apps/control-plane/src/http/github-routes.ts`
- Modify: `apps/control-plane/src/github-app.ts` only if callback state handling requires it
- Test: `apps/control-plane/src/http/app.test.ts`

**Interfaces:**
- Existing `GET /api/github/app/setup?installation_id=...&setup_action=install` remains the callback endpoint.
- Successful unbound callbacks redirect to the onboarding browser origin.

- [ ] **Step 1: Write callback regression tests**

Add an HTTP test with a fake GitHub App service whose `completeInstallation` resolves `true`; assert the callback consumes the cookie and returns a 302 redirect to `/onboarding`. Add a failure test asserting `wrong_organization` remains HTTP 409 for bound callbacks and does not clear the cookie.

- [ ] **Step 2: Run focused callback tests and confirm failure**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts
```

Expected: unbound callback coverage fails until the route and cookie behavior support it.

- [ ] **Step 3: Implement callback behavior**

Keep callback routing centralized. Ensure successful completion clears `github_install_state` and redirects to the browser origin. Ensure known setup failures return their existing JSON error without consuming/clearing state unless the existing repository-selection flow explicitly requires it.

- [ ] **Step 4: Verify callback tests**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts
```

Expected: callback tests pass.

### Task 4: Replace onboarding account dropdown with GitHub picker launch

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: `apps/web/src/api.ts`
- Test: `apps/web/src/routes/OnboardingPage.test.tsx`

**Interfaces:**
- Add `beginUnboundOnboardingGithubInstall(): Promise<{ location: string }>` in `api.ts`.
- `GithubStep` calls the unbound endpoint and redirects to the returned location.

- [ ] **Step 1: Write failing web tests**

Update onboarding tests to render a GitHub step with no existing installation and assert:

- The UI renders an install button.
- It does not require or render the local `GitHub account` select.
- Clicking the button calls `/api/onboarding/github/install` with an idempotency key.
- A returned location is assigned to `window.location`.

- [ ] **Step 2: Run focused web tests and confirm failure**

Run:

```bash
bun test apps/web/src/routes/OnboardingPage.test.tsx
```

Expected: the existing dropdown assertions or missing endpoint behavior fail.

- [ ] **Step 3: Implement the GitHub picker UI**

Replace `organizationId` state and the account dropdown in the no-installation branch with explanatory copy: “GitHub will ask which account or organization should receive the Mars App.” Call the new API function from the install button. Retain the existing repository verification and installation-management UI after callback completion. Keep the create-manifest path for first-run App creation; after manifest creation, the subsequent installation must use the unbound chooser.

- [ ] **Step 4: Verify focused web tests**

Run:

```bash
bun test apps/web/src/routes/OnboardingPage.test.tsx
```

Expected: all onboarding tests pass.

### Task 5: Verify end-to-end contracts and clean up

**Files:**
- Test: `apps/control-plane/src/github-app.test.ts`
- Test: `apps/control-plane/src/http/app.test.ts`
- Test: `apps/web/src/routes/OnboardingPage.test.tsx`
- Modify only if required: related contract tests

- [ ] **Step 1: Run focused GitHub, HTTP, and web tests**

```bash
bun test apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts apps/web/src/routes/OnboardingPage.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Check account and state invariants**

Confirm through tests/source inspection that:

- Unbound flow creates/links `speedhq` based on immutable account ID.
- Bound flow still rejects mismatches with `wrong_organization`.
- Failed account lookup leaves setup state unconsumed.
- No browser code receives access tokens or App credentials.
- Existing organization settings installation remains functional.

- [ ] **Step 3: Run targeted type checks**

Run the existing package typecheck commands for `apps/control-plane` and `apps/web` only, if defined in their package manifests. Do not run project-wide checks in this task.

- [ ] **Step 4: Commit implementation**

```bash
git add apps/control-plane/src/github-app.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/onboarding-routes.ts apps/control-plane/src/http/github-routes.ts apps/control-plane/src/http/app.test.ts apps/web/src/api.ts apps/web/src/routes/OnboardingPage.tsx apps/web/src/routes/OnboardingPage.test.tsx
git commit -m "feat(github): install app into chosen org"
```
