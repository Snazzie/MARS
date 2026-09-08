# Bounded Job Dispatch Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow queued reconciliation to dispatch up to the configured pool capacity concurrently instead of processing one job end-to-end before starting the next.

**Architecture:** Keep the reconciliation tick single-flight. Refactor one queued-job attempt into an async worker operation, then run a bounded number of workers over the queued list. Use existing `reservedByPool` accounting and database reservation checks as capacity guards; preserve per-job error accounting and installation rate-limit blocking.

**Tech Stack:** TypeScript, Bun, `bun:test`, PostgreSQL-backed lease reservations.

## Global Constraints

- Reserve a routing slot before requesting GitHub JIT configuration.
- Do not exceed candidate pool capacity during one reconciliation pass.
- Isolate failures to individual jobs.
- Preserve single-flight reconciliation ticks.
- Do not add unbounded concurrency.

---

### Task 1: Add concurrency regression coverage

**Files:**
- Modify: `apps/control-plane/src/reconcile.test.ts`
- Modify: `apps/control-plane/src/reconcile.ts`

**Interfaces:**
- Add an optional `maxConcurrent?: number` field to `ReconcileDeps`.
- `reconcileQueuedJobs` uses that bound to run job attempts concurrently.

- [ ] **Step 1: Write the failing test**

Add a test with three eligible jobs, a candidate pool with `concurrency: 3`, and `maxConcurrent: 3`. Make `preflight` increment an active counter, pause on a shared promise, and assert that all three jobs enter preflight before releasing them. Keep `reserve`, `jit`, and `dispatch` successful and return three distinct reservations. Assert the report is `{ reserved: 3, deferred: 0, skipped: 0, failed: 0 }`.

- [ ] **Step 2: Run the focused test to verify failure**

Run:
```bash
bun test apps/control-plane/src/reconcile.test.ts --test-name-pattern "dispatches three jobs concurrently"
```
Expected: FAIL because the current sequential loop only reaches one paused preflight call.

- [ ] **Step 3: Implement the smallest production change**

Move the current per-job body from `reconcileQueuedJobs` into an async `processQueuedJob` closure/function. Start `Math.min(normalized maxConcurrent, queued.length)` worker loops. Each worker takes the next index and awaits the same per-job operation. Keep `seen`, `reservedByPool`, and `blockedInstallations` shared; reservation selection and accounting must remain synchronous around each awaited reservation, and the database transaction remains authoritative for races.

Use a safe default derived from the largest candidate pool concurrency, with a minimum of one, so existing callers retain bounded behavior without requiring a new argument. Clamp explicit values to at least one.

- [ ] **Step 4: Run the focused test to verify success**

Run:
```bash
bun test apps/control-plane/src/reconcile.test.ts --test-name-pattern "dispatches three jobs concurrently"
```
Expected: PASS.

- [ ] **Step 5: Run the existing reconciliation tests**

Run:
```bash
bun test apps/control-plane/src/reconcile.test.ts
```
Expected: PASS, including capacity, rate-limit, cleanup, and failure behavior.

- [ ] **Step 6: Commit the implementation**

```bash
git add apps/control-plane/src/reconcile.ts apps/control-plane/src/reconcile.test.ts
git commit -m "fix: dispatch queued jobs concurrently"
```
