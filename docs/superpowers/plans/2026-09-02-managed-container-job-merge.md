# Managed Container and Job Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each managed container with its one-to-one worker job in a single dashboard row, while preserving unmatched telemetry explicitly.

**Architecture:** Keep the existing `WorkerHealth` API contract with separate `containers` and `jobs` arrays. Add a presentation-layer join in `WorkerHealthPanel.tsx` keyed by exact `leaseId`; render container-first rows and a separate unassigned-jobs subsection for jobs without a container. No worker protocol, scheduler, database, or polling changes.

**Tech Stack:** TypeScript, React, Zod contracts, Bun test, React server-side markup tests.

## Global Constraints

- Association is exact `leaseId` equality.
- Each container has zero or one matching job.
- Every container and every job remains visible.
- Missing job data renders `No job assigned`, never fabricated zero values.
- Existing resource telemetry, formatting, and freshness values remain unchanged.
- Preserve worker-specific accessibility ID prefixes.

---

### Task 1: Add failing merged-workload component tests

**Files:**
- Modify: `apps/web/src/components/WorkerHealthPanel.test.tsx`
- Reference: `apps/web/src/components/WorkerHealthPanel.tsx:158-203`

**Interfaces:**
- Consumes: existing `WorkerHealth` fixture and `renderToStaticMarkup` test pattern.
- Produces: tests defining the merged table headings, lease-ID association, and unmatched-data behavior.

- [ ] **Step 1: Extend the managed-container fixture with a matching job**

Use the existing container lease ID `33333333-3333-4333-8333-333333333333` and add a job with `jobId: 42`, repository `acme/project`, state `running`, and requested resources. Keep the second container unmatched.

- [ ] **Step 2: Assert one merged managed-container table**

Assert the markup contains the `Managed containers` heading and headers for container identity/state/resources/freshness plus `Job ID`, `Repository / name`, `Lease state`, `Age`, `vCPU`, `Memory`, `Storage`, and `Concurrency`. Assert the matching row contains `42` and `acme/project`.

- [ ] **Step 3: Assert unmatched states**

Assert the unmatched container row contains `No job assigned`. Add a job whose lease ID has no container and assert the markup contains an `Unassigned jobs` heading and that job’s repository/name and ID.

- [ ] **Step 4: Update accessibility expectations**

Change the subsection ID assertion from `worker-health-...-jobs-heading` to the merged containers heading. Keep the existing containers ID expectation only if the implementation intentionally retains it; otherwise assert the single stable merged heading ID.

- [ ] **Step 5: Run the focused test and verify failure**

Run: `bun test apps/web/src/components/WorkerHealthPanel.test.tsx`

Expected: FAIL because the current component still renders separate jobs and containers sections and does not join by lease ID.

### Task 2: Implement the presentation-layer join

**Files:**
- Modify: `apps/web/src/components/WorkerHealthPanel.tsx:158-203,218-221`

**Interfaces:**
- Consumes: `WorkerHealthJob` and `WorkerHealthContainer` values from the unchanged `WorkerHealth` contract.
- Produces: merged managed-container markup and explicit unassigned-job markup.

- [ ] **Step 1: Add a lease-ID lookup and unmatched-job derivation**

Inside the merged section, construct `new Map(health.jobs.map((job) => [job.leaseId, job]))`. Render `health.containers` as the source of truth for primary rows. Derive unassigned jobs by filtering jobs where `!health.containers.some((container) => container.leaseId === job.leaseId)`; preserve input order.

- [ ] **Step 2: Replace the two sections with one merged section**

Remove the independent `JobsSection` and `ContainersSection` calls. Render one `Managed containers` section with one table. Preserve all current container formatting helpers and cells. Add job cells using existing fallbacks: `job.jobId ?? "Unavailable telemetry"`, `job.repositoryFullName ?? job.repositoryName ?? "Unavailable telemetry"`, `job.state`, `ageDisplay(job.ageSeconds, job.startedAt)`, and the existing requested-resource formatting.

- [ ] **Step 3: Render explicit missing-job and unassigned-job states**

For a container without a map match, render `No job assigned` in the job identity area. When unassigned jobs exist, render an `Unassigned jobs` subsection after the managed-container table with the job identity/state/resource information; do not duplicate container telemetry or invent a container row.

- [ ] **Step 4: Preserve empty and accessibility behavior**

Keep `No managed containers reported.` when the container list is empty. Use the existing worker-specific `idPrefix`, one table caption, explicit `<th scope="col">` headers, and stable container row keys. Omit `Unassigned jobs` when no jobs are unmatched.

- [ ] **Step 5: Run focused tests and verify pass**

Run: `bun test apps/web/src/components/WorkerHealthPanel.test.tsx`

Expected: PASS, including existing usage/cache/loading/error/formatting tests and the new merge cases.

### Task 3: Verify the affected web contract

**Files:**
- Inspect: `apps/web/src/components/WorkerHealthPanel.test.tsx`
- Inspect: `packages/contracts/src/dashboard.ts`

- [ ] **Step 1: Run the web component test set**

Run: `bun test apps/web/src/components`

Expected: PASS with no changes to the `WorkerHealth` schema or API fixtures required.

- [ ] **Step 2: Run the merged-row behavior smoke test**

Run: `bun test apps/web/src/components/WorkerHealthPanel.test.tsx -t "merges each job into its matching managed container"`

Expected: PASS with one rendered row containing both container and job identity, plus explicit unmatched states from the test fixture.

- [ ] **Step 3: Commit the implementation**

```bash
git add apps/web/src/components/WorkerHealthPanel.tsx apps/web/src/components/WorkerHealthPanel.test.tsx
git commit -m "feat(web): merge jobs into containers"
```
