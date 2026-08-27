# Editable Onboarding Back Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators reopen completed onboarding steps as editable, prefilled forms without clearing later selections.

**Architecture:** Keep the server-derived onboarding step unchanged. Add local edit-step state in `OnboardingPage`; completed progress buttons open a labelled dialog containing the real worker, GitHub, or pool form. Existing APIs remain the persistence boundary, with the onboarding pool route extended to update the existing pool when an edit identifies it.

**Tech Stack:** Bun 1.2, TypeScript, React, TanStack Query, Hono, Zod, Bun tests.

## Global Constraints

- Later selections remain unchanged when an earlier step is edited.
- Cancel and validation failure must not mutate persisted onboarding state.
- Existing server APIs and forms remain the source of truth; do not duplicate validation rules in the UI.
- Completed steps must be keyboard-accessible buttons and edit surfaces must support cancel/Escape.
- Never create a duplicate onboarding pool while editing an existing one.

---

### Task 1: Add editable completed-step shell

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Test: `apps/web/src/routes/OnboardingPage.test.tsx`

**Interfaces:**
- Produces local `editingStep: "worker" | "github" | "labels" | null` state and a labelled edit dialog.
- Consumes existing `OnboardingDetail`, `ReviewSummary`, `WorkerSetupStep`, `GithubStep`, and `LabelsStep` components.

- [ ] **Step 1: Write failing component tests**

Add tests that render a completed-step state and assert the progress item is a real button, clicking/opening the worker edit state renders an editable heading and current worker value, and cancelling returns to the current-step content without invoking a mutation.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx`
Expected: FAIL because completed steps currently set only `reviewIndex` and render read-only `ReviewSummary`.

- [ ] **Step 3: Implement the edit shell**

Replace the completed-step click path with `editingStep` state. Render a `<dialog open>` or equivalent labelled region containing the selected real step form, a cancel button, and an Escape handler. Keep `d.step` unchanged. Make the completed progress control a `<button>` with `aria-label`/visible step text and return focus to it after close.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx && bun run --filter @mars/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/OnboardingPage.tsx apps/web/src/routes/OnboardingPage.test.tsx
git commit -m "feat: open completed onboarding steps for editing"
```

### Task 2: Make worker edit form prefilled and reusable

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: `apps/web/src/components/PendingWorkerRequests.tsx`
- Modify: `apps/web/src/api.ts`
- Test: `apps/web/src/routes/OnboardingPage.test.tsx`
- Test: `apps/web/src/components/PendingWorkerRequests.test.tsx`

**Interfaces:**
- Consumes `editingStep` shell from Task 1.
- Produces a worker edit view that accepts the selected worker and initializes resource inputs from persisted limits/capacity.

- [ ] **Step 1: Add failing prefill tests**

Assert that opening Worker edit renders the persisted worker identity and current resource ceilings, and that saving invokes the existing configuration mutation rather than worker selection unless the worker is explicitly changed.

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx`
Expected: FAIL because `ResourceStep` currently replaces a ready worker with a status message and the configuration form is only mounted for unconfigured workers.

- [ ] **Step 3: Implement reusable worker editing**

Allow `WorkerConfigurationForm` to render for an already configured worker in edit mode with existing limits as initial values. Keep the pending worker selector available for changing the selected worker; call `selectOnboardingWorker` only when the selected ID changes. Invalidate onboarding and pending-worker queries after success and close the edit shell.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx && bun run --filter @mars/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/OnboardingPage.tsx apps/web/src/components/PendingWorkerRequests.tsx apps/web/src/api.ts apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx
git commit -m "feat: edit onboarding worker configuration"
```

### Task 3: Make GitHub and pool steps editable without destructive resets

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Test: `apps/web/src/routes/OnboardingPage.test.tsx`
- Test: `apps/control-plane/src/http/app.test.ts`

**Interfaces:**
- Consumes `editingStep` shell and query invalidation from Tasks 1–2.
- Produces an optional existing onboarding pool identifier in the pool mutation contract; the server updates that pool on edit and otherwise preserves create behavior.

- [ ] **Step 1: Add failing GitHub/pool edit tests**

Assert that GitHub edit starts with `detail.github.organizationId`, that the labels form starts with `detail.pool.name`/`detail.pool.triggerLabel` when present, and that submitting an edit targets the existing pool instead of creating a second pool. Assert later GitHub/pool summary values remain present after closing the edit view.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx apps/control-plane/src/http/app.test.ts`
Expected: FAIL because GitHub state is initialized empty/current installation hides the selector, labels defaults are hardcoded, and the pool endpoint has no explicit edit identifier.

- [ ] **Step 3: Implement GitHub editing**

Add an edit mode to `GithubStep` that always shows the organization selector with `detail.github.organizationId` selected and reuses the existing install/manifest action. Do not revoke or clear the existing installation when cancelling or changing the selection; surface server errors in place.

- [ ] **Step 4: Implement pool update contract and form prefill**

Extend the pool request with optional `poolId`. Initialize labels fields from `detail.pool` when editing. In the server route, validate `poolId` belongs to the onboarding/global pool and update its worker, platform, driver, image, resources, labels, and trigger label; reject missing or foreign IDs with the existing structured error response. Keep the current duplicate-name/trigger-label behavior for new pools.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx apps/control-plane/src/http/app.test.ts && bun run --filter @mars/web typecheck && bun run --filter @mars/control-plane typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/OnboardingPage.tsx apps/web/src/api.ts apps/control-plane/src/http/dashboard-routes.ts packages/contracts/src/orchestration.ts apps/web/src/routes/OnboardingPage.test.tsx apps/control-plane/src/http/app.test.ts
git commit -m "feat: edit onboarding integrations and pool"
```

### Task 4: Verify the complete reversible onboarding flow

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.test.tsx`
- Modify: `apps/control-plane/src/http/app.test.ts` (only if an uncovered contract boundary remains)

- [ ] **Step 1: Run focused behavioral tests**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx apps/control-plane/src/http/app.test.ts apps/control-plane/src/http/onboarding.test.ts`
Expected: PASS.

- [ ] **Step 2: Run web and control-plane typechecks**

Run: `bun run --filter @mars/web typecheck && bun run --filter @mars/control-plane typecheck`
Expected: PASS.

- [ ] **Step 3: Exercise the onboarding UI**

Open the local onboarding page in the browser. Verify a completed Worker/GitHub/Trigger labels step can be opened, existing values are visible, Cancel leaves the current step and summaries unchanged, and Save returns to the current step with later values preserved.

- [ ] **Step 4: Commit verification-only test changes if needed**

```bash
git add apps/web/src/routes/OnboardingPage.test.tsx apps/control-plane/src/http/app.test.ts
git commit -m "test: verify reversible onboarding setup"
```
