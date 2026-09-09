# GitHub Settings Connections and Rate Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add organization-level GitHub connection management and live GitHub API rate-limit statistics to Settings.

**Architecture:** Reuse the existing single active GitHub App installation per organization and existing install, settings, refresh, and uninstall flows. Add a typed dashboard endpoint that queries GitHub with the organization installation token and returns response-header quota data without persistence. Compose the new connection and quota cards in `SettingsPage`; keep dashboard OAuth identity/sign-out separate.

**Tech Stack:** TypeScript, Hono control-plane routes, Zod contracts, PostgreSQL tagged SQL, React, TanStack Query, Bun tests, happy-dom.

## Global Constraints

- Keep one active GitHub App connection per organization; do not redesign installation storage.
- Reuse existing global-admin authorization and idempotency-key conventions for mutations.
- Do not persist volatile GitHub rate-limit counters.
- Preserve repository-specific GitHub controls and existing resource settings behavior.
- Add focused tests for observable API and Settings behavior; skip project-wide formatting/linting during implementation.

---

### Task 1: Add typed GitHub connection summary and rate-limit API

**Files:**
- Modify: `packages/contracts/src/dashboard.ts` near existing dashboard schemas
- Modify: `apps/control-plane/src/http/dashboard-routes.ts` near existing GitHub organization routes
- Modify: `apps/control-plane/src/github-app.ts` near authenticated installation API helpers
- Modify: `apps/web/src/api.ts` near existing GitHub organization functions
- Test: `apps/control-plane/src/http/app.test.tsx` near GitHub dashboard route tests
- Test: `apps/web/src/api.test.ts` near dashboard API URL/schema tests

**Interfaces:**
- Produce `GithubConnectionSummary` with `connected`, optional `login`, `accountType`, `installationId`, and optional management `location`.
- Produce `GithubRateLimitStats` with `limit`, `remaining`, `used`, and `resetAt` ISO timestamp.
- Produce `getGithubConnection(organizationId)` and `getGithubRateLimit(organizationId)` frontend API functions.
- Add `GET /api/organizations/:organizationId/github/connection` and `GET /api/organizations/:organizationId/github/rate-limit`.

- [ ] **Step 1: Write failing contract and route tests**
  - Assert the connection response validates both disconnected and connected shapes.
  - Assert rate-limit response includes numeric quota fields and an ISO reset timestamp.
  - Assert route authorization rejects unauthorized organizations, disconnected organizations return the existing not-found code, and a GitHub response with `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-used`, and `x-ratelimit-reset` is converted to the typed response.

- [ ] **Step 2: Run focused tests to verify failure**
  - Run: `bun test apps/control-plane/src/http/app.test.tsx apps/web/src/api.test.ts`
  - Expected: failures for missing schemas, API functions, and routes.

- [ ] **Step 3: Implement contracts and frontend API functions**
  - Add strict Zod schemas in `packages/contracts/src/dashboard.ts`.
  - Import them in `apps/web/src/api.ts` and implement GET wrappers using the existing request helper.
  - Preserve the existing `getGithubOrganizationSettings` function for compatibility with repository-page behavior.

- [ ] **Step 4: Implement backend route handlers**
  - Connection route: guard organization, select the newest installation with organization/account identifiers, return `connected: false` when absent, otherwise derive the existing GitHub installation management URL.
  - Rate-limit route: guard organization and require an installation; call the existing GitHub App installation-token request helper against a low-cost authenticated endpoint such as `/installation/repositories?per_page=1`; parse all four `x-ratelimit-*` headers and convert reset epoch seconds with `new Date(reset * 1000).toISOString()`.
  - Map absent installation to `404 not_found`; map GitHub configuration/API failures through existing error handling without leaking tokens.

- [ ] **Step 5: Run focused tests to verify the implementation**
  - Run: `bun test apps/control-plane/src/http/app.test.tsx apps/web/src/api.test.ts`
  - Expected: PASS.

### Task 2: Compose connection management and quota cards in Settings

**Files:**
- Modify: `apps/web/src/routes/SettingsPage.tsx`
- Modify: `apps/web/src/routes/SettingsPage.test.tsx`
- Modify: `apps/web/src/styles.css` only if existing settings/card styles cannot express the new layout
- Reference: `apps/web/src/routes/RepositoriesPage.tsx` for current mutation copy and action conventions

**Interfaces:**
- Consume `getGithubConnection`, `getGithubRateLimit`, `beginOrganizationGithubInstall`, `getGithubOrganizationSettings`, `refreshGithubConnection`, and `uninstallOrganizationGithub`.
- Use React Query keys `['org', organizationId, 'github-connection']` and `['org', organizationId, 'github-rate-limit']`.

- [ ] **Step 1: Extend Settings tests with failing behavior assertions**
  - Seed connected and disconnected query responses.
  - Assert Settings renders “GitHub connection”, add/manage/sync/remove actions, quota limit/remaining/used/reset values, and explicit loading/error/disconnected states.
  - Assert connection actions invalidate connection, rate-limit, repositories, and organizations queries as appropriate.

- [ ] **Step 2: Run the Settings test to verify failure**
  - Run: `bun test apps/web/src/routes/SettingsPage.test.tsx`
  - Expected: failures because the new sections and queries do not exist.

- [ ] **Step 3: Implement the connection section**
  - Add `useQuery` calls enabled only for a selected organization.
  - Add mutations for install, refresh, and uninstall using generated idempotency keys through existing API functions.
  - Render disconnected state with “Add GitHub connection”; connected state with account/install identity and management, sync, and remove actions.
  - Keep OAuth signed-in identity and sign-out wording unchanged.
  - Use `QueryState`/`role="alert"` conventions and disable controls while mutations are pending.

- [ ] **Step 4: Implement the quota card**
  - Query rate-limit stats only when the connection is connected.
  - Render remaining and limit prominently, used count, reset time, and a refresh button that refetches the quota query.
  - Render explicit unavailable/error copy without hiding resource settings or connection controls.
  - Add accessible headings and labels; do not rely on color alone for quota state.

- [ ] **Step 5: Run focused Settings tests**
  - Run: `bun test apps/web/src/routes/SettingsPage.test.tsx apps/web/src/routes/RepositoriesPage.test.tsx`
  - Expected: PASS, including unchanged repository connection behavior.

### Task 3: Validate contracts, types, and live Settings behavior

**Files:**
- Modify: `apps/control-plane/src/http/app.test.tsx` only for any uncovered route edge case found by focused testing.
- Modify: `apps/web/src/routes/SettingsPage.test.tsx` only for any uncovered accessible-state boundary.

- [ ] **Step 1: Run complete focused verification**
  - Run: `bun test apps/control-plane/src/http/app.test.tsx apps/web/src/api.test.ts apps/web/src/routes/SettingsPage.test.tsx apps/web/src/routes/RepositoriesPage.test.tsx`
  - Expected: PASS.

- [ ] **Step 2: Run type validation**
  - Run: `bun run --filter '@mars/web' typecheck`
  - Run the repository’s control-plane typecheck command from package scripts.
  - Expected: PASS with no new diagnostics.

- [ ] **Step 3: Smoke-test the actual Settings surface**
  - Run the normal dev command: `bun run dev`.
  - Open `/settings` for an organization with no installation and verify Add GitHub connection plus resource settings.
  - Open an organization with an installation and verify account identity, management/sync/remove actions, quota values, reset time, and manual refresh.
  - Exercise a quota API failure and verify an inline error while the rest of Settings remains usable.

- [ ] **Step 4: Review the diff for scope**
  - Confirm no duplicate organization-level connection controls were introduced outside the intended Settings section, no rate-limit counters are persisted, and existing repository-specific controls remain functional.
