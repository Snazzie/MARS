# Mars UI Information Hierarchy Implementation Plan

> **For agentic workers:** Execute task-by-task with verification after each task.

**Goal:** Reduce Mars operator cognitive load while preserving the existing dark console visual identity, by restructuring actions, translating infrastructure values, separating health states, and replacing clipped mobile navigation.

**Architecture:** Keep existing TanStack Router routes, React Query contracts, and mutation behavior. Add presentational disclosure/menu primitives in the web app, use local form-unit conversion at the settings boundary, and derive scoped health copy from existing query/mutation states without API changes.

**Tech Stack:** React 19, TypeScript, TanStack Router, TanStack Query, existing CSS tokens/components, Bun.

## Global Constraints

- Do not change API/database contracts, route names, or business behavior.
- Preserve existing dark palette, typography, panel language, and status semantics.
- At widths below 800px, use a labeled mobile header/menu; no route text may clip at 390px.
- Keep `Connect workspace` as the single primary Repositories action.
- Use GiB for memory/storage inputs and convert to bytes only at submission.
- Keep advanced identifiers/digests discoverable but demoted.
- Do not rely on color alone for status.
- Maintain 44px minimum mobile touch targets.

---

### Task 1: Add reusable disclosure and scoped state primitives

**Files:**
- Create: `apps/web/src/components/Disclosure.tsx`
- Modify: `apps/web/src/components/StateView.tsx`
- Test: `apps/web/src/components/StateView.test.tsx` if existing conventions support it
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- `Disclosure({ label, children, defaultOpen?, tone? })` renders a native keyboard-accessible disclosure with a visible summary and `<details>/<summary>` semantics.
- Extend `QueryState` with optional `operationLabel?: string`; retry text becomes `Retry ${operationLabel}` when supplied, otherwise remains `Retry`.

- [ ] **Step 1: Inspect existing StateView markup and tests before editing.**
- [ ] **Step 2: Add the `Disclosure` component using native `<details>` and `<summary>`, preserving children and focus-visible behavior.**
- [ ] **Step 3: Add scoped retry copy to `QueryState` without changing query/mutation behavior.**
- [ ] **Step 4: Add styles for summary affordance, focus, spacing, and a destructive disclosure tone.**
- [ ] **Step 5: Run `bun test apps/web/src/components/StateView.test.tsx` if the file exists, then `bun run --filter '@mars/web' typecheck`.**

### Task 2: Replace clipped mobile rail with intentional navigation

**Files:**
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/components/AppShell.test.tsx` if existing test setup supports route rendering

**Interfaces:**
- Keep the existing `links` array and route targets unchanged.
- Add local `mobileMenuOpen` state and a labeled button with `aria-expanded`, `aria-controls`, and Escape-to-close behavior.

- [ ] **Step 1: Add a mobile header that shows brand, current route label, workspace selector, and menu button below 800px.**
- [ ] **Step 2: Render the existing six links in a mobile menu panel; close on route change and Escape.**
- [ ] **Step 3: Keep the desktop rail unchanged above 800px and prevent mobile nav clipping/overflow.**
- [ ] **Step 4: Add text status labels alongside the existing connection indicator; do not remove the compact footer indicator.**
- [ ] **Step 5: Run web typecheck and inspect the route shell at 390px and 1440px in a browser.**

### Task 3: Distill Repositories actions and filters

**Files:**
- Modify: `apps/web/src/routes/RepositoriesPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/routes/RepositoriesPage.test.tsx`

**Interfaces:**
- Preserve all existing mutations and query keys.
- Use `Disclosure` for the collapsed GitHub connection controls and advanced visibility filter.

- [ ] **Step 1: Add a test asserting Connect workspace remains the primary action and GitHub admin actions remain present under a labeled disclosure.**
- [ ] **Step 2: Move refresh, sync, and uninstall controls into one collapsed `GitHub connection` disclosure.**
- [ ] **Step 3: Keep search and availability in the primary filter bar; move visibility into a `More filters` disclosure at all widths.**
- [ ] **Step 4: Add explicit all-workspaces scope copy when organization-specific mutations are disabled.**
- [ ] **Step 5: Add responsive styles so the repository list/empty state dominates the controls visually.**
- [ ] **Step 6: Run `bun test apps/web/src/routes/RepositoriesPage.test.tsx` and web typecheck.**

### Task 4: Translate settings and pool technical values

**Files:**
- Modify: `apps/web/src/routes/SettingsPage.tsx`
- Modify: `apps/web/src/routes/PoolsPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/routes/SettingsPage.test.tsx`
- Test: `apps/web/src/routes/PoolsPage.test.tsx` if present

**Interfaces:**
- Add pure helpers in `SettingsPage.tsx`: `bytesToGiB(bytes: number): number` and `gibToBytes(gib: number): number`.
- Preserve `Values` API-facing byte fields; only displayed form state uses GiB.

- [ ] **Step 1: Add boundary tests for GiB conversion, including fractional display and integer byte submission.**
- [ ] **Step 2: Change settings form state to display memory/storage in GiB and convert to existing byte fields before `OrganizationSettings.safeParse`.**
- [ ] **Step 3: Add concise help text for vCPU, memory, storage, and concurrency.**
- [ ] **Step 4: Add `Advanced` disclosure for raw identifiers/digests/canonical labels where currently displayed in pool cards.**
- [ ] **Step 5: Make pool cards prioritize enabled state, readiness, capacity, and enable/disable action.**
- [ ] **Step 6: Run focused settings/pools tests and web typecheck.**

### Task 5: Improve onboarding and worker progressive disclosure

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: `apps/web/src/routes/WorkersPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: existing `OnboardingPage.test.tsx` and `WorkersPage.test.tsx`

**Interfaces:**
- Preserve existing onboarding state, API calls, and durable progress behavior.
- Add presentational step summary and disclosure wrappers only.

- [ ] **Step 1: Add a persistent five-step progress summary matching connect, worker, capacity, pool, and verification.**
- [ ] **Step 2: Keep the active onboarding step focused on one decision and demote raw IDs/digests/advanced limits into disclosures.**
- [ ] **Step 3: Separate worker setup actions from destructive/admin actions in headers and cards.**
- [ ] **Step 4: Ensure pending-worker and configuration forms retain clear status text independent of color.**
- [ ] **Step 5: Run existing onboarding/worker tests and web typecheck.**

### Task 6: Scope loading, error, and update feedback

**Files:**
- Modify: `apps/web/src/routes/OverviewPage.tsx`
- Modify: `apps/web/src/routes/RunsPage.tsx`
- Modify: `apps/web/src/routes/RepositoriesPage.tsx`
- Modify: `apps/web/src/routes/WorkersPage.tsx`
- Modify: `apps/web/src/routes/PoolsPage.tsx`
- Modify: `apps/web/src/routes/SettingsPage.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Pass operation-specific labels to each `QueryState` call.**
- [ ] **Step 2: Add successful query completion timestamps locally to operational page headers where no server timestamp exists.**
- [ ] **Step 3: Distinguish API/query errors from GitHub connection and worker readiness copy without changing error transport.**
- [ ] **Step 4: Ensure color-coded states also include text labels/status attributes.**
- [ ] **Step 5: Run focused web tests and typecheck.**

### Task 7: Verify the complete UI change

**Files:**
- No new files.

- [ ] **Step 1: Run `bun run --filter '@mars/web' typecheck`.**
- [ ] **Step 2: Run `bun run --filter '@mars/web' build`; record any existing non-fatal CSS warnings.**
- [ ] **Step 3: Start the built web shell on an unused local port and inspect `/`, `/repositories`, `/settings`, `/pools`, and `/onboarding` at 1440px and 390px.**
- [ ] **Step 4: Verify mobile menu open/close, Escape dismissal, keyboard focus, disclosure behavior, no clipped labels, and 44px touch targets.**
- [ ] **Step 5: Run `node /Users/acoop/.claude/skills/impeccable/scripts/detect.mjs --json apps/web/src` and confirm no new high-severity findings.**
- [ ] **Step 6: Re-run the relevant focused tests and summarize exact verification evidence.**
