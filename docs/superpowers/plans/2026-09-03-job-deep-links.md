# Job Deep Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add new-tab links that open a specific dashboard job in its existing run detail view from the Runs UI and managed-container workload UI.

**Architecture:** Keep `/runs/$runId` as the only detail route and encode the target job as `#job-{jobId}`. Add the missing local `runId` to overview running-container data, centralize URL construction in the web layer, render stable job section ids, and scroll to the fragment after run details mount.

**Tech Stack:** TypeScript, React, TanStack Router, Zod contracts, Bun tests, happy-dom.

## Global Constraints

- Use local dashboard identifiers: links target `/runs/{runId}#job-{jobId}`.
- Open links in a new tab with `target="_blank"` and `rel="noreferrer"`.
- Preserve existing run-detail rendering and API routes; no GitHub external URL is required.
- Missing or malformed fragments must not prevent run-detail rendering.
- Follow existing compact JSX and static-markup test conventions.

---

### Task 1: Expose run identifiers for managed containers

**Files:**
- Modify: `packages/contracts/src/dashboard.ts:31-34`
- Modify: `packages/db/src/dashboard.ts:69-75`
- Test: `apps/web/src/components/RunningContainers.test.tsx:6-17`

**Interfaces:**
- Produces `OverviewRunningContainer.runId: string`, consumed by the managed-container link in Task 3.

- [ ] **Step 1: Extend the strict overview container contract**

Add `runId: id` to `OverviewRunningContainer` beside `jobId`. This is required because the existing run-detail route identifies the parent run separately from the local job id.

- [ ] **Step 2: Select and normalize the parent run id**

In both `getOverviewRunningContainers` SQL projections, select `j.run_id AS "runId"` and include `runId: String(row.runId)` in the mapped object. Keep the existing `jobId` as the local dashboard job id.

- [ ] **Step 3: Update the container fixture and assert the contract data**

Set `runId: "run-1"` in the existing fixture. Keep the existing rendering assertions and add an assertion that the rendered managed-container link contains `/runs/run-1#job-job-1` after Task 3 is implemented.

- [ ] **Step 4: Run the focused contract/UI test**

Run: `bun test apps/web/src/components/RunningContainers.test.tsx`

Expected: the fixture parses and the existing tests pass; the new link assertion may remain pending until Task 3.

- [ ] **Step 5: Commit the data contract change**

```bash
git add packages/contracts/src/dashboard.ts packages/db/src/dashboard.ts apps/web/src/components/RunningContainers.test.tsx
git commit -m "feat: expose run ids for active jobs"
```

### Task 2: Add shared job link construction and run-detail anchors

**Files:**
- Modify: `apps/web/src/components/RunDetailView.tsx:1-3,62-88`
- Modify: `apps/web/src/components/RunDetailView.test.tsx:48-89`
- Modify: `apps/web/src/routes/RunDetailPage.tsx:1-24`
- Test: `apps/web/src/components/RunDetailView.test.tsx`

**Interfaces:**
- Produces `jobDetailHref(runId: string, jobId: string): string`, consumed by Task 3.

- [ ] **Step 1: Add a deterministic URL helper test**

Export a helper from `RunDetailView.tsx` and test that `jobDetailHref("run-1", "job-1")` returns `/runs/run-1#job-job-1`. The helper must use `encodeURIComponent` for both identifiers so an identifier cannot alter the path or fragment.

- [ ] **Step 2: Add stable ids and heading links to each job section**

Change each logs and metrics job section to include `id={`job-${job.id}`}`. In each job heading, render a native anchor using the helper with `data.run id` and `job.id`, `target="_blank"`, `rel="noreferrer"`, and an accessible label such as `Open job ${job.name} in a new tab`.

Use the same anchor in both Logs and Metrics render branches, avoiding duplicate links in one visible panel by retaining the existing tab structure.

- [ ] **Step 3: Scroll to a matching fragment after details render**

In `RunDetailPage`, add a `useEffect` keyed by `query.data` and `runId`. Read `window.location.hash`, reject hashes that do not match the `job-` prefix, find the element by id, and call `scrollIntoView({ block: "start" })` when available. Do not throw when `window` is unavailable or the target does not exist.

- [ ] **Step 4: Test anchors and stable ids with static markup**

Extend `RunDetailView.test.tsx` to assert the output contains `id="job-job-1"`, `/runs/run-1#job-job-1`, `target="_blank"`, and `rel="noreferrer"`. Assert the accessible label contains the job name.

- [ ] **Step 5: Run focused run-detail tests**

Run: `bun test apps/web/src/components/RunDetailView.test.tsx apps/web/src/routes/RunDetailPage.test.tsx`

Expected: all focused run-detail tests pass, including the existing `apps/web/src/routes/RunDetailPage.test.tsx` fragment-navigation coverage.

- [ ] **Step 6: Commit the run-detail implementation**

```bash
git add apps/web/src/components/RunDetailView.tsx apps/web/src/components/RunDetailView.test.tsx apps/web/src/routes/RunDetailPage.tsx
git commit -m "feat: deep link to run jobs"
```

### Task 3: Link managed containers to their specific jobs

**Files:**
- Modify: `apps/web/src/components/RunningContainers.tsx:1-35`
- Modify: `apps/web/src/components/RunningContainers.test.tsx:6-17`
- No route change is needed; `OverviewPage` already renders `RunningContainers` through its existing overview data flow.

**Interfaces:**
- Consumes `RunningContainer.runId` from Task 1 and `jobDetailHref` from Task 2.

- [ ] **Step 1: Add the managed-container action column**

Import the shared helper and render an `Open job` anchor in each `ContainerRow`, with an accessible name including `container.jobName`, `target="_blank"`, and `rel="noreferrer"`. Add a matching table header such as `Action` so the control remains understandable in the table.

- [ ] **Step 2: Assert the managed-container destination**

Update the fixture with `runId: "run-1"` and assert static markup contains `/runs/run-1#job-job-1`, `target="_blank"`, `rel="noreferrer"`, and the job-specific accessible label.

- [ ] **Step 3: Run the focused managed-container tests**

Run: `bun test apps/web/src/components/RunningContainers.test.tsx`

Expected: all existing telemetry and empty-state assertions plus the new deep-link assertions pass.

- [ ] **Step 4: Commit the managed-container link**

```bash
git add apps/web/src/components/RunningContainers.tsx apps/web/src/components/RunningContainers.test.tsx
git commit -m "feat: link active containers to jobs"
```

### Task 4: Verify the complete web behavior

**Files:**
- No additional source files are expected for this verification task; correct only the implementation files named in Tasks 1–3 if a verification failure identifies a real contract gap.

- [ ] **Step 1: Run the changed web tests**

Run: `bun test apps/web/src/components/RunDetailView.test.tsx apps/web/src/components/RunningContainers.test.tsx apps/web/src/routes/RunsPage.test.tsx apps/web/src/routes/OverviewPage.test.tsx`

Expected: PASS.

- [ ] **Step 2: Launch the web app and perform a browser smoke check**

Use the repository’s existing web start command. Open a run detail URL with `#job-job-1`, wait for the job sections, and verify the matching job section is present and scrolled into view. Open the managed-container action and verify it creates a new tab whose URL is `/runs/run-1#job-job-1`.

- [ ] **Step 3: Run the repository’s typecheck/build command**

Use the existing package script for the web workspace. Expected: TypeScript and route generation accept the added `runId` field and helper usage.

- [ ] **Step 4: Inspect the final diff and commit verification changes if any**

Confirm no external GitHub URL, duplicate route, placeholder, or link without a parent `runId` remains. If a verification failure required a correction, commit that correction with a focused message.
