# Personal GitHub Account Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit GitHub App installations on personal accounts as first-class Whitesmith workspaces while preserving organization installs and tenant isolation.

**Architecture:** Reuse the `organizations` table as the workspace table and add an explicit `github_account_type` discriminator. Personal workspaces use the authenticated GitHub user's immutable ID as the account ID, receive an owner membership, and flow through the existing repository approval and scheduler paths. Installation callbacks validate both account type and immutable account ID.

**Tech Stack:** Bun, TypeScript, Hono, PostgreSQL, postgres.js, Zod, Bun test, React.

## Global Constraints

- Existing workspaces backfill to `github_account_type='Organization'`.
- Never match GitHub accounts by mutable login; use immutable IDs.
- Personal workspaces must be private/internal repository eligible under the existing approval rules.
- Mismatched account type or ID returns `wrong_github_account` without mutating setup or repository state.
- Do not implement the separate guest Actions runner/JIT bridge in this change.

---

### Task 1: Add workspace account discriminator migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/src/schema.test.ts` or the existing schema/database regression test file

**Interfaces:**
- Produces `organizations.github_account_type` with values `User | Organization`.

- [ ] Add an idempotent `github_account_type text NOT NULL DEFAULT 'Organization'` column and check constraint to the organizations schema.
- [ ] Backfill existing rows to `Organization` before enforcing the constraint.
- [ ] Add a unique index preventing duplicate `(github_account_type, github_org_id)` account identities.
- [ ] Add schema assertions proving old rows backfill as organizations and invalid discriminator values are rejected.
- [ ] Run the focused database/schema test.

### Task 2: Add personal workspace upsert service

**Files:**
- Modify: `packages/db/src/organizations.ts` (or the existing organization persistence module)
- Modify: `packages/db/src/index.ts`
- Test: organization database tests

**Interfaces:**
- Produces `upsertPersonalWorkspace(db, { githubUserId: number; login: string; userId: string }): Promise<{ id: string; githubOrgId: number; login: string; githubAccountType: 'User' }>`.

- [ ] Write tests for first creation, repeat upsert, login refresh, owner membership creation, and conflict with an existing organization account ID.
- [ ] Implement the operation in one transaction using the immutable GitHub user ID.
- [ ] Upsert the workspace display login without changing its account type or immutable ID.
- [ ] Insert the owner membership with `ON CONFLICT DO NOTHING`.
- [ ] Export the named function and its result type.
- [ ] Run the focused organization tests.

### Task 3: Bind personal workspace selection to GitHub installation flow

**Files:**
- Modify: `apps/control-plane/src/github-app.ts`
- Modify: `apps/control-plane/src/http/github-routes.ts`
- Modify: `apps/control-plane/src/http/types.ts`
- Test: `apps/control-plane/src/github-app.test.ts`

**Interfaces:**
- `GitHubAppService.completeInstallation` continues to accept `(userId: string, installCookie: string, installationId: number): Promise<boolean>`.
- `GitHubAppService.beginInstallation` continues to accept a workspace UUID; personal workspace creation occurs before state creation in the route/service boundary.

- [ ] Extend database/fake types with `githubAccountType`.
- [ ] Update account lookup to return `{ id, type }` and workspace lookup to return `{ githubAccountId, githubAccountType }`.
- [ ] In `completeInstallation`, accept `User` only for a `User` workspace with equal immutable IDs; accept `Organization` only for an `Organization` workspace with equal IDs.
- [ ] Throw `wrong_github_account` before consuming install state or persisting repositories on mismatch.
- [ ] Add tests for successful personal installation, personal-to-organization mismatch, organization-to-personal mismatch, and unchanged organization success.
- [ ] Update `setupFailure` to expose `wrong_github_account` as HTTP 409.
- [ ] Run GitHub App tests.

### Task 4: Create/select personal workspaces in the authenticated UI flow

**Files:**
- Modify: `apps/control-plane/src/http/github-routes.ts`
- Modify: `apps/control-plane/src/github.ts` or the current organization sync service
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/routes/RepositoriesPage.tsx`
- Test: `apps/control-plane/src/http/app.test.ts`, web route/API tests

**Interfaces:**
- Personal workspace creation is authorized only for the authenticated global administrator and uses the OAuth-resolved GitHub user ID/login.
- Workspace summaries continue to use the existing `OrganizationSummary` DTO; account type is optional metadata only if needed by the picker.

- [ ] Add a route/service operation that upserts the current authenticated GitHub user as a personal workspace and returns its workspace ID.
- [ ] Ensure the GitHub installation launch can target that returned ID with an idempotency key.
- [ ] Add a personal workspace option in the organization picker without exposing credentials.
- [ ] Render `wrong_github_account` as an actionable installation error and preserve prior setup state.
- [ ] Add HTTP regression tests for unauthorized access, idempotent upsert, and personal install launch.
- [ ] Run focused control-plane and web tests.

### Task 5: Preserve repository/webhook/scheduler behavior for personal workspaces

**Files:**
- Modify: `apps/control-plane/src/runs.ts` only if account-type assumptions exist
- Modify: `packages/db/src/dashboard.ts` only if workspace queries assume organizations
- Test: `tests/dashboard-contracts.test.ts`, `tests/dashboard-db.test.ts`, webhook/scheduler tests

**Interfaces:**
- All downstream APIs continue receiving workspace UUIDs and must not branch on account type.

- [ ] Search and remove any remaining `account.type === 'Organization'` or `githubOrgId` naming assumptions that reject personal workspaces.
- [ ] Prove a synchronized private personal repository can be explicitly approved.
- [ ] Prove a workflow job webhook for that approved repository is accepted into the same workspace scheduler path.
- [ ] Prove public/unavailable/unapproved personal repositories remain rejected.
- [ ] Run the focused dashboard, webhook, and scheduler tests.

### Task 6: Full verification and smoke-test preparation

**Files:**
- No production files unless verification exposes a defect.
- Test: all affected test files

- [ ] Run `bun run typecheck`.
- [ ] Run `bun test`.
- [ ] Run `bun run build`.
- [ ] With authenticated GitHub access, create/select the personal `Snazzie` workspace, launch installation for `Snazzie/whitesmith`, select the private repository, approve it, and verify repository/webhook records.
- [ ] Record the remaining independent execution limitation if the guest Actions runner/JIT bridge is still absent; do not claim a job was picked up without a completed GitHub run and Whitesmith lifecycle evidence.
- [ ] Store the completed decision and verification result in ICM.
