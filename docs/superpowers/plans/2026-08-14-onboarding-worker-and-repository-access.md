# Onboarding Worker and Repository Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Work directly on `main` and push each completed task to `origin main` per repository workflow.

**Goal:** Make Worker approval/configuration a mandatory first-run gate and make active GitHub App access the only repository authorization boundary.

**Architecture:** Remove repository approval from contracts, persistence, routes, discovery, and UI. Repository rows remain durable history records whose `available` bit mirrors current GitHub App access; active operations require `available=true` and an approved installation. Onboarding derives four steps from verified server state: Admin, Worker, GitHub, Trigger labels. A selected worker does not advance until it is adopted and its configuration acknowledgement is `ready`.

**Tech Stack:** Bun, TypeScript, Zod, PostgreSQL tagged templates, Hono, React, TanStack Query, `bun:test`.

**Source specification:** `docs/superpowers/specs/2026-08-14-onboarding-worker-and-repository-access-design.md`

---

## Task 1: Remove repository approval from contracts and schema

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/contracts/src/onboarding.ts`
- Modify: `tests/dashboard-contracts.test.ts`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/schema.test.ts`

**Interfaces:**
- `RepositorySummary` keeps `id`, `organizationId`, `name`, `fullName`, `visibility`, `available`, and `installationId`; it no longer exposes `approved`.
- Delete `ApproveOnboardingRepositoriesRequest` and its inferred type.
- Delete the corresponding re-exports from the contracts barrel if present.
- `OnboardingStep` becomes `admin | worker | github | labels | complete`; remove `resources`.
- New installations do not create `dashboard_repositories.approved`; existing installations drop it idempotently.

- [ ] **Step 1: Write failing contract and schema tests**

Update contract fixtures so `RepositorySummary.parse(...)` accepts rows without `approved`, and assert strict parsing rejects an obsolete `approved` property. Assert `OnboardingStep` rejects `resources`. Remove approval-request tests and add a schema assertion that repository creation omits the column while the migration contains:

```sql
ALTER TABLE dashboard_repositories DROP COLUMN IF EXISTS approved;
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
bun test tests/dashboard-contracts.test.ts packages/db/src/schema.test.ts
```

Expected: failures reference the still-required `approved` field and old schema.

- [ ] **Step 3: Cut over contracts and schema**

Change the initial `CREATE TABLE dashboard_repositories` definition to omit `approved`. Add the idempotent `DROP COLUMN` after table creation so an existing control-plane database migrates without data loss to repository rows or run history. Remove the approval request schema/type and all barrel exports.

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
bun test tests/dashboard-contracts.test.ts packages/db/src/schema.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit and push**

```bash
git add packages/contracts/src/dashboard.ts packages/contracts/src/onboarding.ts tests/dashboard-contracts.test.ts packages/db/src/schema.ts packages/db/src/schema.test.ts
git commit -m "refactor: remove repository approval contract"
git push origin main
```

---

## Task 2: Gate onboarding on a ready worker and active GitHub access

**Files:**
- Modify: `packages/db/src/onboarding.ts`
- Modify: `packages/db/src/onboarding.test.ts`
- Modify: `packages/db/src/dashboard.ts`
- Modify: `packages/db/src/dashboard.test.ts`
- Modify: `packages/db/src/index.ts` only if deleted approval functions are exported there

**Behavior:**
- Onboarding steps are `admin`, `worker`, `github`, `labels`, `complete`.
- `worker`: no selected worker, rejected/revoked selection, pending selection, or configuration not `ready`.
- `github`: selected worker is `adopted` and `ready`, but there is no active approved installation with at least one available repository.
- `labels`: worker and GitHub gates pass, but no enabled pool with a trigger label exists.
- Repository listing returns historical available/unavailable rows without approval state.

- [ ] **Step 1: Write failing onboarding transition tests**

In `packages/db/src/onboarding.test.ts`, cover at minimum:

1. selected `pending` + `unconfigured` worker remains on `worker`;
2. selected `adopted` + `unconfigured` worker remains on `worker`;
3. selected `adopted` + `ready` worker advances to `github` when no installation is ready;
4. an approved installation plus any available repository (private, internal, or public) advances to `labels`;
5. unavailable repositories do not satisfy the GitHub gate.

Adjust expected SQL predicates from `r.available=true AND r.approved=true` to `r.available=true`, and remove the `resources` step expectation.

- [ ] **Step 2: Write failing dashboard repository tests**

Update `packages/db/src/dashboard.test.ts` fixtures/expectations so `listRepositories()` selects no `approved` column and returns both available and unavailable history.

- [ ] **Step 3: Run focused database tests and confirm failure**

Run:

```bash
bun test packages/db/src/onboarding.test.ts packages/db/src/dashboard.test.ts
```

Expected: old `resources` transition and `approved` SQL expectations fail.

- [ ] **Step 4: Implement state derivation and repository normalization**

In `getOnboardingStatus()`:

```ts
if (!workerId || admission !== "adopted" || configuration !== "ready") step = "worker";
else if (!organizationId || !githubReady) step = "github";
else step = "labels";
```

The `githubReady` subquery must require `i.state='approved'`, a valid installation repository selection, and `r.available=true`; no repository approval predicate.

Delete `approveOnboardingRepositories()`. Remove `approved` from onboarding repository SQL/mapping and from `listRepositories()`.

- [ ] **Step 5: Re-run focused database tests**

Run:

```bash
bun test packages/db/src/onboarding.test.ts packages/db/src/dashboard.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit and push**

```bash
git add packages/db/src/onboarding.ts packages/db/src/onboarding.test.ts packages/db/src/dashboard.ts packages/db/src/dashboard.test.ts packages/db/src/index.ts
git commit -m "fix: gate onboarding on ready infrastructure"
git push origin main
```

---

## Task 3: Make GitHub reconciliation authoritative for repository availability

**Files:**
- Modify: `apps/control-plane/src/github-app.ts`
- Modify: `apps/control-plane/src/github-app.test.ts`

**Behavior:**
- Installation and repository webhooks, explicit refreshes, and installation completion upsert every repository with `available=true`, regardless of visibility.
- Removal, uninstall, deletion, and absence from a full snapshot set `available=false` but do not delete rows.
- Re-adding a repository updates the existing row to `available=true` and preserves its history relationships.
- Installation state remains `approved` when it represents an active verified installation with at least one available repository.

- [ ] **Step 1: Update fake persistence types and write failing lifecycle tests**

Remove `approved` from the fake `Repository` type and all test fixtures. Add or update tests proving:

1. installation completion records private, internal, and public repositories as available;
2. `repositories_removed` marks only the named repository unavailable;
3. a full `repositories` snapshot marks omitted rows unavailable;
4. uninstall/deletion marks all installation repositories unavailable;
5. a later `repositories_added` event restores the same row to available;
6. an active installation with at least one available repository is `approved`.

- [ ] **Step 2: Run GitHub App tests and confirm failure**

Run:

```bash
bun test apps/control-plane/src/github-app.test.ts
```

Expected: SQL and fake-store expectations still reference `approved`.

- [ ] **Step 3: Remove the approval mirror from reconciliation**

Update `persistInstallation()` and `reconcileInstallationRepositories()` to insert/update only `available`, visibility, names, and installation ownership. Full snapshots and removal events change only `available`; upserts always restore `available=true`. Keep installation state semantics separate from repository availability.

Delete all visibility-based approval defaults. Do not filter public repositories.

- [ ] **Step 4: Re-run GitHub App tests**

Run:

```bash
bun test apps/control-plane/src/github-app.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit and push**

```bash
git add apps/control-plane/src/github-app.ts apps/control-plane/src/github-app.test.ts
git commit -m "refactor: mirror GitHub repository access"
git push origin main
```

---

## Task 4: Disable repositories when GitHub reports them missing

**Files:**
- Modify: `apps/control-plane/src/github-app.ts`
- Modify: `apps/control-plane/src/github-app.test.ts`
- Modify: `apps/control-plane/src/job-discovery.ts`
- Modify: `apps/control-plane/src/job-discovery.test.ts`
- Modify: `apps/control-plane/src/index.ts` and any discovered callsites for the discovery function rename
- Modify: `apps/control-plane/src/job-reconciler.ts`
- Modify: `apps/control-plane/src/runs.ts`
- Modify: `apps/control-plane/src/runs.test.ts`
- Modify: `tests/job-pickup.e2e.test.ts`
- Modify: `tests/live-job-pickup-smoke.ts`

**Interfaces:**
- Rename `discoverApprovedRepositoryJobs` to `discoverAvailableRepositoryJobs`; migrate every caller without an alias.
- Repository-specific setup operations return the stable domain error `github_repository_unavailable` after GitHub returns 404.
- 403, 429, and 5xx errors remain operational failures and must not change `available`.

- [ ] **Step 1: Write failing discovery lifecycle tests**

Expand `apps/control-plane/src/job-discovery.test.ts` with a small tagged-template fake DB and injected fetcher. Prove:

1. discovery SQL requires `repo.available=true` and `i.state='approved'`, with no approval predicate;
2. GitHub 404 updates only the selected `repository_id` to `available=false` and does not continue that repository;
3. GitHub 403, 429, and 500 increment/report failure but issue no availability update.

Treat 404 as an authorization lifecycle transition rather than a retryable discovery failure.

Also remove the repository approval predicate from webhook ingestion and queued-job reconciliation. Their authorization boundary is the same `repo.available=true` plus `i.state='approved'` pair. Update `runs.test.ts`, the end-to-end fixture insert, and the live smoke repository lookup/error naming accordingly.

- [ ] **Step 2: Write failing repository-operation tests**

In `github-app.test.ts`, cover list/preview/PR setup paths. A GitHub 404 must persist `available=false` for that organization/repository and throw `github_repository_unavailable`. A 403/429/500 must preserve availability and the original operational error.

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```bash
bun test apps/control-plane/src/job-discovery.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/runs.test.ts tests/live-job-pickup-smoke.test.ts
```

Expected: old approval query and raw `github_404` handling fail.

- [ ] **Step 4: Implement shared missing-repository handling**

Add one private GitHub App service path that marks a repository unavailable by both `organizationId` and `repositoryId`; use it around all repository-specific workflow listing/preview/PR GitHub calls. Expose a repository-ID-based workflow listing method so HTTP routes do not duplicate the transition logic.

In discovery, catch only `Error("github_404")`, update the current durable row, and stop processing it. Do not catch-and-convert other statuses.

Use LSP rename for `discoverApprovedRepositoryJobs` if the server is available; otherwise locate and update every import/callsite before deleting the old name.

- [ ] **Step 5: Re-run focused tests**

Run:

```bash
bun test apps/control-plane/src/job-discovery.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/runs.test.ts tests/live-job-pickup-smoke.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit and push**

```bash
git add apps/control-plane/src/github-app.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/job-discovery.ts apps/control-plane/src/job-discovery.test.ts apps/control-plane/src/job-reconciler.ts apps/control-plane/src/runs.ts apps/control-plane/src/runs.test.ts apps/control-plane/src/index.ts tests/job-pickup.e2e.test.ts tests/live-job-pickup-smoke.ts
git commit -m "fix: retire repositories after GitHub 404"
git push origin main
```

---

## Task 5: Remove repository approval HTTP and client APIs

**Files:**
- Modify: `apps/control-plane/src/http/onboarding-routes.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/http/app.test.ts`
- Modify: `apps/control-plane/src/dashboard-api.test.ts`
- Modify: `apps/web/src/api.ts`
- Modify: any route registration fixtures/types that fail after deleting the API

**Behavior:**
- Delete `POST /api/onboarding/repositories`.
- Delete `POST /api/organizations/:organizationId/repositories/:repositoryId/:action` approval/rejection routing.
- Repository workflow endpoints require an available repository on an approved active installation.
- A live GitHub 404 returns an explicit repository-unavailable response after persisting the transition; use HTTP 409 with code `repository_unavailable`.

- [ ] **Step 1: Write failing HTTP tests**

Update HTTP/dashboard tests to prove:

1. removed approval endpoints return 404;
2. workflow list, preview, and PR operations reject unavailable repositories;
3. active available repositories no longer require approval;
4. `github_repository_unavailable` maps to HTTP 409 `repository_unavailable`;
5. 403/429/5xx from GitHub remain server/operational errors, not repository-unavailable responses.

- [ ] **Step 2: Run focused HTTP tests and confirm failure**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/dashboard-api.test.ts
```

Expected: old approval endpoints or predicates remain.

- [ ] **Step 3: Remove server and browser client mutations**

Delete imports and routes for approval. Change workflow authorization queries/services to require `available=true` plus installation `state='approved'`. Replace misleading `repository_not_approved` error names/copy with unavailable/access terminology.

Delete from `apps/web/src/api.ts`:

```ts
approveOnboardingRepositories
setRepositoryApproval
```

Do not leave compatibility exports.

- [ ] **Step 4: Re-run focused HTTP tests**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/dashboard-api.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit and push**

```bash
git add apps/control-plane/src/http/onboarding-routes.ts apps/control-plane/src/http/dashboard-routes.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/dashboard-api.test.ts apps/web/src/api.ts
git commit -m "refactor: remove repository approval APIs"
git push origin main
```

---

## Task 6: Collapse onboarding to four server-enforced steps

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: `apps/web/src/routes/OnboardingPage.test.tsx`
- Modify: `apps/web/src/components/WorkerConfigurationForm.tsx` only for a focused class/label needed by the moved form
- Modify: `apps/web/src/styles.css`

**UI behavior:**
- Progress is Admin → Worker → GitHub → Trigger labels.
- Worker initially shows enrollment and explicit worker selection.
- After selection, Worker replaces the chooser with `WorkerConfigurationForm` populated from `detail.worker`.
- The page stays on Worker while approval/configuration is pending and polls until the server reports `adopted` + `ready`.
- GitHub only connects the App; no repository picker, select-all, approval controls, or repository-selection remediation remains.
- Any active installation with at least one available repository advances through server polling.

- [ ] **Step 1: Write failing static and interactive UI tests**

Update `OnboardingPage.test.tsx` to assert:

1. exactly four step labels and no Resources step;
2. a selected pending/unconfigured worker renders `WorkerConfigurationForm` in Worker;
3. worker configuration completion refreshes but cannot locally advance the step;
4. a ready adopted worker can render GitHub;
5. GitHub renders installation/connect controls only—no repository checkboxes, select-all, `Approve repositories`, or repository-selection remediation;
6. review/complete copy reports GitHub access/available repository count, not approvals.

- [ ] **Step 2: Run the UI test and confirm failure**

Run:

```bash
bun test apps/web/src/routes/OnboardingPage.test.tsx
```

Expected: old five-step and picker assertions fail.

- [ ] **Step 3: Implement the four-step UI**

Remove approval mutation/state and `ResourceStep`. Make `WorkerStep` accept the selected onboarding worker and refresh callback. If no worker is selected, render enrollment/choices; otherwise render the selected identity plus `WorkerConfigurationForm`, or a waiting status when configuration is already acknowledged.

Keep server polling enabled while `step === "worker"`. The UI must never infer forward progress from mutation success.

Simplify `GithubStep` to account selection, manifest/App installation, and connection status. Remove all per-repository local state and checkboxes.

- [ ] **Step 4: Scope compact checkbox styling**

Add a focused native-size rule for the remaining guest-platform checkbox, for example:

```css
.worker-configuration-form .checkbox-field input[type="checkbox"] {
  inline-size: 16px;
  block-size: 16px;
  min-block-size: 0;
  padding: 0;
}
```

Keep the label clickable and do not change text, number, or select input sizing.

- [ ] **Step 5: Re-run onboarding UI tests**

Run:

```bash
bun test apps/web/src/routes/OnboardingPage.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit and push**

```bash
git add apps/web/src/routes/OnboardingPage.tsx apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/components/WorkerConfigurationForm.tsx apps/web/src/styles.css
git commit -m "fix: require worker approval during onboarding"
git push origin main
```

---

## Task 7: Make the repository dashboard reflect GitHub access directly

**Files:**
- Modify: `apps/web/src/routes/RepositoriesPage.tsx`
- Create: `apps/web/src/routes/RepositoriesPage.test.tsx`
- Modify: `apps/web/src/styles.css` only if an existing status style cannot express unavailable detail

**UI behavior:**
- Remove the Mars approval column and Approve/Remove controls.
- Available repositories can open `Use Mars runners` regardless of visibility.
- Unavailable history remains readable, displays that GitHub no longer grants access, and disables setup/management actions.
- Keep Available/Unavailable filtering and explicit GitHub connection management.

- [ ] **Step 1: Add behavior-level repository page coverage**

Follow the existing route-test convention. Render one available public repository and one unavailable historical repository. Assert no approval language/buttons, the public available row enables runner setup, and the unavailable row includes explanatory copy with disabled actions.

Create a focused route test using the same `renderToStaticMarkup`/QueryClient pattern as `OnboardingPage.test.tsx`; test rendered behavior rather than source strings.

- [ ] **Step 2: Run the focused web test and confirm failure**

Run:

```bash
bun test apps/web/src/routes/RepositoriesPage.test.tsx
```

Expected: old approval column/actions remain.

- [ ] **Step 3: Simplify the repository table**

Remove approval mutation imports/state and error aggregation. Change page/caption copy from Mars-selected access to GitHub-granted access. Keep repository, visibility, GitHub access, and actions columns. In the access cell, show `Available` or `Unavailable` and explain unavailable rows with “GitHub no longer grants access.”

Enable `Use Mars runners` exactly when `repository.available`; keep unavailable actions disabled.

- [ ] **Step 4: Re-run the focused web test**

Run the exact test command from Step 2.

Expected: pass.

- [ ] **Step 5: Commit and push**

```bash
git add apps/web/src/routes/RepositoriesPage.tsx apps/web/src/routes/RepositoriesPage.test.tsx apps/web/src/styles.css
git commit -m "refactor: show repository GitHub access"
git push origin main
```

---

## Task 8: Verify the complete policy cutover

**Files:**
- Modify only tests or production files required to fix defects exposed by the checks; do not weaken assertions.

- [ ] **Step 1: Search for stale approval and Resources-step callsites**

Use repository search tools, not shell grep. There must be no runtime references to:

```text
ApproveOnboardingRepositoriesRequest
approveOnboardingRepositories
setRepositoryApproval
repository.approved
r.approved
repo.approved
ResourcesStep / ResourceStep
"resources" as an OnboardingStep
```

Historical prose in the approved design/plan may remain.

- [ ] **Step 2: Run focused regression suites**

```bash
bun test tests/dashboard-contracts.test.ts packages/db/src/schema.test.ts packages/db/src/onboarding.test.ts packages/db/src/dashboard.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/job-discovery.test.ts apps/control-plane/src/runs.test.ts tests/live-job-pickup-smoke.test.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/dashboard-api.test.ts apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/routes/RepositoriesPage.test.tsx
```

Expected: all pass.

- [ ] **Step 3: Run workspace typechecks**

```bash
bun run --filter @mars/contracts typecheck
bun run --filter @mars/db typecheck
bun run --filter @mars/control-plane typecheck
bun run --filter @mars/web typecheck
```

Expected: all exit 0.

- [ ] **Step 4: Run the complete repository test suite**

```bash
bun test
```

Expected: pass, except any pre-existing Windows-incompatible shell smoke tests must be reported verbatim and shown unrelated by the focused suites; do not claim a clean full suite if they fail.

- [ ] **Step 5: Verify actual onboarding surfaces in Chromium**

Start the development stack using the repository command. Exercise authenticated onboarding data for:

1. selected pending/unconfigured worker at 1440px and a mobile width;
2. selected ready worker on GitHub;
3. repository dashboard Available and Unavailable filters.

Confirm visually and through the accessibility tree:

- four progress steps;
- inline worker configuration;
- compact 16px guest-platform checkbox with a clickable label;
- no Resources step or repository approval controls;
- unavailable history explanation and disabled actions;
- no new console errors.

- [ ] **Step 6: Run final diff hygiene**

```bash
git diff --check
```

Expected: exit 0.

- [ ] **Step 7: Commit fixes, push, and confirm clean state**

```bash
git add <only-files-changed-during-verification>
git commit -m "test: cover automatic repository access"
git push origin main
git status --short
```

Skip the commit if verification required no edits. Expected: `git status --short` prints no output and `origin/main` contains every task commit.
