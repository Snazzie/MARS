# Mars Sign-in and Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare first-run onboarding markup with a focused GitHub sign-in screen and a server-gated, reviewable two-column setup wizard.

**Architecture:** Keep `OnboardingPage` as the server-state coordinator and preserve all existing API/mutation contracts. Extract presentational sign-in, step rail, and task-card concerns into focused components only where this reduces complexity; use CSS classes scoped to onboarding so the existing dashboard remains unchanged. Completed-step review is local UI state and read-only; the server-derived `detail.step` remains the only source of mutation authority.

**Tech Stack:** React 19, TanStack Query, TanStack Router, TypeScript, existing Mars CSS tokens, Bun test.

## Global Constraints

- Use the existing dark console tokens, IBM Plex Sans/Mono, DM Serif Display, acid primary, rust error, and visible focus outlines.
- Do not alter onboarding API contracts or server step derivation.
- Do not fetch onboarding detail until public status says authenticated global administrator.
- Only the current server-derived step may mutate; completed steps are review-only and future steps are locked.
- Poll pending workers and configuration acknowledgement only while the relevant step is active.
- Never render secret material or setup detail to unauthenticated/non-admin users.
- Preserve refresh/resume behavior and existing route-gate semantics.

---

### Task 1: Add failing sign-in and wizard rendering tests

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.test.tsx`
- Test helpers: existing `markup()` and fixture data in the same file

**Interfaces:**
- Consumes: `OnboardingPage` and existing mocked TanStack Query client data.
- Produces: assertions covering sign-in copy, wizard rail semantics, review mode, and completion content.

- [ ] **Step 1: Add sign-in assertions**

Add tests that render unauthenticated status fixtures and assert:

```ts
expect(html).toContain("Create your administrator account");
expect(html).toContain("Continue with GitHub");
expect(html).toContain('/api/auth/github');
expect(html).toContain("GitHub supplies identity");
```

Add a returning-admin fixture asserting `Sign in to Mars` rather than the create-admin heading.

- [ ] **Step 2: Add non-admin privacy assertion**

Render `authenticated: true, canManage: false` and assert the output contains `Administrator access required` while not containing worker, organization, repository, or pool fixture values.

- [ ] **Step 3: Add wizard rail assertions**

Render an authenticated `step: "resources"` fixture and assert the five labels, current resources marker, completed markers for Admin/Worker/GitHub, locked marker for Trigger labels, and `Saved automatically` or the relevant wait status.

- [ ] **Step 4: Add review-mode assertion**

Set the local review step through the test harness after implementation support is added, or expose the selected completed step through the component fixture. Assert a completed step renders its summary and does not render its mutation button/form.

- [ ] **Step 5: Run the focused test and confirm failure**

Run:

```bash
bun test apps/web/src/routes/OnboardingPage.test.tsx
```

Expected: FAIL on the new copy/structure assertions before implementation.

---

### Task 2: Implement focused sign-in and wizard components

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Create if needed: `apps/web/src/components/OnboardingSignIn.tsx`
- Create if needed: `apps/web/src/components/OnboardingStepRail.tsx`
- Create if needed: `apps/web/src/components/OnboardingTaskCard.tsx`

**Interfaces:**
- Consumes: `OnboardingStatus`, `OnboardingDetail`, existing API functions and mutation callbacks.
- Produces: presentational components with explicit props; no new server endpoints.

- [ ] **Step 1: Implement `OnboardingSignIn`**

Use props:

```ts
type OnboardingSignInProps = {
  adminCreated: boolean;
  error?: string | null;
  onRetry?: () => void;
};
```

Render a centered card with:

- `Create your administrator account` or `Sign in to Mars`;
- explanatory GitHub identity copy;
- `Continue with GitHub` link to `/api/auth/github`;
- security note;
- `role="alert"` for errors and a retry button when supplied.

- [ ] **Step 2: Implement `OnboardingStepRail`**

Use props:

```ts
type OnboardingStepRailProps = {
  current: OnboardingStep;
  reviewStep: OnboardingStep | null;
  onReview(step: OnboardingStep): void;
};
```

Render an ordered list with stable classes `is-current`, `is-complete`, and `is-locked`. Completed steps are buttons or links invoking `onReview`; current/future steps are non-mutating indicators. Include `Saved automatically` and a contextual wait label.

- [ ] **Step 3: Implement task-card shell**

Use props:

```ts
type OnboardingTaskCardProps = {
  stepNumber: number;
  title: string;
  description: string;
  children: React.ReactNode;
  review: boolean;
};
```

Render semantic heading structure, review badge, and `aria-live="polite"` content region.

- [ ] **Step 4: Refactor `OnboardingPage` composition**

Preserve existing query keys, mutation handlers, polling conditions, and server-derived `current`. Replace inline unauthenticated markup with `OnboardingSignIn`. For authenticated admins, render the rail plus task card. Keep each existing step component’s mutation callback unchanged.

Use local `reviewStep` state only when its selected step is earlier than the server current step. Render completed summaries read-only; if the user closes review, return to the current task. Do not expose mutation controls while `reviewStep` is active.

- [ ] **Step 5: Make step content copy and states explicit**

Ensure the resources task always includes `Configure resources`; labels includes the immutable digest/remediation and effective labels; completion includes organization, approved count, worker, pool, labels, and `runs-on` example.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
bun test apps/web/src/routes/OnboardingPage.test.tsx
bun run typecheck
```

Expected: new UI tests and all workspace typechecks pass.

---

### Task 3: Add scoped responsive onboarding styling

**Files:**
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: classes emitted by `OnboardingSignIn`, `OnboardingStepRail`, `OnboardingTaskCard`, and `OnboardingPage`.
- Produces: desktop two-column wizard and mobile horizontal progress presentation without changing dashboard classes.

- [ ] **Step 1: Add sign-in styles**

Add `.onboarding-auth`, `.onboarding-auth-card`, `.onboarding-auth-mark`, `.onboarding-security-note`, and related form/error classes using existing variables. Keep the primary GitHub link visually consistent with `.button`.

- [ ] **Step 2: Add wizard layout styles**

Add `.onboarding-shell`, `.onboarding-rail`, `.onboarding-main`, `.onboarding-task-card`, `.onboarding-step-list`, `.onboarding-step`, and state modifiers. Use a two-column grid with a maximum readable width, distinct current state, and review state.

- [ ] **Step 3: Add responsive and accessibility states**

Below 800px collapse to a horizontal scrollable step strip and a single task column. Preserve keyboard focus outlines, readable contrast, and no motion dependency. Add reduced-motion-safe transitions only if used.

- [ ] **Step 4: Build the web bundle**

Run:

```bash
bun run --filter '@mars/web' build
```

Expected: browser bundle builds without CSS or JSX errors.

---

### Task 4: Expand focused UI coverage

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.test.tsx`
- Modify if needed: `apps/web/src/components/PendingWorkerRequests.test.tsx`
- Modify if needed: `apps/web/src/components/EnrollmentWizard.test.ts`

**Interfaces:**
- Consumes: implemented UI components and existing fixture contracts.
- Produces: regression protection for observable onboarding behavior.

- [ ] **Step 1: Cover worker step**

Assert pending worker identity, platform, capacity, and explicit `Use this worker` action are visible; assert empty state explains that the administrator must install/start a worker.

- [ ] **Step 2: Cover resource acknowledgement state**

Assert the resource form is rendered before acknowledgement and `Configuring worker` plus waiting status is rendered after submission/configuration state changes.

- [ ] **Step 3: Cover labels and completion**

Assert missing image digest blocks pool creation with exact remediation. Assert configured labels render a copyable `runs-on` snippet and completion renders `Open dashboard`.

- [ ] **Step 4: Run focused UI tests**

Run:

```bash
bun test apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx apps/web/src/components/EnrollmentWizard.test.ts
```

Expected: all focused UI tests pass.

---

### Task 5: Verify the running local flow

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: running local control plane at `http://localhost:3000`.
- Produces: verified sign-in and wizard presentation evidence.

- [ ] **Step 1: Run complete automated verification**

Run:

```bash
bun run typecheck
bun test
bun run build
```

Expected: zero type errors, zero test failures, and successful workspace builds.

- [ ] **Step 2: Open the local onboarding route**

Navigate to `http://localhost:3000/onboarding`. Verify the centered sign-in card, GitHub action, explanatory/security copy, keyboard focus, and no setup detail leakage while unauthenticated.

- [ ] **Step 3: Verify authenticated wizard states**

Using the configured local GitHub OAuth flow, verify the two-column rail, current/completed/locked semantics, review-only completed steps, worker polling status, resource acknowledgement status, labels preview, and completion summary. Refresh between transitions to prove server-derived resume behavior.

- [ ] **Step 4: Record any browser-only defect and fix at source**

If a browser assertion fails, update the smallest responsible component/style/test, rerun the focused test, then rerun the complete verification commands.
