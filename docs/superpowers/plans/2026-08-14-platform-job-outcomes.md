# Platform Job Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add server-derived platform distribution to the overview dashboard and render it as vertical stacked job-outcome bars.

**Architecture:** Extend the existing `OverviewDto` with normalized job-outcome cells. Aggregate those cells in the dashboard database layer using requested runner labels and existing organization/period boundaries. Replace the current horizontal outcome component with a vertical stacked chart that consumes only normalized contract data.

**Tech Stack:** TypeScript, Zod, PostgreSQL tagged SQL, React, TanStack Charts, Bun tests, Vite.

## Global Constraints

- Count jobs, not workflow runs.
- Classify requested labels case-insensitively: macOS first, then Ubuntu/Linux, then Windows, otherwise Other.
- Use fixed outcome order queued, running, completed, failed and platform order macOS, Ubuntu, Windows, Other.
- Completed/failed apply the selected period; queued/running represent current state.
- Preserve organization membership boundaries and existing loading/error behavior.
- Run focused tests, web typecheck, production build, and dashboard smoke verification.

---

### Task 1: Extend overview contract and backend aggregation

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/db/src/dashboard.ts`
- Test: `packages/db/src/dashboard.test.ts`
- Test: `tests/dashboard-contracts.test.ts`

**Interfaces:**
- Produce `OverviewDto.jobOutcomes`: `{ outcome: "queued" | "running" | "completed" | "failed"; platforms: { macos: number; ubuntu: number; windows: number; other: number } }[]`.
- Keep the existing `getOverview` and `getAllOverview` signatures.

- [ ] Add contract tests for complete and invalid `jobOutcomes` payloads.
- [ ] Add database tests covering label classification, Other fallback, completed-success versus failed conclusions, selected-period filtering, and organization/all-workspace query paths.
- [ ] Add the Zod schema with nonnegative integer platform cells and fixed outcome enum.
- [ ] Add one shared SQL aggregation helper or query shape that returns all four outcomes and four platform cells as zero-filled normalized objects.
- [ ] Join jobs to runs only where needed for period filtering; use requested labels as the classification source.
- [ ] Merge `jobOutcomes` into both overview return values without changing existing fields.
- [ ] Run focused contract/database tests and typecheck affected packages.

### Task 2: Implement vertical stacked chart UI

**Files:**
- Modify: `apps/web/src/components/OutcomeBars.tsx`
- Modify: `apps/web/src/routes/OverviewPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/components/OutcomeBars.test.tsx`

**Interfaces:**
- Consume `OverviewDto["jobOutcomes"]` directly or an equivalent exported type.
- Keep `OutcomeBars` as the component boundary, changing its props from flat outcomes to normalized job outcomes.

- [ ] Write component tests for four outcome labels, platform legend, accessible count summary, and all-zero empty state.
- [ ] Replace horizontal `barX` marks with vertical stacked bars using the existing TanStack Charts dependency and stable platform order.
- [ ] Add platform colors and a visible legend without relying on color alone for accessibility.
- [ ] Update `OverviewContent` to pass `data.jobOutcomes` and rename the panel to `Job outcomes`.
- [ ] Add responsive chart styles for narrow dashboard widths while preserving existing visual language.
- [ ] Run focused web component tests and web typecheck.

### Task 3: Verify dashboard behavior and build

**Files:**
- Modify: `apps/web/src/routes/OverviewPage.test.tsx` only if contract expectations need updating.

- [ ] Run the complete relevant test commands for contracts, database, and web.
- [ ] Run `bun run --cwd apps/web typecheck` and `bun run --cwd apps/web build`.
- [ ] Launch the dashboard and inspect the overview chart at desktop and narrow viewport widths.
- [ ] Confirm no console errors and that the chart labels, legend, stacking, and empty state render correctly.
- [ ] Review the final diff for scope and commit the implementation.
