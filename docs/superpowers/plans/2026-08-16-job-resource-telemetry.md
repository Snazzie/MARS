# Job Resource Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture authenticated per-job CPU and memory samples, aggregate them into completed-job performance history, and display the resulting load metrics.

**Architecture:** Extend the worker event protocol with lease-scoped `job.resource_sample` events emitted every 5 seconds by runtime-specific collectors. Store raw samples in a seven-day table, validate and deduplicate them in the control plane, and calculate CPU/memory aggregates when the existing immutable timing snapshot is created. Extend the timing API/UI with telemetry state, aggregate metrics, and a bounded raw-sample chart.

**Tech Stack:** Bun, TypeScript, Zod, PostgreSQL tagged-template SQL, Hono, React, TanStack Query, existing Windows/Hyper-V/Tart runtime drivers, Bun test.

## Global Constraints

- Workers sample active jobs every 5 seconds.
- Raw samples are retained for 7 days.
- `WHITESMITH_RETENTION_JOB_RESOURCE_SAMPLES_DAYS` defaults to `7`.
- Completed-job aggregates remain in the existing 90-day timing-history window.
- Supported first-release collectors: Windows containers, Hyper-V VMs, and macOS Tart VMs.
- Linux/Kata collection remains excluded.
- Missing telemetry is `unavailable` or `partial`, never zero.
- Collector failures must not fail or terminate a job.
- Samples must be authenticated, lease-scoped, bounded, duplicate-safe, and secret-free.
- CPU utilization is normalized to assigned vCPU and must be within its contract range.
- Diagnostic labels describe correlation, not causation.

---

### Task 1: Extend contracts and database schema

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/schema.test.ts`
- Create: `apps/control-plane/src/retention.test.ts`
- Modify: `apps/control-plane/src/retention.ts`

**Interfaces:**
- Produces `WorkerEventPayload` support for `job.resource_sample`.
- Produces strict `JobResourceSample`, `JobTelemetryState`, and timing aggregate fields.
- Produces `dashboard_job_resource_samples` and raw-sample retention configuration.

- [ ] **Step 1: Write failing contract/schema tests**

Assert valid input such as:

```ts
{
  type: "job.resource_sample",
  payload: {
    jobId: "44444444-4444-4444-8444-444444444444",
    leaseId: "22222222-2222-4222-8222-222222222222",
    occurredAt: "2026-08-16T00:00:05.000Z",
    cpuUsagePercent: 72.5,
    cpuTimeMs: 3625,
    memoryWorkingSetBytes: 1073741824,
    memoryLimitBytes: 2147483648,
  },
}
```

Assert negative values, CPU above the normalized maximum, malformed UUID/timestamp, and secret-like fields fail. Assert timing DTOs accept nullable telemetry aggregates and states `available`, `partial`, and `unavailable`. Assert the schema includes non-negative constraints, sample uniqueness, job/time indexes, and the seven-day retention setting.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
bun test packages/db/src/schema.test.ts packages/contracts/src/orchestration.test.ts
```

Expected: FAIL because the event, DTOs, table, and retention setting do not exist.

- [ ] **Step 3: Add the worker event and dashboard DTOs**

Add a strict payload to `WorkerEventPayload` with UUID identifiers, ISO timestamp, `cpuUsagePercent` in `[0, 100]`, non-negative integer CPU/memory values, and no unbounded fields. Add `JobResourceSample` and extend `JobTimingSnapshot` with nullable telemetry aggregates, `telemetryState`, and `telemetrySampleCount`.

- [ ] **Step 4: Add the raw sample table and migration**

Add to the existing baseline schema and append-only migration convention:

```sql
CREATE TABLE IF NOT EXISTS dashboard_job_resource_samples (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  cpu_usage_percent numeric(5,2) NOT NULL CHECK (cpu_usage_percent >= 0 AND cpu_usage_percent <= 100),
  cpu_time_ms bigint NOT NULL CHECK (cpu_time_ms >= 0),
  memory_working_set_bytes bigint NOT NULL CHECK (memory_working_set_bytes >= 0),
  memory_limit_bytes bigint NOT NULL CHECK (memory_limit_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, job_id, occurred_at),
  FOREIGN KEY (organization_id, run_id, job_id) REFERENCES dashboard_jobs(organization_id, run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (lease_id) REFERENCES runner_leases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS dashboard_job_resource_samples_job_time_idx
  ON dashboard_job_resource_samples(organization_id, job_id, occurred_at);
CREATE INDEX IF NOT EXISTS dashboard_job_resource_samples_retention_idx
  ON dashboard_job_resource_samples(created_at);
```

Extend `dashboard_job_timing_snapshots` with nullable CPU/memory aggregate columns, `telemetry_state` with a check constraint, and `telemetry_sample_count` with a non-negative check.

- [ ] **Step 5: Add seven-day retention**

Extend `RetentionConfig` with `jobResourceSamples: days("JOB_RESOURCE_SAMPLES", 7)` and prune `dashboard_job_resource_samples` by `occurred_at` in the existing scheduler. Return the deleted count under `job_resource_samples`.

- [ ] **Step 6: Run focused tests and commit**

```bash
bun test packages/db/src/schema.test.ts packages/contracts/src/orchestration.test.ts apps/control-plane/src/retention.test.ts
 git add packages/contracts/src/orchestration.ts packages/contracts/src/dashboard.ts packages/db/src/schema.ts packages/db/src/index.ts packages/db/src/schema.test.ts apps/control-plane/src/retention.ts apps/control-plane/src/retention.test.ts
 git commit -m "feat: add job resource telemetry schema"
```

Expected: PASS.

---

### Task 2: Implement sample ingestion and validation

**Files:**
- Create: `packages/db/src/job-resource-telemetry.ts`
- Create: `packages/db/src/job-resource-telemetry.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `apps/control-plane/src/worker-lifecycle.ts`
- Modify: `apps/control-plane/src/worker-lifecycle.test.ts`

**Interfaces:**
- Produces `persistJobResourceSample(db, workerId, event): Promise<"stored" | "duplicate" | "rejected">`.
- Consumes the Task 1 `job.resource_sample` contract.

- [ ] **Step 1: Write failing ingestion tests**

Cover:

```ts
expect(await persistJobResourceSample(db, workerId, validEvent)).toBe("stored");
expect(await persistJobResourceSample(db, workerId, validEvent)).toBe("duplicate");
expect(await persistJobResourceSample(db, otherWorkerId, validEvent)).toBe("rejected");
```

The fake DB must return no row for an unknown/mismatched/terminal lease and must record the `ON CONFLICT (organization_id, job_id, occurred_at) DO NOTHING` insert.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
bun test packages/db/src/job-resource-telemetry.test.ts apps/control-plane/src/worker-lifecycle.test.ts
```

Expected: FAIL because the persistence function and event branch do not exist.

- [ ] **Step 3: Implement lease-scoped persistence**

Parse `WorkerEvent` and `WorkerEventPayload`, query the active lease joined to the dashboard job using `worker_id`, `lease_id`, and `job_id`, reject states outside active execution, reject samples older than the configured maximum event age, and insert the bounded metrics with `ON CONFLICT DO NOTHING`. Return `duplicate` when the insert returns no row but the identity was valid.

- [ ] **Step 4: Route the event before lease lifecycle transitions**

In `handleAuthenticatedWorkerEvent`, branch `job.resource_sample` to `persistJobResourceSample` and return success without mutating lease state. Do not dispatch it as a command event. Invalid or rejected samples must not fail the socket or job.

- [ ] **Step 5: Run focused tests and commit**

```bash
bun test packages/db/src/job-resource-telemetry.test.ts apps/control-plane/src/worker-lifecycle.test.ts
 git add packages/db/src/job-resource-telemetry.ts packages/db/src/job-resource-telemetry.test.ts packages/db/src/index.ts apps/control-plane/src/worker-lifecycle.ts apps/control-plane/src/worker-lifecycle.test.ts
 git commit -m "feat: ingest job resource samples"
```

Expected: PASS.

---

### Task 3: Add runtime-specific five-second collectors

**Files:**
- Modify: `apps/orchestrator/src/runtime.ts`
- Modify: `apps/orchestrator/src/windows-container.ts`
- Modify: `apps/orchestrator/src/hyperv.ts`
- Modify: `apps/orchestrator/src/tart.ts`
- Modify: `apps/orchestrator/src/lease-lifecycle.ts`
- Modify: `apps/orchestrator/src/mac-agent.ts`
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Create or modify: runtime-specific collector tests beside each implementation

**Interfaces:**
- Produces a runtime-neutral collector:

```ts
export type JobResourceSample = {
  cpuUsagePercent: number;
  cpuTimeMs: number;
  memoryWorkingSetBytes: number;
  memoryLimitBytes: number;
};
export type ResourceCollector = {
  sample(): Promise<JobResourceSample>;
  close(): Promise<void>;
};
```

- Produces worker events with `type: "job.resource_sample"` and the lease bootstrap `jobId`/`leaseId`.

- [ ] **Step 1: Write failing collector tests**

Test deterministic counter conversion for each runtime:

- Windows container counters convert cumulative CPU nanoseconds and interval duration into normalized percentage and preserve memory limit.
- Hyper-V VM counters map VM CPU time and memory counters by VM name.
- Tart process/VM counters map the Tart VM identifier and clamp normalized utilization to `[0, 100]`.

Test a sampling loop emits at most one event every 5 seconds and closes when completion resolves.

- [ ] **Step 2: Run focused runtime tests and verify failure**

```bash
bun test apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/hyperv.test.ts apps/orchestrator/src/tart.test.ts apps/orchestrator/src/lease-lifecycle.test.ts
```

Expected: FAIL because resource collectors and sampling loop do not exist.

- [ ] **Step 3: Implement collectors without changing job lifecycle semantics**

Use each runtime’s existing identity and command abstraction. Keep collector errors contained: log a bounded diagnostic and skip that sample. Never throw from sampling into the runner completion path.

- [ ] **Step 4: Emit samples during active execution**

Start the sampler after `sandbox_attested`, stop it on completion/failure/cleanup, and emit through the existing worker event/outbox path. Use the existing event UUID and `occurredAt`. Do not sample before the runtime identity is ready or after terminal cleanup.

- [ ] **Step 5: Run focused runtime tests and commit**

```bash
bun test apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/hyperv.test.ts apps/orchestrator/src/tart.test.ts apps/orchestrator/src/lease-lifecycle.test.ts apps/orchestrator/src/mac-agent.test.ts apps/orchestrator/src/windows-agent.test.ts
 git add apps/orchestrator/src/runtime.ts apps/orchestrator/src/windows-container.ts apps/orchestrator/src/hyperv.ts apps/orchestrator/src/tart.ts apps/orchestrator/src/lease-lifecycle.ts apps/orchestrator/src/mac-agent.ts apps/orchestrator/src/windows-agent.ts
 git commit -m "feat: sample runtime job resources"
```

Expected: PASS.

---

### Task 4: Aggregate telemetry into completed timing snapshots

**Files:**
- Modify: `packages/db/src/job-timing.ts`
- Modify: `packages/db/src/job-timing.test.ts`
- Modify: `apps/control-plane/src/worker-lifecycle.ts`
- Modify: `apps/control-plane/src/worker-lifecycle.test.ts`

**Interfaces:**
- Produces `aggregateJobResourceTelemetry(samples): JobTelemetryAggregate`.
- Extends `recordReapedJobTiming` to write telemetry fields.

- [ ] **Step 1: Write failing aggregation tests**

Use samples with CPU values `[20, 40, 80, 100]` and memory values `[100, 200, 300, 400]`. Assert average, p50, p95, peak, cumulative CPU time, average/peak memory, count, and `available` when the first/last samples are within 10 seconds and gaps are at most 15 seconds. Assert `partial` and `unavailable` cases.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
bun test packages/db/src/job-timing.test.ts apps/control-plane/src/worker-lifecycle.test.ts
```

Expected: FAIL because telemetry fields and aggregation do not exist.

- [ ] **Step 3: Implement deterministic in-process aggregation**

Sort samples by timestamp, calculate arithmetic average, nearest-rank p50/p95, maximum, and CPU-time sum. Apply the exact coverage rule: available requires samples within 10 seconds of execution start and completion and no adjacent gap over 15 seconds; partial means samples exist but fail coverage; unavailable means no valid sample.

- [ ] **Step 4: Query samples during snapshot creation**

Before inserting the timing snapshot, select only samples for the authenticated organization/job/lease and pass them to the pure aggregator. Insert nullable aggregate columns and telemetry state in the same idempotent snapshot write. Keep a missing-sample job successful and mark telemetry unavailable.

- [ ] **Step 5: Run focused tests and commit**

```bash
bun test packages/db/src/job-timing.test.ts apps/control-plane/src/worker-lifecycle.test.ts
 git add packages/db/src/job-timing.ts packages/db/src/job-timing.test.ts apps/control-plane/src/worker-lifecycle.ts apps/control-plane/src/worker-lifecycle.test.ts
 git commit -m "feat: aggregate job resource telemetry"
```

Expected: PASS.

---

### Task 5: Expose raw samples and aggregate telemetry through the API

**Files:**
- Modify: `packages/db/src/job-resource-telemetry.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/http/dashboard-api.test.ts`
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Produces `listJobResourceSamples(db, organizationId, jobId, query): Promise<CursorPage<JobResourceSample>>`.
- Extends timing history responses with telemetry fields.
- Adds `GET /api/organizations/:organizationId/runs/:runId/jobs/:jobId/resource-samples`.

- [ ] **Step 1: Write failing API tests**

Assert organization membership is required, job/run identity is enforced, cursors paginate by `occurred_at`, raw samples cannot exceed the seven-day window, and aggregates include telemetry state/count/CPU/memory values. Test an unavailable job returns null aggregates rather than zero.

- [ ] **Step 2: Run focused API tests and verify failure**

```bash
bun test apps/control-plane/src/http/dashboard-api.test.ts packages/db/src/job-resource-telemetry.test.ts
```

Expected: FAIL because raw sample query and response fields do not exist.

- [ ] **Step 3: Implement bounded sample listing**

Use organization authorization, explicit run/job joins, cursor pagination, `limit + 1`, and a hard maximum of 100 samples per response. Reject cursors outside the job’s sample sequence and dates outside seven days with stable API errors.

- [ ] **Step 4: Extend timing history responses and client functions**

Add telemetry fields to `JobTimingSnapshot` parsing and implement:

```ts
getJobResourceSamples(
  organizationId: string,
  runId: string,
  jobId: string,
  after?: string | null,
  limit?: number,
): Promise<CursorPage<JobResourceSample>>;
```

- [ ] **Step 5: Run focused API tests and commit**

```bash
bun test apps/control-plane/src/http/dashboard-api.test.ts packages/db/src/job-resource-telemetry.test.ts
 git add packages/db/src/job-resource-telemetry.ts apps/control-plane/src/http/dashboard-routes.ts apps/control-plane/src/http/dashboard-api.test.ts apps/web/src/api.ts packages/contracts/src/dashboard.ts
 git commit -m "feat: expose job resource telemetry api"
```

Expected: PASS.

---

### Task 6: Add CPU/memory visibility to Timing History

**Files:**
- Modify: `apps/web/src/routes/TimingHistoryPage.tsx`
- Modify: `apps/web/src/components/TimingHistory.tsx` if the view is split during implementation
- Create or modify: `apps/web/src/routes/TimingHistoryPage.test.tsx`
- Modify: `apps/web/src/styles.css` only for existing dashboard chart/table patterns

**Interfaces:**
- Consumes Task 5 aggregate and raw-sample APIs.
- Produces visible CPU/memory metrics, telemetry state, sample count, and a bounded per-job chart.

- [ ] **Step 1: Write failing UI tests**

Render fixtures for all three states and assert:

```tsx
expect(screen.getByText(/CPU p95/)).toBeVisible();
expect(screen.getByText(/Telemetry: 12 samples/)).toBeVisible();
expect(screen.getByText(/Correlation only/)).toBeVisible();
expect(screen.getByText(/Telemetry unavailable/)).toBeVisible();
```

Assert partial telemetry does not render zero values and diagnostic labels remain neutral.

- [ ] **Step 2: Run focused UI tests and verify failure**

```bash
bun test apps/web/src/routes/TimingHistoryPage.test.tsx
```

Expected: FAIL because CPU/memory metrics and sample chart do not exist.

- [ ] **Step 3: Render aggregate telemetry**

Add CPU average/p50/p95/peak, CPU time, memory average/peak, state, and sample count to the comparison and completed measurement views. Render `Unavailable`/`Partial` explicitly and never substitute zero for null.

- [ ] **Step 4: Add raw sample chart for a selected completed job**

Use the seven-day sample endpoint with a bounded query and existing chart primitives. Include an accessible table fallback or equivalent text summary. Stop querying when the job has no samples or data is older than seven days.

- [ ] **Step 5: Add neutral diagnostic labels**

Only show “Likely CPU-bound” or “Likely wait/I/O-bound” when execution duration and telemetry are present, and include the neutral “correlation only” explanation and sample count.

- [ ] **Step 6: Run focused UI tests and build**

```bash
bun test apps/web/src/routes/TimingHistoryPage.test.tsx
bun run --filter @whitesmith/web typecheck
bun run --filter @whitesmith/web build
 git add apps/web/src/routes/TimingHistoryPage.tsx apps/web/src/routes/TimingHistoryPage.test.tsx apps/web/src/styles.css
 git commit -m "feat: show per-job resource load"
```

Expected: PASS.

---

### Task 7: Verify the complete telemetry path

**Files:**
- Modify: only affected test fixtures required by the new event/DTO fields.

- [ ] **Step 1: Run the complete focused telemetry suite**

```bash
bun test packages/contracts/src/orchestration.test.ts packages/db/src/schema.test.ts packages/db/src/job-resource-telemetry.test.ts packages/db/src/job-timing.test.ts apps/control-plane/src/worker-lifecycle.test.ts apps/control-plane/src/http/dashboard-api.test.ts apps/orchestrator/src/lease-lifecycle.test.ts apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/hyperv.test.ts apps/orchestrator/src/tart.test.ts apps/web/src/routes/TimingHistoryPage.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Verify package typechecks**

```bash
bun run --filter @whitesmith/contracts typecheck
bun run --filter @whitesmith/db typecheck
bun run --filter @whitesmith/web typecheck
bun run --filter @whitesmith/control-plane typecheck
bun run --filter @whitesmith/orchestrator typecheck
```

Expected: no new diagnostics attributable to telemetry. Existing unrelated diagnostics must be recorded rather than hidden.

- [ ] **Step 3: Smoke the actual dashboard**

Start the web/control-plane stack, open `/runs/timing`, select a completed job with samples, and verify CPU/memory metrics, sample count, chart/fallback table, partial/unavailable states, and no failed same-origin requests or uncaught console errors.

- [ ] **Step 4: Verify retention and replay**

Run the retention test with default and overridden `WHITESMITH_RETENTION_JOB_RESOURCE_SAMPLES_DAYS`; deliver the same sample event twice and assert one row; deliver samples out of order and assert aggregate sorting; complete a job with no samples and assert telemetry remains unavailable.

- [ ] **Step 5: Commit only test fixture corrections**

Include fixture corrections in the task that exposed them; do not add generated build output or unrelated production-readiness changes.

## Self-review checklist

- Worker event, runtime collectors, storage/retention, ingestion validation, aggregation, API, UI, and verification each have explicit tasks.
- Exact sample interval, retention window, bounds, coverage thresholds, telemetry states, and missing-data semantics are defined.
- Later task interfaces match earlier task outputs.
- No raw samples are retained beyond seven days, and no secrets/logs enter telemetry storage.
