# Overview Period Control Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with verification after each task.

**Goal:** Add an accessible 24-hour, 7-day, and 30-day time control to the overview dashboard.

**Architecture:** `OverviewPage` owns the selected period and passes it to the existing `getOverview` API. The selected value is part of the TanStack Query key, while a compact radio-group control renders beside the existing page action. No backend or contract changes.

**Tech Stack:** React 19, TanStack Query, TypeScript, Bun tests, existing CSS variables.

## Global Constraints

- Default period remains `24h`.
- Supported periods are exactly `24h`, `7d`, and `30d`.
- Preserve existing loading, error, retry, and navigation behavior.
- Do not persist the period in the URL or local storage.

---

### Task 1: Add period state and control

**Files:**
- Modify: `apps/web/src/routes/OverviewPage.tsx`
- Test: `apps/web/src/routes/OverviewPage.test.tsx`

- [ ] Add a failing test that renders the overview with mocked `getOverview`, asserts the default `24h` request, and asserts selecting `7d` causes a `7d` request.
- [ ] Run `bun test apps/web/src/routes/OverviewPage.test.tsx` and confirm the new behavior fails before implementation.
- [ ] Add `OverviewPeriod = "24h" | "7d" | "30d"`, state initialized to `"24h"`, and a period label map.
- [ ] Add a radio-group control with native radio inputs labeled `24h`, `7d`, and `30d`; keep the selected value controlled.
- [ ] Change the query key and `getOverview` call to use the selected period.
- [ ] Render the active human-readable period in the page eyebrow.
- [ ] Run the route test and confirm it passes.

### Task 2: Style and verify the control

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/routes/OverviewPage.test.tsx`

- [ ] Add styles for a compact `.overview-period-control` radio group using existing `--panel`, `--line`, `--muted`, and `--acid` tokens.
- [ ] Ensure focus-visible state is explicit and the control wraps cleanly on narrow widths.
- [ ] Add assertions for the accessible group label and all three period options.
- [ ] Run `bun test apps/web/src/routes/OverviewPage.test.tsx`.

### Task 3: Full verification

**Files:** None.

- [ ] Run `bun run --filter '@whitesmith/web' typecheck`.
- [ ] Run `bun test apps/web/src/routes/OverviewPage.test.tsx apps/web/src/components/JobActivityChart.test.tsx`.
- [ ] Run `bun run --filter '@whitesmith/web' build` and confirm exit code 0.
