# Centralized Capacity-Aware Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep control-plane job assignment centralized while treating full-worker responses as quiet queue backpressure instead of repeated failures.

**Architecture:** The control plane continues discovering GitHub jobs, selecting candidates, reserving leases, generating JIT credentials, and dispatching leases. Preliminary scheduler checks remain advisory; the transactional database reservation remains authoritative. Capacity exhaustion becomes a deferred reconciliation result, while unexpected reservation/JIT/dispatch errors remain failures.

**Tech Stack:** Bun, TypeScript, PostgreSQL tagged-template queries, Bun test.

## Global Constraints

- Workers do not poll or request jobs.
- The control plane remains the sole job assigner.
- `packages/db/src/leases.ts` remains the authoritative transactional capacity gate.
- A capacity-deferred job remains queued and is retried by existing reconciliation.
- Do not weaken label, runtime, worker-limit, pool-limit, or active-lease checks.
- Do not alter heartbeat or worker websocket ownership.

---

### Task 1: Classify capacity exhaustion as deferred

**Files:**
- Modify: `apps/control-plane/src/reconcile.ts:25-87`
- Test: `apps/control-plane/src/reconcile.test.ts`

**Interfaces:**
- Consumes existing `reserve`, `jit`, `dispatch`, and optional `release` callbacks.
- Produces `ReconcileReport` with explicit `deferred` count: `{ reserved: number; deferred: number; skipped: number; failed: number }`.

- [ ] **Step 1: Write the failing tests**

Add tests covering the observable distinction:

```ts
test("defers worker capacity exhaustion without counting it as failure", async () => {
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 1, repository: "acme/repo", runId: 1, jobId: 1, labels: ["mars-windows-x64", "4VCPU", "15G"] }],
    candidates: [candidate],
    reserve: async () => { throw new Error("worker_capacity_exhausted"); },
    jit: async () => { throw new Error("must not run"); },
    dispatch: async () => { throw new Error("must not run"); },
  });
  expect(result).toEqual({ reserved: 0, deferred: 1, skipped: 0, failed: 0 });
});

test("keeps unexpected reservation errors as failures", async () => {
  const result = await reconcileQueuedJobs({
    queued: [{ installationId: 1, repositoryId: 1, repository: "acme/repo", runId: 1, jobId: 1, labels: ["mars-windows-x64"] }],
    candidates: [candidate],
    reserve: async () => { throw new Error("database unavailable"); },
    jit: async () => { throw new Error("must not run"); },
    dispatch: async () => { throw new Error("must not run"); },
  });
  expect(result).toEqual({ reserved: 0, deferred: 0, skipped: 0, failed: 1 });
});
```
Use the existing test helper for a ready Windows candidate and preserve its exact resource fields.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```text
bun test apps/control-plane/src/reconcile.test.ts
```

Expected: the new capacity test fails because the current report has no `deferred` field and increments `failed`.

- [ ] **Step 3: Implement minimal classification**

In the `catch` block in `reconcileQueuedJobs`, derive the message once. Before logging or incrementing `failed`, handle the exact expected capacity error:

```ts
const message = error instanceof Error ? error.message : "unknown";
if (message === "worker_capacity_exhausted") {
  report.deferred += 1;
  continue;
}
console.error(`Reconcile job ${queued.jobId} failed: ${message}`);
report.failed += 1;
```

Initialize `deferred: 0` in the report type and value. Do not release a reservation for this branch because the capacity error occurs before insertion; preserve the existing release path for errors after a reservation exists.

- [ ] **Step 4: Run focused tests**

Run:

```text
bun test apps/control-plane/src/reconcile.test.ts
```

Expected: all tests pass, including successful dispatch, JIT failure, duplicate claim, capacity deferral, and unexpected failure cases.

- [ ] **Step 5: Commit**

```text
git add apps/control-plane/src/reconcile.ts apps/control-plane/src/reconcile.test.ts
git commit -m "fix: defer full worker jobs"
```

### Task 2: Make reconciliation reporting quiet and actionable

**Files:**
- Modify: `apps/control-plane/src/index.ts:247-248`
- Modify: `apps/control-plane/src/reconcile.ts:76-85`
- Test: `apps/control-plane/src/reconcile-loop.test.ts` or `apps/control-plane/src/index.test.ts`, following the existing logging-test pattern if present

**Interfaces:**
- Consumes `ReconcileReport.deferred` from Task 1.
- Produces aggregate logging only for successful assignments, deferred counts when useful, and unexpected failures.

- [ ] **Step 1: Add the logging contract test**

Exercise the report/logging helper or the smallest existing reconciliation entry point and assert that a report containing only deferred jobs does not emit per-job failure output. Assert that a report with `failed > 0` remains visible. If the existing test harness cannot capture the long-running index loop, extract a pure formatter:

```ts
export function reconciliationLog(report: ReconcileReport): string | null {
  if (!report.reserved && !report.failed) return null;
  return `Job reconciliation tick: reserved=${report.reserved} failed=${report.failed} skipped=${report.skipped}`;
}
```

The deferred count need not be logged for every tick; it must not create per-job noise.

- [ ] **Step 2: Run the focused test to verify failure**

Run:

```text
bun test apps/control-plane/src/reconcile-loop.test.ts
```

Expected: the new assertion fails until the report shape/logging path is updated.

- [ ] **Step 3: Update aggregate logging**

Keep the existing quiet behavior for normal deferred work. Update the reconciliation tick condition to avoid a log when `reserved === 0`, `failed === 0`, and `deferred > 0`. Preserve error logging for unexpected failures and existing lease cleanup logs.

Do not reintroduce per-job `No routing candidate` output. Do not log every queued-job retry.

- [ ] **Step 4: Run focused tests**

Run:

```text
bun test apps/control-plane/src/reconcile.test.ts apps/control-plane/src/reconcile-loop.test.ts
```

Expected: pass with no repeated capacity-error logging contract failures.

- [ ] **Step 5: Commit**

```text
git add apps/control-plane/src/index.ts apps/control-plane/src/reconcile.ts apps/control-plane/src/reconcile-loop.test.ts
 git commit -m "fix: quiet deferred reconciliation"
```

### Task 3: Verify capacity recovery and preserve assignment ownership

**Files:**
- Modify: `apps/control-plane/src/reconcile.test.ts`
- Test: `packages/db/src/leases.test.ts`
- Test: `apps/control-plane/src/job-reconciler.test.ts`

**Interfaces:**
- Consumes existing candidate snapshots and `reserveRoutingSlot` capacity checks.
- Produces regression evidence that a later reconciliation assigns work after capacity is available and workers never initiate assignment.

- [ ] **Step 1: Add recovery and ownership tests**

Add a deterministic test where the first `reserve` call throws `worker_capacity_exhausted`, the second succeeds, and two reconciliation invocations produce first `{ deferred: 1 }` and then `{ reserved: 1 }`.

Add/retain the database lease test asserting that insufficient `doctor.capacity.freeVcpu` or `freeMemoryBytes` throws `worker_capacity_exhausted`. Do not alter the SQL guard.

Add/retain the job-reconciler test asserting that the control plane invokes `reserve`, `jit`, and `dispatch` for an eligible queued job; no worker-pull frame or endpoint should be introduced.

- [ ] **Step 2: Run tests to verify the new recovery contract**

Run:

```text
bun test apps/control-plane/src/reconcile.test.ts apps/control-plane/src/job-reconciler.test.ts packages/db/src/leases.test.ts
```

Expected: recovery, transactional capacity rejection, and centralized assignment tests pass.

- [ ] **Step 3: Make only required corrections**

If a test exposes a real mismatch, correct the scheduler/reconciliation classification without weakening the database capacity check or moving assignment to workers.

- [ ] **Step 4: Run the complete focused verification set**

Run:

```text
bun test apps/control-plane/src/reconcile.test.ts apps/control-plane/src/reconcile-loop.test.ts apps/control-plane/src/job-reconciler.test.ts packages/db/src/leases.test.ts apps/control-plane/src/worker-connection.test.ts apps/control-plane/src/control-plane-gateway.test.ts
```

Expected: all relevant tests pass. Existing unrelated failures must be reported separately rather than hidden.

- [ ] **Step 5: Commit**

```text
git add apps/control-plane/src/reconcile.test.ts apps/control-plane/src/job-reconciler.test.ts packages/db/src/leases.test.ts
git commit -m "test: cover centralized capacity recovery"
```
