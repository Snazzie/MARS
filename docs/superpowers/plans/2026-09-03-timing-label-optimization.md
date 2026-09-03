# Timing Label Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conservative, editable `VCPU`/`G` recommendations to `/runs/timing` and create a PR that updates the selected Windows workflow job without changing its routing label.

**Architecture:** Add a shared recommendation contract and a database query that computes p95 successful-run resource demand. Add a selected-job workflow mutation path to the existing GitHub App service and dashboard API. Render an optimization panel in the selected timing detail that feeds editable labels into a focused PR modal.

**Tech Stack:** Bun, TypeScript, Hono, PostgreSQL SQL, Zod contracts, React, TanStack Query, YAML workflow mutation, Bun tests.

## Global Constraints

- Preserve the existing Windows routing label, such as `mars-windows-x64`.
- Numeric labels use `<n>VCPU` and `<n>G`.
- Use successful completed runs in the active timing range.
- Require at least 5 successful runs and 80% CPU/memory telemetry coverage.
- Compute `ceil(p95CpuPeakPercent / 100 * 1.25)` and `ceil(p95MemoryPeakBytes / 1024^3 * 1.25)`.
- Recommendations are editable and remain explicitly non-guaranteed sampled-telemetry guidance.
- A PR updates only the selected workflow job and preserves unrelated workflow content.
- Preserve expected-head-SHA, idempotency, permission, stale-head, and result-link behavior.

---

### Task 1: Add recommendation contracts and pure policy

**Files:**
- Modify: `packages/contracts/src/dashboard.ts` near resource-trend contracts
- Modify: `packages/contracts/src/dashboard-api.ts` exports
- Create: `packages/db/src/job-label-recommendations.ts`
- Create: `packages/db/src/job-label-recommendations.test.ts`

**Interfaces:**
- Produces `JobLabelRecommendationQuery` with `from`, `to`, `repositoryId`, `workflowName`, and `jobName`.
- Produces `JobLabelRecommendation` containing `status`, `currentWindowsLabel`, `recommendedVcpu`, `recommendedMemoryGiB`, `p95CpuPeakPercent`, `p95MemoryPeakBytes`, `successfulRunCount`, `telemetryCoveragePercent`, and an unavailable `reason`.
- Produces `getJobLabelRecommendation(db, organizationId, query, userId?)`.

- [ ] **Step 1: Write failing policy tests**

```ts
test("rounds p95 demand with the fixed safety factor", () => {
  expect(recommendResourceLabels({ cpuP95: 201, memoryP95Bytes: 5 * 1024 ** 3, successfulRuns: 8, coveredRuns: 8 })).toMatchObject({ vcpu: 3, memoryGiB: 7 });
});

test("rejects insufficient history or telemetry", () => {
  expect(recommendResourceLabels({ cpuP95: 10, memoryP95Bytes: 1, successfulRuns: 4, coveredRuns: 4 }).status).toBe("unavailable");
  expect(recommendResourceLabels({ cpuP95: 10, memoryP95Bytes: 1, successfulRuns: 10, coveredRuns: 7 }).status).toBe("unavailable");
});

test("never replaces the Windows routing label", () => {
  expect(buildOptimizedLabels(["mars-windows-x64", "8VCPU", "16G"], 4, 8)).toEqual(["mars-windows-x64", "4VCPU", "8G"]);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `bun test packages/db/src/job-label-recommendations.test.ts`
Expected: FAIL because the policy and query module do not exist.

- [ ] **Step 3: Implement the policy and Zod response**

Implement pure functions that:
- filter/normalize the existing Windows routing label;
- parse current positive integer `VCPU`/`G` labels;
- return unavailable if successful runs are below 5 or coverage is below 80%;
- calculate the exact ceiling formulas from the global constraints;
- retain a valid current numeric label when its metric is null;
- return unavailable when no safe value exists.

Add strict schemas to `dashboard.ts` and re-export them through `dashboard-api.ts`.

- [ ] **Step 4: Implement the SQL query and normalization**

Query `dashboard_job_timing_snapshots` for the organization/user-visible scope, selected identity, active range, and `outcome='success'`. Use `percentile_cont(0.95)` over non-null `cpu_peak_percent` and `memory_peak_bytes`; count successful rows and rows with usable telemetry. Normalize SQL numerics to safe numbers and return the strict contract.

- [ ] **Step 5: Run focused tests**

Run: `bun test packages/db/src/job-label-recommendations.test.ts packages/contracts/src/dashboard-api.test.ts`
Expected: PASS.

---

### Task 2: Expose recommendation and selected-job PR APIs

**Files:**
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/http/types.ts` if the GitHub service interface needs the new method
- Modify: `apps/control-plane/src/github-app.ts`
- Modify: `apps/control-plane/src/workflow-pr.ts`
- Modify: `apps/control-plane/src/http/app.test.ts`
- Modify: `apps/control-plane/src/github-app.test.ts`
- Modify: `apps/control-plane/src/workflow-pr.test.ts`

**Interfaces:**
- Adds `GET /api/organizations/:organizationId/job-timings/label-recommendation?...` returning `JobLabelRecommendation`.
- Extends preview/create input with `{ selectedPath, selectedJobId, labels, expectedHeadSha }` for the focused mutation while retaining the existing migration flow.
- Produces preview jobs containing only the selected workflow job and its proposed labels.

- [ ] **Step 1: Add failing route and mutation tests**

Cover: valid recommendation query, insufficient-history response, selected-job preview containing one job, preservation of another job, empty/no-op rejection, stale head rejection, and PR body labels.

- [ ] **Step 2: Run focused control-plane tests and verify failure**

Run: `bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/workflow-pr.test.ts`
Expected: FAIL on missing endpoint/input fields or focused mutation behavior.

- [ ] **Step 3: Wire the recommendation route**

Parse the existing timing range and selected identity, enforce the same organization guard as other timing routes, call `getJobLabelRecommendation`, and map malformed input to `invalid_timing_query`/a dedicated recommendation error without converting missing telemetry to zero.

- [ ] **Step 4: Implement selected-job YAML mutation**

In `workflow-pr.ts`, add a mutation function that resolves one `jobs.<id>.runs-on` path, accepts only the preserved Windows label plus positive integer numeric labels, and changes that node only. Keep the current all-selected-files migration untouched for its existing callers.

- [ ] **Step 5: Implement GitHub preview/create support**

In `github-app.ts`, load the current workflow, verify the selected path/job, apply the focused mutation, compare against the current content for no-op, fetch the branch head, and create the same branch/tree/commit/PR sequence used by the existing flow. Include expected-head-SHA conflict handling and a generated description containing p95 values, sample count, and labels.

- [ ] **Step 6: Run focused tests**

Run: `bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/workflow-pr.test.ts`
Expected: PASS.

---

### Task 3: Build the editable optimization panel

**Files:**
- Create: `apps/web/src/components/JobLabelOptimization.tsx`
- Create: `apps/web/src/components/JobLabelOptimization.test.tsx`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/components/JobResourceDetail.tsx`
- Modify: `apps/web/src/routes/TimingHistoryPage.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- `getJobLabelRecommendation(organizationId, query)` calls the new endpoint.
- `JobLabelOptimization` accepts selected-job identity, organization ID, active range, and repository metadata; it emits a focused PR request with `selectedPath`, `selectedJobId`, and edited labels.

- [ ] **Step 1: Write failing component tests**

Test rendered states for loading, unavailable history, recommendation details, editable positive integer fields, Windows-label preservation, invalid values, and no-op disabling.

- [ ] **Step 2: Run focused web tests and verify failure**

Run: `bun test apps/web/src/components/JobLabelOptimization.test.tsx`
Expected: FAIL because the component and API helper do not exist.

- [ ] **Step 3: Implement the API helper and panel**

Use TanStack Query with a key containing organization, selected identity, and active range. Render sample count, coverage, p95 CPU/memory, current labels, editable `VCPU`/`G` inputs, and the exact before/after label diff. Reject non-integer positive input in the browser and keep the Windows routing label read-only.

- [ ] **Step 4: Embed the panel in selected job detail**

Pass the selected job identity from `TimingHistoryPage` through `JobResourceDetail`. Keep the existing resource charts and empty/error states unchanged. Do not show the PR action until repository/workflow identity and a valid recommendation are available.

- [ ] **Step 5: Add focused styling**

Follow the existing resource-history/card/button styles. Make the panel keyboard accessible, provide visible labels and `aria-live` status for preview/create outcomes, and preserve responsive behavior.

- [ ] **Step 6: Run focused web tests**

Run: `bun test apps/web/src/components/JobLabelOptimization.test.tsx apps/web/src/routes/TimingHistoryPage.test.tsx`
Expected: PASS.

---

### Task 4: Extend the PR modal for one selected job

**Files:**
- Modify: `apps/web/src/components/RunnerWorkflowPrModal.tsx`
- Modify: `apps/web/src/components/RunnerWorkflowPrModal.test.tsx`
- Modify: `apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx`
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Existing migration callers continue passing repository-wide `selectedPaths`.
- Optimization caller passes `selectedPath`, `selectedJobId`, and editable `labels`.
- `previewRunnerWorkflowPr` and `createRunnerWorkflowPr` serialize the focused mutation fields only when supplied.

- [ ] **Step 1: Add failing modal tests**

Cover focused preview rendering, only selected job in the diff, editable labels reflected in preview, no-op disabling, confirmation requirement, stale-head error refresh, and successful PR link.

- [ ] **Step 2: Run focused modal tests and verify failure**

Run: `bun test apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx`
Expected: FAIL on missing focused fields/rendering.

- [ ] **Step 3: Add focused modal state and request serialization**

Add optional selected-job/labels props, initialize the modal from the recommendation, refresh preview when labels change, render the server-proposed single-job diff, and disable create for invalid/no-op/unconfirmed/loading states. Preserve focus trap, Escape handling, error refresh, idempotency, and success URL behavior.

- [ ] **Step 4: Run focused modal tests**

Run: `bun test apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx`
Expected: PASS.

---

### Task 5: Verify the integrated timing workflow

**Files:**
- Modify: `tests/windows-playwright-smoke.mjs` only if the existing smoke harness needs a stable selector
- Modify: relevant existing test fixtures only when required by the new contract

- [ ] **Step 1: Run package and application contract tests**

Run: `bun test packages/contracts/src/dashboard-api.test.ts packages/db/src/job-label-recommendations.test.ts apps/control-plane/src/workflow-pr.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts apps/web/src/components/JobLabelOptimization.test.tsx apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx`
Expected: PASS.

- [ ] **Step 2: Launch the actual web/control-plane development surface**

Run: `bun run dev`
Expected: the repository development servers start, including the Vite surface at `http://localhost:5173`.

- [ ] **Step 3: Exercise the user flow**

Open `http://localhost:5173/runs/timing` with the configured authenticated smoke setup. Select a job with at least 5 successful runs, verify the Windows label remains unchanged, edit `VCPU`/`G`, inspect the one-job diff, confirm, create the PR, and verify the returned GitHub URL. Also verify insufficient telemetry displays guidance and does not enable PR creation.

- [ ] **Step 4: Run the existing Windows browser smoke command**

Run: `bun test tests/windows-playwright-smoke.mjs`
Expected: PASS, confirming the repository’s Playwright smoke dependency and browser launch remain healthy.

- [ ] **Step 5: Complete cleanup**

Remove unused migration-only props or duplicate label parsing introduced during implementation, then run the focused tests once more.
