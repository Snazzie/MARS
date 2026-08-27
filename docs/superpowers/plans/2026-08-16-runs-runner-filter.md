# `/runs` Runner Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible All / Mars / External toggle to `/runs`, defaulting to All and composing with existing run filters.

**Architecture:** Keep the feature client-side. `RunHistory` owns the selected runner filter and extends its pure `filterRuns` predicate with a `RunHistoryRunnerFilter` argument; `RunsPage` and API contracts remain unchanged. Render the control beside the existing search and time-range controls.

**Tech Stack:** React, TypeScript, TanStack Query, Bun test, `@mars/contracts`.

## Global Constraints

- Default runner filter is `all`.
- `mars` matches only `allocationState === "mars"`.
- `external` matches only `allocationState === "external"`.
- Runner filtering composes with search and queued-time range filtering.
- Toggle buttons use `aria-pressed` and existing run-history toolbar styling.
- No API, database, or unrelated UI changes.

---

### Task 1: Add runner filter predicate and toggle

**Files:**
- Modify: `apps/web/src/components/RunHistory.tsx`

**Interfaces:**
- Produces `RunHistoryRunnerFilter = "all" | "mars" | "external"`.
- Extends `filterRuns(runs, search, range, nowMs, runnerFilter)` with a default-compatible runner filter argument.

- [ ] **Step 1: Extend the pure filtering test fixture**

In `apps/web/src/components/RunHistory.test.tsx`, add an external fixture using `allocationState: "external"` and a Mars fixture using `allocationState: "mars"`. Keep their timestamps within `NOW` so only runner ownership differs.

- [ ] **Step 2: Write failing predicate tests**

Add tests equivalent to:

```ts
test("filters runs by runner ownership", () => {
  const runs = [run({ id: "white", allocationState: "mars" }), run({ id: "external", allocationState: "external" })];
  expect(filterRuns(runs, "", "all", NOW, "all").map((item) => item.id)).toEqual(["white", "external"]);
  expect(filterRuns(runs, "", "all", NOW, "mars").map((item) => item.id)).toEqual(["white"]);
  expect(filterRuns(runs, "", "all", NOW, "external").map((item) => item.id)).toEqual(["external"]);
});
```

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `bun test apps/web/src/components/RunHistory.test.tsx`

Expected: FAIL because `filterRuns` does not yet accept or apply the runner filter.

- [ ] **Step 4: Implement the minimal runner filter**

Define `RunHistoryRunnerFilter`, add a `runnerFilter` parameter to `filterRuns`, and require the run to match the selected allocation state unless the filter is `all`. Default the parameter to `all` to preserve existing callers. Add `useState<RunHistoryRunnerFilter>("all")` in `RunHistory`, pass it into `filterRuns`, and render All / Mars / External buttons with `aria-pressed` in the existing toolbar.

- [ ] **Step 5: Run focused component tests**

Run: `bun test apps/web/src/components/RunHistory.test.tsx apps/web/src/routes/RunsPage.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the implementation**

```bash
git add apps/web/src/components/RunHistory.tsx apps/web/src/components/RunHistory.test.tsx
git commit -m "feat: filter runs by runner ownership"
```

### Task 2: Verify integration and accessibility contract

**Files:**
- Review: `apps/web/src/components/RunHistory.tsx`
- Review: `apps/web/src/components/RunHistory.test.tsx`
- Review: `apps/web/src/routes/RunsPage.tsx`

**Interfaces:**
- Consumes the `RunHistory` runner filter from Task 1.
- Confirms `/runs` still passes fetched runs unchanged and defaults to all.

- [ ] **Step 1: Add rendered toggle assertions**

Assert static markup contains the three labels, exactly one `aria-pressed="true"` for All by default, and the external fixture is rendered under the All filter. Add a rendered interaction test only if the existing test setup supports client interaction; otherwise cover state through the pure predicate and default markup.

- [ ] **Step 2: Run the focused test suite**

Run: `bun test apps/web/src/components/RunHistory.test.tsx apps/web/src/routes/RunsPage.test.tsx`

Expected: PASS with no snapshot or type errors.

- [ ] **Step 3: Run the web typecheck**

Run: `bun run --filter @mars/web typecheck`

Expected: PASS.

- [ ] **Step 4: Review the final diff**

Run: `git diff HEAD~1 -- apps/web/src/components/RunHistory.tsx apps/web/src/components/RunHistory.test.tsx apps/web/src/routes/RunsPage.tsx`

Confirm only the runner filter behavior, tests, and approved specification/plan are present; no API or database changes were introduced.
