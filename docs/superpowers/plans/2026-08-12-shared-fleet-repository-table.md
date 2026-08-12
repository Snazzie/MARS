# Shared Fleet and Repository Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert worker/pool ownership and scheduling to control-plane-wide shared scope, then redesign `/repositories` as a clean GitHub access table.

**Architecture:** Workers and pools retain nullable legacy `organization_id` columns for migration/audit compatibility, but shared resources use `NULL` and no authorization or scheduling path filters them by organization. Repository and GitHub access remains organization-scoped. The dashboard gets a shared fleet surface and the repository page becomes a dense table with no runner ownership semantics.

**Tech Stack:** Bun, TypeScript, PostgreSQL, Hono, Zod, React 19, TanStack Query, Bun test, browser smoke testing.

## Global Constraints

- Workers enroll once to the control plane, not to an organization or repository.
- Runner pools are shared across every connected organization and approved repository.
- Repository approval remains organization/GitHub access state; it does not own runner capacity.
- New shared workers and pools write `organization_id = NULL`; old values are cleared only by the migration after audit capture.
- No parallel organization-scoped and account-scoped scheduling paths.
- Pool names and trigger labels are unique among enabled shared pools; conflicting migrated pools remain disabled and are surfaced.
- All mutations continue to require `Idempotency-Key`.
- Preserve existing strict Zod DTOs and secret-safety guarantees.

---

### Task 1: Define shared fleet contracts and migration

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/contracts/src/index.ts` if exports require adjustment
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/shared-fleet.ts`
- Test: `packages/db/src/dashboard.test.ts`
- Test: `packages/db/src/shared-fleet.test.ts`

**Interfaces:**
- `PoolSummary` no longer includes `organizationId`.
- `WorkerDetail.organizationId` remains nullable only as legacy metadata and is not a scope contract.
- Export `SharedFleetConflict = { poolId:string; name:string; triggerLabel:string|null; reason:"duplicate_name"|"duplicate_trigger_label" }`.
- Export `listSharedFleetConflicts(db): Promise<SharedFleetConflict[]>`.

- [ ] **Step 1: Add failing contract and migration tests.** Assert `PoolSummary.parse` rejects `organizationId`, shared pool rows normalize without it, and duplicate enabled shared names/triggers are reported while disabled conflicts remain allowed.
- [ ] **Step 2: Run focused tests and confirm failure.** Run `bun test packages/db/src/shared-fleet.test.ts packages/db/src/dashboard.test.ts`; expect missing shared-fleet behavior or old DTO mismatch.
- [ ] **Step 3: Implement schema migration.** Make `workers.organization_id` and `runner_pools.organization_id` nullable, capture old ownership in `audit_events` payloads, clear ownership, disable duplicate shared pools deterministically, and add partial unique indexes for enabled shared pool names and non-null trigger labels.
- [ ] **Step 4: Implement shared-fleet conflict query.** Query only `organization_id IS NULL` pools and return stable conflict records for disabled duplicate rows.
- [ ] **Step 5: Run focused tests.** Run the two test files; expect pass.

### Task 2: Make worker enrollment and configuration control-plane scoped

**Files:**
- Modify: `apps/control-plane/src/workers.ts`
- Modify: `apps/control-plane/src/worker-requests.ts`
- Modify: `apps/control-plane/src/http/worker-routes.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `packages/db/src/dashboard.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/routes/WorkersPage.tsx`
- Test: `apps/control-plane/src/worker-bootstrap.test.ts`
- Test: `apps/control-plane/src/worker-requests.test.ts`
- Test: `apps/control-plane/src/worker-requests.persistence.test.ts`

**Interfaces:**
- Shared worker reads use `listAllWorkers(db,userId,limit)` without organization filtering.
- Worker configure/adopt/reject/drain/remove validates global-admin access and worker ID only; organization path parameters are removed from new fleet routes.
- `configurePendingWorker` accepts the worker ID and resource request without binding an organization.

- [ ] **Step 1: Add failing tests.** Cover enrollment with no organization, global worker listing across organizations, configuration with no organization, and denial of non-global-admin fleet mutations.
- [ ] **Step 2: Run focused worker tests and confirm failure.** Run the four worker test files; expect current organization requirement failures.
- [ ] **Step 3: Remove organization writes from enrollment/configuration.** New worker rows use `organization_id = NULL`; configuration and acknowledgement update by worker ID and preserve exact revision checks.
- [ ] **Step 4: Add account-scoped worker routes and update API/UI callers.** Use `/api/workers`, `/api/workers/:workerId/:action`, and `/api/workers/pending/:workerId/configure`; retain repository organization guards elsewhere.
- [ ] **Step 5: Run focused worker tests.** Expect all worker tests to pass.

### Task 3: Make pools, leases, and scheduler shared

**Files:**
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `packages/db/src/dashboard.ts`
- Modify: `apps/control-plane/src/scheduler.ts`
- Modify: `apps/control-plane/src/runs.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/routes/PoolsPage.tsx`
- Test: `apps/control-plane/src/scheduler.test.ts`
- Test: `apps/control-plane/src/runs.test.ts`
- Test: `packages/db/src/dashboard.test.ts`

**Interfaces:**
- `listAllPools(db,userId,limit)` returns shared pools without `organizationId`.
- Create pool input remains `{workerId,name,resources,triggerLabel,imageDigest}` and writes `organization_id = NULL`.
- Pool mutation routes use `/api/pools/:poolId/:action` and require global-admin authorization.
- Scheduler candidate lookup joins `runner_pools` to `workers` by `worker_id` only and never filters by repository organization.

- [ ] **Step 1: Add failing scheduler/database tests.** Prove a repository in organization A can claim a matching shared pool enrolled/configured independently, and a nonmatching label remains queued.
- [ ] **Step 2: Run focused tests and confirm failure.** Run scheduler, runs, and dashboard tests; expect organization mismatch or DTO failures.
- [ ] **Step 3: Implement shared pool queries and routes.** Remove organization predicates, write null ownership, validate worker readiness globally, and use shared conflict indexes.
- [ ] **Step 4: Update lease persistence and webhook scheduling.** Keep run/repository organization IDs for tenant history, but create leases against shared pools without requiring a pool organization match.
- [ ] **Step 5: Update Pools UI/API.** Show worker/pool fleet data without organization selectors or organization-bound actions.
- [ ] **Step 6: Run focused scheduler/database tests.** Expect pass.

### Task 4: Update onboarding to avoid binding workers to organizations

**Files:**
- Modify: `packages/contracts/src/onboarding.ts`
- Modify: `packages/db/src/onboarding.ts`
- Modify: `apps/control-plane/src/onboarding.ts`
- Modify: `apps/control-plane/src/http/onboarding-routes.ts`
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: `apps/web/src/components/WorkerConfigurationForm.tsx`
- Modify: `local://onboarding-workflow-plan.md` is immutable; update repository plan documentation if mirrored under `docs/`
- Test: `packages/db/src/onboarding.test.ts`
- Test: `apps/control-plane/src/onboarding.test.ts`
- Test: `apps/web/src/routes/OnboardingPage.test.tsx`

**Interfaces:**
- Onboarding still selects one GitHub organization for access setup, but `workerId` selection and resource configuration are global.
- Completion requires a ready shared worker and enabled shared pool plus approved repository access; no worker/pool organization equality check.

- [ ] **Step 1: Add failing onboarding tests.** Use a worker with null organization ownership and a GitHub organization bound only to repository access; assert resources and pool creation advance correctly.
- [ ] **Step 2: Run onboarding tests and confirm failure.** Expect current organization binding assumptions.
- [ ] **Step 3: Remove worker/pool organization equality checks.** Keep organization membership only on GitHub/repository setup operations.
- [ ] **Step 4: Update wizard copy.** Say “shared control-plane fleet” and avoid “worker for this organization.”
- [ ] **Step 5: Run onboarding tests.** Expect pass.

### Task 5: Redesign repositories as a clean access table

**Files:**
- Modify: `apps/web/src/routes/RepositoriesPage.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/routes/RepositoriesPage.test.tsx` or create it if absent
- Modify: `apps/web/src/api.ts` only if shared-fleet links or response fields require it

**Interfaces:**
- Repository response remains `RepositorySummary` with `organizationId`, `fullName`, `visibility`, `available`, `approved`, and `installationId`.
- No repository DTO gains worker/pool ownership fields.

- [ ] **Step 1: Add failing UI tests.** Assert table headers for Repository, Visibility, Access, Approval, Actions; organization appears only as repository context; shared fleet context links to `/workers` and `/pools`; no runner-owner text appears.
- [ ] **Step 2: Run the page tests and confirm failure.** Run `bun test apps/web/src/routes/RepositoriesPage.test.tsx`; expect current card markup failure.
- [ ] **Step 3: Implement table markup.** Replace repository cards with semantic `<table>`, row status badges, compact GitHub organization context, action grouping, and responsive overflow wrapper.
- [ ] **Step 4: Add shared-fleet context panel.** Use existing design tokens and links; explain that approved repositories use shared control-plane runner capacity.
- [ ] **Step 5: Add table styling.** Keep dark console palette, reduce card decoration, use fixed header rhythm, dense row spacing, clear status color, visible focus states, and mobile horizontal scrolling.
- [ ] **Step 6: Run UI tests.** Expect pass.

### Task 6: Update dashboard API and repository regression coverage

**Files:**
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/dashboard-api.test.ts`
- Modify: `tests/dashboard-contracts.test.ts`
- Modify: `tests/dashboard-db.test.ts`
- Modify: `apps/web/src/components/RunTable.tsx` only if shared route links need consistency

- [ ] **Step 1: Add failing API tests.** Assert shared worker/pool routes do not require an organization, repository routes still enforce membership, and repository mutations remain idempotent.
- [ ] **Step 2: Implement route and DTO updates.** Preserve existing error shapes and cache invalidation behavior.
- [ ] **Step 3: Run dashboard/API tests.** Expect pass.

### Task 7: Verify end-to-end shared fleet and browser redesign

**Files:**
- No new production files.
- Modify tests only for failures discovered in this task.

- [ ] **Step 1: Run focused regression suite.**
  ```bash
  bun test packages/db/src/shared-fleet.test.ts packages/db/src/dashboard.test.ts apps/control-plane/src/worker-bootstrap.test.ts apps/control-plane/src/worker-requests.test.ts apps/control-plane/src/worker-requests.persistence.test.ts apps/control-plane/src/scheduler.test.ts apps/control-plane/src/runs.test.ts packages/db/src/onboarding.test.ts apps/control-plane/src/onboarding.test.ts apps/control-plane/src/dashboard-api.test.ts apps/web/src/routes/RepositoriesPage.test.tsx apps/web/src/routes/OnboardingPage.test.tsx
  ```
- [ ] **Step 2: Run workspace checks.**
  ```bash
  bun run typecheck
  bun run lint
  bun test
  bun run build
  ```
- [ ] **Step 3: Run browser smoke test.** Open `http://localhost:3000/repositories` with an authenticated session, verify the semantic table, search/visibility filters, shared-fleet panel links, disabled unavailable actions, and zero browser console errors.
- [ ] **Step 4: Verify cross-tenant scheduling.** Seed two organizations and one shared ready pool; submit an approved repository job from each organization with matching labels; assert both can claim the shared pool while an unapproved repository remains queued.
- [ ] **Step 5: Record completion memory.** Store the shared ownership decision, migration behavior, and verification evidence in ICM.
