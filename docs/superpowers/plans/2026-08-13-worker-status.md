# Worker Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show operational and readiness status for workers and worker coverage for runner pools.

**Architecture:** Reuse `WorkerDetail` returned by the existing workers endpoint. `WorkerCard` renders operational/readiness badges. `PoolsPage` fetches global workers alongside global pools, joins worker-bound pools by `workerId`, and aggregates compatible workers for shared pools. No schema or API changes.

**Tech Stack:** React 19, TanStack React Query, Bun tests, TypeScript, Zod contracts.

## Global Constraints

- Use existing `connectionState`, `configurationState`, and `draining` fields.
- Operational labels: Online, Offline, Draining.
- Readiness labels: Ready, Needs configuration, Error.
- Shared pools show online and ready counts; zero ready workers show `No ready workers`.
- Worker query failures must not fabricate healthy pool status.

---

### Task 1: Add failing status assertions

**Files:**
- Modify: `apps/web/src/components/WorkerCard.test.tsx` (create if absent)
- Modify: `apps/web/src/routes/PoolsPage.test.tsx` (create if absent)

**Interfaces:**
- Tests consume `WorkerCard` and `PoolsPage` render output.
- Tests establish the required visible labels before implementation.

- [ ] **Step 1: Add a WorkerCard rendering test**

Render a `WorkerCard` with an adopted, online, ready worker and assert the markup contains `Online` and `Ready`; render an offline/error worker and assert `Offline` and `Error`.

- [ ] **Step 2: Add pool coverage helper/page test**

Render the pool coverage view with a shared macOS pool and workers containing one online/ready worker and one offline/unconfigured worker; assert `1 online`, `1 ready`, and no `No ready workers`. Add a zero-ready case asserting `No ready workers`.

- [ ] **Step 3: Run focused tests and verify failure**

Run `bun test apps/web/src/components/WorkerCard.test.tsx apps/web/src/routes/PoolsPage.test.tsx`.
Expected: FAIL because the new labels and coverage are not rendered yet.

---

### Task 2: Implement worker status presentation

**Files:**
- Modify: `apps/web/src/components/WorkerCard.tsx`

**Interfaces:**
- Consumes `WorkerDetail`.
- Produces visible status-pill elements with accessible labels.

- [ ] **Step 1: Add status label derivation**

Map `draining === true` to operational `Draining`; otherwise map `connectionState` to `Online` or `Offline`. Map configuration state `ready` to `Ready`, `error` to `Error`, and `unconfigured` to `Needs configuration`.

- [ ] **Step 2: Render two status pills in the card header**

Keep admission metadata and actions intact. Add operational and readiness pills with class names derived from existing status classes and `aria-label` values that include the category.

- [ ] **Step 3: Run the WorkerCard test**

Run `bun test apps/web/src/components/WorkerCard.test.tsx`.
Expected: PASS.

---

### Task 3: Implement pool worker coverage

**Files:**
- Modify: `apps/web/src/routes/PoolsPage.tsx`
- Modify: `apps/web/src/api.ts` only if an existing worker query helper cannot be reused.

**Interfaces:**
- Consumes `getGlobalPools()` and `getWorkers("all")`.
- Produces pool cards with worker status coverage text.

- [ ] **Step 1: Fetch global workers with the pool query**

Use a second React Query query keyed as `["workers", "global", false]`, calling `getWorkers("all")`. Keep pool rendering available while worker data loads or fails.

- [ ] **Step 2: Compute coverage without changing persistence**

For worker-bound pools, select `workerId` and show that worker’s operational/readiness labels. For shared pools, select workers matching `platform` and `driver`, then count online and ready workers. Treat a missing worker query as `Worker status unavailable`, never as healthy.

- [ ] **Step 3: Render warning and counts**

Add a labelled `Worker status` block to each pool. Shared pools show `{online} online · {ready} ready`; bound pools show the worker status. Show `No ready workers` whenever the resolved matching set has zero ready workers.

- [ ] **Step 4: Run pool tests and typecheck**

Run `bun test apps/web/src/routes/PoolsPage.test.tsx && bun run --filter @mars/web typecheck`.
Expected: PASS.

---

### Task 4: Full verification and browser smoke test

**Files:**
- No source changes expected.

- [ ] **Step 1: Run focused web tests**

Run `bun test apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/WorkerCard.test.tsx apps/web/src/routes/PoolsPage.test.tsx`.
Expected: PASS.

- [ ] **Step 2: Run web typecheck and build**

Run `bun run --filter @mars/web typecheck && bun run --filter @mars/web build`.
Expected: typecheck and build exit 0.

- [ ] **Step 3: Restart the static web service and inspect `/workers` and `/pools`**

Restart `web-static`, open both routes in the browser, and confirm the rendered page contains the new status labels or the signed-out state if authentication is unavailable. Do not claim live worker values when signed out.

- [ ] **Step 4: Store completion context**

Run `icm store -t context-mars -c "Implemented worker operational/readiness status and pool worker coverage UI; verified focused tests, typecheck, build, and browser routes." -i high`.
