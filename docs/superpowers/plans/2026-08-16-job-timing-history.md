# Job Timing History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist immutable completed-job timing snapshots and expose safe historical comparisons by resource, runtime, and parallelism.

**Architecture:** Add a normalized `dashboard_job_timing_snapshots` table containing one immutable row per dashboard job. Populate it idempotently during terminal/reaped lifecycle handling from the job, run stages, lease, pool, worker, and artifact metadata captured for that execution. Add typed control-plane queries for paginated measurements and grouped percentile aggregates, then render a completed-only Timing History view under Runs.

**Tech Stack:** Bun, TypeScript, Hono, PostgreSQL tagged-template SQL, Zod contracts, React, TanStack Query, existing dashboard pagination and chart primitives, Bun test.

## Global Constraints

- Completed jobs only; queued and active jobs must not appear in timing-history results.
- Store correlation data, not causal claims; every aggregate includes sample count.
- Snapshot effective execution metadata; never derive historical dimensions from current pool/worker settings.
- Duration values are non-negative integer milliseconds.
- Do not store logs, JIT configuration, credentials, or secret-like fields.
- Initial timing retention is 90 days through the existing configurable operational-retention mechanism.
- Preserve Linux-runtime exclusion; this feature does not add Linux execution support.
- Follow existing cursor pagination, organization authorization, Zod DTO, dashboard route, and React Query conventions.

---

### Task 1: Add the immutable timing snapshot schema

**Files:**
- Modify: `packages/db/src/schema.ts:71-93`
- Modify: `packages/db/src/schema.test.ts`
- Modify: the numbered migration/schema test fixture used by the repository’s production-readiness migration flow, if the migration system has split from `schema.ts`

**Interfaces:**
- Produces table `dashboard_job_timing_snapshots` with organization/job uniqueness for later lifecycle and query tasks.

- [ ] **Step 1: Write failing schema assertions**

Add assertions that the schema defines a table with:

```sql
organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
job_id uuid NOT NULL,
run_id uuid NOT NULL,
completed_at timestamptz NOT NULL,
outcome text NOT NULL,
queue_duration_ms bigint NOT NULL CHECK (queue_duration_ms >= 0),
startup_duration_ms bigint NOT NULL CHECK (startup_duration_ms >= 0),
execution_duration_ms bigint NOT NULL CHECK (execution_duration_ms >= 0),
cleanup_duration_ms bigint NOT NULL CHECK (cleanup_duration_ms >= 0),
total_duration_ms bigint NOT NULL CHECK (total_duration_ms >= 0),
vcpu bigint NOT NULL CHECK (vcpu > 0),
concurrency bigint NOT NULL CHECK (concurrency > 0),
UNIQUE (organization_id, job_id)
```

Also assert the table carries resource, runtime, pool, artifact, repository, workflow, and job identity columns and is included in retention configuration.

- [ ] **Step 2: Run the focused schema test and verify failure**

Run:

```bash
bun test packages/db/src/schema.test.ts
```

Expected: FAIL because the timing table and retention registration do not exist.

- [ ] **Step 3: Add the table and indexes**

Add the table after `dashboard_jobs` so its foreign keys can reference `(organization_id, run_id, id)`. Include:

```sql
CREATE TABLE IF NOT EXISTS dashboard_job_timing_snapshots (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  run_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  github_job_id bigint NOT NULL,
  repository_name text NOT NULL,
  workflow_name text NOT NULL,
  job_name text NOT NULL,
  platform text NOT NULL,
  driver text NOT NULL,
  runtime_boundary text,
  pool_id uuid,
  artifact_digest text,
  outcome text NOT NULL,
  completed_at timestamptz NOT NULL,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  queue_duration_ms bigint NOT NULL CHECK (queue_duration_ms >= 0),
  startup_duration_ms bigint NOT NULL CHECK (startup_duration_ms >= 0),
  execution_duration_ms bigint NOT NULL CHECK (execution_duration_ms >= 0),
  cleanup_duration_ms bigint NOT NULL CHECK (cleanup_duration_ms >= 0),
  total_duration_ms bigint NOT NULL CHECK (total_duration_ms >= 0),
  requested_vcpu bigint NOT NULL CHECK (requested_vcpu > 0),
  requested_memory_bytes bigint NOT NULL CHECK (requested_memory_bytes > 0),
  requested_storage_bytes bigint NOT NULL CHECK (requested_storage_bytes > 0),
  requested_concurrency bigint NOT NULL CHECK (requested_concurrency > 0),
  observed_vcpu bigint,
  observed_memory_bytes bigint,
  observed_storage_bytes bigint,
  effective_concurrency bigint NOT NULL CHECK (effective_concurrency > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, job_id),
  FOREIGN KEY (organization_id, run_id, job_id) REFERENCES dashboard_jobs(organization_id, run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, run_id) REFERENCES dashboard_runs(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS dashboard_job_timing_completed_idx
  ON dashboard_job_timing_snapshots(organization_id, completed_at DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS dashboard_job_timing_dimensions_idx
  ON dashboard_job_timing_snapshots(organization_id, platform, driver, requested_vcpu, effective_concurrency, completed_at DESC);
```

Use the repository's current schema-file migration convention in `packages/db/src/schema.ts`; do not introduce a parallel migration mechanism. Add the exact schema assertions used by current migration changes.

- [ ] **Step 4: Register 90-day retention**

Extend the retention configuration with a timing-specific environment override named `MARS_RETENTION_JOB_TIMINGS_DAYS`, defaulting to `90`, and delete only rows whose jobs are terminal and whose `completed_at` is older than the cutoff. Use bounded batches and report deleted rows/failures using existing pruner telemetry.

- [ ] **Step 5: Run focused schema tests**

Run:

```bash
bun test packages/db/src/schema.test.ts packages/db/src/retention.test.ts
```

Expected: PASS, including table constraints, indexes, and retention registration.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/src/retention.ts packages/db/src/retention.test.ts
 git commit -m "feat: add job timing snapshot schema"
```

---

### Task 2: Define timing contracts and snapshot persistence

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Create or modify: `packages/db/src/job-timing.ts`
- Create or modify: `packages/db/src/job-timing.test.ts`
- Modify: `packages/db/src/index.ts` if it is the package export barrel

**Interfaces:**
- Produces `JobTimingSnapshot`, `JobTimingHistoryQuery`, `JobTimingAggregate`, and `recordJobTimingSnapshot(db, input)`.
- `recordJobTimingSnapshot` performs one `INSERT ... ON CONFLICT (organization_id, job_id) DO NOTHING` and returns whether it inserted a row.

- [ ] **Step 1: Write failing contract and persistence tests**

Test that:

```ts
const input = {
  organizationId: "org-1",
  jobId: "job-1",
  runId: "run-1",
  outcome: "success",
  queueDurationMs: 1000,
  startupDurationMs: 2000,
  executionDurationMs: 5000,
  cleanupDurationMs: 300,
  totalDurationMs: 8300,
  requested: { vcpu: 2, memoryBytes: 1024, storageBytes: 2048, concurrency: 3 },
  effectiveConcurrency: 3,
};
```

parses, negative durations fail, secret-like keys fail, and a second persistence call emits `ON CONFLICT ... DO NOTHING` rather than a duplicate insert.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun test packages/db/src/job-timing.test.ts packages/contracts/src/dashboard.test.ts
```

Expected: FAIL because timing DTOs and persistence do not exist.

- [ ] **Step 3: Add strict Zod DTOs**

Add strict DTOs with timestamp validation, non-negative duration fields, positive resource fields, nullable observed resources, enum outcome, and explicit dimension fields. Ensure the existing `dto()` secret-key refinement applies to every public timing contract.

- [ ] **Step 4: Implement idempotent persistence**

Implement `recordJobTimingSnapshot` with one parameterized SQL insert. The function must reject nonterminal input in its caller-facing type or runtime guard, preserve null startup/observed values where the lifecycle lacks measurements, and never write raw JSON blobs containing configuration or secrets.

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test packages/db/src/job-timing.test.ts packages/contracts/src/dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/dashboard.ts packages/db/src/job-timing.ts packages/db/src/job-timing.test.ts packages/db/src/index.ts
 git commit -m "feat: define job timing contracts"
```

---

### Task 3: Capture one snapshot at terminal job lifecycle

**Files:**
- Modify: `apps/control-plane/src/job-reconciler.ts`
- Modify: `packages/db/src/dashboard.ts` or the existing lifecycle transition module that owns terminal run/job updates
- Modify: `apps/control-plane/src/job-reconciler.test.ts`
- Add or modify: worker/replay integration test covering terminal event processing

**Interfaces:**
- Consumes `recordJobTimingSnapshot` from Task 2.
- Produces exactly one snapshot after completed/failed/cancelled job cleanup, retaining the pool/worker/resource metadata used by the lease rather than querying current pool settings.

- [ ] **Step 1: Write failing lifecycle tests**

Create a fake DB with a job, run stage timestamps, lease cleanup timestamps, pool resources, worker-observed resources, runtime driver, and artifact digest. Assert terminal processing inserts:

```ts
expect(snapshot).toMatchObject({
  requestedVcpu: 2,
  effectiveConcurrency: 3,
  executionDurationMs: 5000,
  platform: "windows-x64",
  driver: "windows-hyperv-container",
  artifactDigest: "sha256:test",
});
```

Invoke the same terminal event twice and assert one insert. Invoke a queued/running event and assert zero inserts.

- [ ] **Step 2: Run the focused lifecycle tests and verify failure**

Run:

```bash
bun test apps/control-plane/src/job-reconciler.test.ts tests/job-timing-lifecycle.test.ts
```

Expected: FAIL because terminal processing does not call snapshot persistence.

- [ ] **Step 3: Compute durations from authoritative timestamps**

Add a pure helper with this signature:

```ts
type TimingInputs = {
  queuedAt: string;
  startedAt: string | null;
  completedAt: string;
  allocationStartedAt: string | null;
  sandboxReadyAt: string | null;
  reapingStartedAt: string | null;
  reapedAt: string | null;
};

type TimingDurations = {
  queueDurationMs: number;
  startupDurationMs: number;
  executionDurationMs: number;
  cleanupDurationMs: number;
  totalDurationMs: number;
};
```

Use clamped non-negative differences. Treat missing optional boundaries as zero for the corresponding phase, but require queued and completed timestamps. Do not calculate a duration from `Date.now()` for a historical snapshot.

- [ ] **Step 4: Wire snapshot insertion after terminal/reaped state transition**

Load the lease’s captured requested/effective resources, pool driver/platform/artifact identity, and stage timestamps in the same transaction or lifecycle operation that marks cleanup complete. Call `recordJobTimingSnapshot`; ignore a false “already inserted” result. Keep terminal state success independent from analytics insertion only if the existing transaction boundary cannot include the snapshot, and emit a structured failure for retry/reconciliation.

- [ ] **Step 5: Run focused lifecycle tests**

Run:

```bash
bun test apps/control-plane/src/job-reconciler.test.ts tests/job-timing-lifecycle.test.ts tests/job-pickup.e2e.test.ts
```

Expected: PASS with one snapshot across duplicate/replayed terminal events.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/job-reconciler.ts packages/db/src/dashboard.ts apps/control-plane/src/job-reconciler.test.ts tests/job-timing-lifecycle.test.ts
 git commit -m "feat: record completed job timings"
```

---

### Task 4: Add history queries, aggregates, and authorized HTTP routes

**Files:**
- Modify: `packages/db/src/job-timing.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/http/dashboard-api.test.ts`
- Modify: `packages/contracts/src/dashboard.ts` if query/response contracts need co-location

**Interfaces:**
- Produces `listJobTimingHistory(db, organizationId, query): Promise<CursorPage<JobTimingSnapshot>>`.
- Produces `getJobTimingAggregates(db, organizationId, query): Promise<JobTimingAggregate[]>`.
- Adds `GET /api/organizations/:organizationId/job-timings` and `GET /api/organizations/:organizationId/job-timings/aggregates`.

- [ ] **Step 1: Write failing route/query tests**

Cover:

```ts
GET /api/organizations/org-1/job-timings?limit=25&platform=windows-x64&vcpu=2&concurrency=3
GET /api/organizations/org-1/job-timings/aggregates?groupBy=day,vcpu&metric=execution
```

Assert organization authorization, completed-only SQL predicates, cursor pagination, dimension filters, sample counts, p50/p95, min/max, empty result shape, and rejection of invalid negative limits/resource values.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun test apps/control-plane/src/http/dashboard-api.test.ts packages/db/src/job-timing.test.ts
```

Expected: FAIL because routes and query functions do not exist.

- [ ] **Step 3: Implement parameterized filtered history query**

Use the existing cursor convention: order by `completed_at DESC, job_id DESC`, fetch `limit + 1`, and return the last visible `(completed_at, job_id)` as the cursor. Apply every filter through tagged SQL parameters. Always filter terminal snapshots; never join mutable pool rows for historical dimensions.

- [ ] **Step 4: Implement aggregate query**

Support `groupBy` values `day`, `repository`, `workflow`, `platform`, `driver`, `vcpu`, and `concurrency`; support metrics `queue`, `startup`, `execution`, `cleanup`, and `total`. Return count, min, max, `percentile_cont(0.5)`, and `percentile_cont(0.95)` with integer millisecond normalization. Reject unknown groupings/metrics with a stable 400 error.

- [ ] **Step 5: Register authorized routes**

Reuse existing dashboard organization membership/global-admin authorization middleware and existing JSON error shape. Parse query parameters with Zod before database access. Keep response DTOs strict and secret-rejecting.

- [ ] **Step 6: Run focused API tests**

Run:

```bash
bun test apps/control-plane/src/http/dashboard-api.test.ts packages/db/src/job-timing.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/job-timing.ts packages/contracts/src/dashboard.ts apps/control-plane/src/http/dashboard-routes.ts apps/control-plane/src/http/dashboard-api.test.ts
 git commit -m "feat: expose job timing history api"
```

---

### Task 5: Add web API client and Timing History view

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/components/TimingHistory.tsx`
- Create: `apps/web/src/components/TimingHistory.test.tsx`
- Create: `apps/web/src/routes/TimingHistoryPage.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/routes/RunsPage.tsx` or the existing Runs navigation component
- Modify: `apps/web/src/styles.css` or the established component stylesheet

**Interfaces:**
- Consumes the Task 4 DTOs and endpoints.
- Produces a `/runs/timing` route and a `TimingHistory` component that renders completed measurements and aggregates without implying causation.

- [ ] **Step 1: Write failing component tests**

Render representative data and assert:

```tsx
expect(screen.getByText("Completed job timing history")).toBeVisible();
expect(screen.getByText(/12 samples/)).toBeVisible();
expect(screen.getByText(/Correlation only/)).toBeVisible();
expect(screen.queryByText("queued")).not.toBeInTheDocument();
```

Also test empty state, low-sample state, metric selection, vCPU/concurrency filters, and visible labels for queue/execution/cleanup/total.

- [ ] **Step 2: Run focused web tests and verify failure**

Run:

```bash
bun test apps/web/src/components/TimingHistory.test.tsx
```

Expected: FAIL because the route/component does not exist.

- [ ] **Step 3: Add typed API client functions**

Implement:

```ts
export function getJobTimingHistory(
  organizationId: string,
  params: { cursor?: string | null; from?: string; to?: string; repositoryId?: string; workflow?: string; jobName?: string; platform?: string; driver?: string; vcpu?: number; concurrency?: number; outcome?: string; limit?: number }
): Promise<CursorPage<JobTimingSnapshot>>;

export function getJobTimingAggregates(
  organizationId: string,
  params: { from?: string; to?: string; groupBy: string[]; metric: "queue" | "startup" | "execution" | "cleanup" | "total"; platform?: string; vcpu?: number; concurrency?: number }
): Promise<JobTimingAggregate[]>;
```

Validate both responses with the imported Zod contracts.

- [ ] **Step 4: Implement the view with existing dashboard patterns**

Use TanStack Query for filters and `useInfiniteQuery` for the measurement list. Render a trend/grouped comparison table with count, median, p95, min, and max. Add explicit `aria-label`s for metric and dimension controls. Keep copy neutral: “Compared timing” and “Correlation only; not causal evidence.”

- [ ] **Step 5: Add route and Runs entry point**

Register `/runs/timing` beside `/runs` and `/runs/$runId`, preserving the current organization selection/search conventions. Add a clear link from Runs without changing existing run filters or detail links.

- [ ] **Step 6: Run focused web tests**

Run:

```bash
bun test apps/web/src/components/TimingHistory.test.tsx apps/web/src/components/RunHistory.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/components/TimingHistory.tsx apps/web/src/components/TimingHistory.test.tsx apps/web/src/routes/TimingHistoryPage.tsx apps/web/src/router.tsx apps/web/src/routes/RunsPage.tsx apps/web/src/styles.css
 git commit -m "feat: add timing history dashboard"
```

---

### Task 6: Run end-to-end verification and production-readiness checks

**Files:**
- Modify: affected test fixtures only when the preceding tasks reveal contract fixture gaps.
- Modify: `IMPLEMENTATION-STATUS.md` if repository workflow requires status updates.

**Interfaces:**
- Verifies the complete schema → lifecycle → API → web flow without changing feature behavior.

- [ ] **Step 1: Run focused backend and frontend suites**

```bash
bun test packages/db/src/schema.test.ts packages/db/src/job-timing.test.ts apps/control-plane/src/job-reconciler.test.ts apps/control-plane/src/http/dashboard-api.test.ts apps/web/src/components/TimingHistory.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the repository typecheck/build command**

```bash
bun run typecheck
bun run build
```

Expected: PASS with the new DTOs, route handlers, and web route included in generated output.

- [ ] **Step 3: Smoke the actual dashboard route**

Start the existing development stack through the repository’s documented command, open `/runs/timing`, and verify:

- completed samples load;
- filters update both chart/table and list;
- sample counts remain visible;
- empty and low-sample states render;
- queued/running jobs do not appear;
- no same-origin API or asset request fails;
- no uncaught console errors occur.

- [ ] **Step 4: Run retention and replay checks**

Run the retention test with the default and overridden `MARS_RETENTION_JOB_TIMINGS_DAYS`, then run the terminal replay integration test. Expected: old eligible snapshots are deleted in bounded batches and duplicate terminal events leave one snapshot.


Do not commit generated build output or unrelated production-readiness changes.

---

## Self-review checklist

- Schema fields, retention, lifecycle insertion, API filters/aggregates, UI controls, completed-only semantics, and replay safety each have explicit tasks.
- No task relies on a mutable pool/worker row to interpret historical data.
- Percentiles include sample counts and are not presented as causal conclusions.
- All named interfaces are defined before later tasks consume them.
- Every implementation step names concrete files, interfaces, validation, and expected evidence.
