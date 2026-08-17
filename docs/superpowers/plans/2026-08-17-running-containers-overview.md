# Running Containers Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show all active containers below the overview charts with latest CPU/memory telemetry and explicit unavailable disk status.

**Architecture:** Extend the shared `OverviewDto` with a normalized `runningContainers` array. The DB dashboard layer will query active leases, join job/run/worker identity, and use a lateral latest-sample lookup. The existing overview route returns the expanded DTO; a focused React component renders the table and empty state.

**Tech Stack:** Bun, TypeScript, Zod, PostgreSQL tagged SQL, React, TanStack Query, Bun test, React server rendering.

## Global Constraints

- Active lease states are `reserved`, `requested`, `dispatched`, `provisioning`, `sandbox_ready`, `online`, and `busy`.
- Missing CPU/memory samples render `Not reported`, never zero.
- Disk usage renders `Not reported`; requested storage is not actual usage.
- Rows are newest first and remain scoped to the selected organization or authorized global overview.
- No independent polling loop; use the existing overview query behavior.

---

### Task 1: Add overview container contract and DB query

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/db/src/dashboard.ts`
- Modify: `packages/db/src/dashboard.test.ts`

**Interfaces:**
- Produces `OverviewRunningContainer` with `id`, `jobId`, `jobName`, `repositoryName`, `workflowName`, `workerName`, `runtime`, `startedAt`, nullable `cpuUsagePercent`, nullable `memoryWorkingSetBytes`, nullable `memoryLimitBytes`, nullable `diskUsageBytes`, `allocatedStorageBytes`, nullable `sampledAt`.
- Produces `getOverviewRunningContainers(db, organizationId, userId?)`, used by both `getOverview` and `getAllOverview`.

- [ ] **Step 1: Add contract and query tests**

Add a dashboard DB test whose fake SQL returns active lease rows and a latest telemetry row, then assert the normalized result contains the row and that the generated SQL includes active-state filtering, latest-sample ordering, and organization scope. Add an empty result assertion.

- [ ] **Step 2: Run the focused DB test and confirm failure**

Run: `bun test packages/db/src/dashboard.test.ts`
Expected: FAIL because the new contract/query symbols are absent.

- [ ] **Step 3: Implement the contract**

In `packages/contracts/src/dashboard.ts`, define the strict row schema using existing safe numeric/timestamp helpers. Add `runningContainers: z.array(OverviewRunningContainer).default([])` to `OverviewDto`. Keep disk nullable and expose allocated storage separately.

- [ ] **Step 4: Implement the DB query**

In `packages/db/src/dashboard.ts`, query `runner_leases` joined to `dashboard_jobs`, `dashboard_runs`, `workers`, and `runner_pools`. Filter the active states and organization scope; for the global view filter organizations through the existing user membership model. Use `LEFT JOIN LATERAL` against `dashboard_job_resource_samples` ordered by `occurred_at DESC LIMIT 1`. Normalize dates and numeric fields. Return `runningContainers` from both overview functions.

- [ ] **Step 5: Run the focused DB tests**

Run: `bun test packages/db/src/dashboard.test.ts`
Expected: PASS, including existing overview tests and the new active-container assertions.

- [ ] **Step 6: Commit the contract and query**

Run: `git add packages/contracts/src/dashboard.ts packages/db/src/dashboard.ts packages/db/src/dashboard.test.ts && git commit -m "feat: expose running containers in overview"`

### Task 2: Render the running containers section

**Files:**
- Create: `apps/web/src/components/RunningContainers.tsx`
- Create: `apps/web/src/components/RunningContainers.test.tsx`
- Modify: `apps/web/src/routes/OverviewPage.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes `OverviewDto["runningContainers"]`.
- Produces accessible section heading `Running containers`, table headers for CPU, memory, and disk, and empty state `No containers are running.`.

- [ ] **Step 1: Write rendering tests**

Render the component with one populated row, one row with null telemetry, and an empty array. Assert the populated values, `Not reported` fallbacks, disk explanatory text, and empty state.

- [ ] **Step 2: Run the focused component test and confirm failure**

Run: `bun test apps/web/src/components/RunningContainers.test.tsx`
Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the component**

Create a semantic `<section>` with a heading and responsive table. Format CPU as a percentage, memory using the existing resource formatting convention, allocated storage separately from actual disk, and sample age from `sampledAt`. Use `Not reported` for null values and no row-level zero fallback.

- [ ] **Step 4: Place and style the section**

Render `<RunningContainers containers={data.runningContainers} />` after the chart sections in `OverviewContent`. Add only overview-specific table/card styles matching existing panel, table, typography, and responsive conventions.

- [ ] **Step 5: Run the focused web tests**

Run: `bun test apps/web/src/components/RunningContainers.test.tsx apps/web/src/routes/OverviewPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit the UI**

Run: `git add apps/web/src/components/RunningContainers.tsx apps/web/src/components/RunningContainers.test.tsx apps/web/src/routes/OverviewPage.tsx apps/web/src/styles.css && git commit -m "feat: show running containers on overview"`

### Task 3: Verify the expanded overview contract end to end

**Files:**
- Modify: `apps/control-plane/src/http/dashboard-routes.test.ts` only if route parsing needs explicit coverage.

- [ ] **Step 1: Run focused DB and web coverage**

Run: `bun test packages/db/src/dashboard.test.ts apps/web/src/components/RunningContainers.test.tsx apps/web/src/routes/OverviewPage.test.tsx`
Expected: PASS.

- [ ] **Step 2: Run workspace typecheck**

Run: `bun run typecheck`
Expected: PASS with the expanded DTO consumed by the API and web app.

- [ ] **Step 3: Smoke-check the overview surface**

Start the existing web/control-plane development surface and open the overview route with a seeded or connected environment. Confirm the section appears below the charts, populated rows show CPU/memory values when samples exist, missing telemetry says `Not reported`, disk is clearly unavailable, and zero active leases shows the empty state.

- [ ] **Step 4: Commit any required route coverage only**

If route validation requires a test adjustment, run `git add apps/control-plane/src/http/dashboard-routes.test.ts && git commit -m "test: cover overview container payload"`; otherwise leave route code unchanged because it already parses `OverviewDto`.
