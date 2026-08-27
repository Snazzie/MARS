# Run Detail Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make failed runs clickable from every Runs view and route to the existing Mars run-detail page.

**Architecture:** Keep navigation in `RunTable`'s run-number cell. Remove the cross-workspace restriction at the caller, and make the detail page query use the selected run's organization ID rather than the literal `all` route scope.

**Tech Stack:** React, TanStack Router, TanStack Query, Bun tests.

## Global Constraints

- Use the existing `/runs/$runId` route; do not add an external GitHub link.
- Preserve the existing run table markup and status rendering.
- Do not change API or database contracts.

---

### Task 1: Enable cross-workspace run-detail navigation

**Files:**
- Modify: `apps/web/src/routes/RunsPage.tsx`
- Modify: `apps/web/src/routes/RunDetailPage.tsx`

**Interfaces:**
- Consumes: `RunSummary.organizationId` from the existing runs API response.
- Produces: Run-detail navigation that loads the selected run under its owning organization.

- [ ] **Step 1: Update the Runs page**

Pass `allowDetails` to `RunTable` without disabling it for `organizationId === "all"`.

- [ ] **Step 2: Scope detail loading to the selected run**

In `RunDetailPage`, load the run under the organization represented by the selected run. Keep the existing route and loading state; use the selected run's `organizationId` after a summary lookup if the `all` endpoint is used.

- [ ] **Step 3: Run the focused test**

Run `bun test apps/web/src/components/RunTable.test.tsx`.

Expected: existing tests pass.

---

### Task 2: Add regression coverage

**Files:**
- Modify: `apps/web/src/components/RunTable.test.tsx`

**Interfaces:**
- Consumes: `RunTable` link rendering.
- Produces: A failing-run assertion that fails if navigation is removed.

- [ ] **Step 1: Add a failed-run fixture assertion**

Render a completed run with `conclusion: "failure"` and `allowDetails` enabled, then assert the HTML contains `href="/runs/run-1"` and the failed status.

- [ ] **Step 2: Run the focused test**

Run `bun test apps/web/src/components/RunTable.test.tsx`.

Expected: all tests pass.

- [ ] **Step 3: Inspect the diff**

Run `git diff -- apps/web/src/routes/RunsPage.tsx apps/web/src/routes/RunDetailPage.tsx apps/web/src/components/RunTable.test.tsx` and confirm only run-detail navigation behavior changed.
