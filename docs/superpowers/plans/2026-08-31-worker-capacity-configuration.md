# Worker Capacity Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow worker configuration to describe total available capacity while keeping current-capacity admission and overcommit prevention in dispatch.

**Architecture:** Remove the configuration-time comparison against `doctor.capacity.free*`; configuration persists schema-valid administrator policy and appliance limits. Keep `reserveRoutingSlot` as the serialized dispatch admission boundary, where active leases, configured per-job ceilings, pool/organization limits, concurrency, and current free telemetry are checked before reservation.

**Tech Stack:** Bun, TypeScript, PostgreSQL tagged SQL, Zod, Bun test.

## Global Constraints

- Configuration MUST NOT compare appliance resources with `doctor.capacity.freeVcpu`, `freeMemoryBytes`, or `freeStorageBytes`.
- `workers.limits` MUST continue to enforce per-job CPU, memory, storage, and concurrency ceilings.
- Dispatch reservation MUST continue to prevent overcommit using active leases and current worker capacity.
- Capacity-exhausted jobs MUST remain deferrable through the existing `worker_capacity_exhausted` path.
- Do not add database columns, change telemetry units, or alter runtime provisioning.

---

### Task 1: Remove transient capacity rejection from worker configuration

**Files:**
- Modify: `apps/control-plane/src/worker-requests.ts:105-118`
- Test: `apps/control-plane/src/worker-requests.persistence.test.ts:97-106`

**Interfaces:**
- Consumes: Existing `configurePendingWorker(db, workerId, configuration, adminId, dispatcher?, idempotencyKey?)`.
- Produces: Configuration persistence that succeeds when current free telemetry is below configured appliance capacity.

- [ ] **Step 1: Write the failing regression test**

Extend the existing `accepts independent per-job ceilings without multiplying by concurrency` test so the fake worker reports lower current capacity than the submitted appliance capacity, for example:

```ts
const tx = (strings: TemplateStringsArray) => {
  const sql = strings.join(" ");
  if (sql.includes("select id, doctor")) return [{
    id: "worker",
    doctor: { capacity: { freeVcpu: 1, freeMemoryBytes: 1, freeStorageBytes: 1 } },
    admissionState: "pending",
    platform: "macos-arm64",
    guestPlatforms: ["macos-arm64"],
    draining: false,
  }];
  return [];
};
const configuration = {
  appliance: { vcpu: 4, memoryBytes: 4 * 1024 ** 3, storageBytes: 30 * 1024 ** 3 },
  runtime: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 4 * 1024 ** 3, maxStorageBytesPerPod: 30 * 1024 ** 3, maxConcurrentPods: 10 },
};
await expect(configurePendingWorker(db, "worker", configuration, "admin"))
  .resolves.toMatchObject({ revision: expect.any(String), fingerprint: expect.any(String), commandId: expect.any(String) });
```

- [ ] **Step 2: Run the focused test and verify the old behavior fails**

Run:

```bash
bun test apps/control-plane/src/worker-requests.persistence.test.ts
```

Expected: the new regression test fails with `worker configuration exceeds capacity` before the update/command is persisted.

- [ ] **Step 3: Remove only the configuration-time free-capacity check**

In `configurePendingWorker`, delete the `telemetry`/`capacity` extraction used solely for the check and delete this condition:

```ts
if (parsed.appliance.vcpu > (capacity.freeVcpu ?? 0) || parsed.appliance.memoryBytes > (capacity.freeMemoryBytes ?? 0) || parsed.appliance.storageBytes > (capacity.freeStorageBytes ?? 0)) {
  throw new Error("worker configuration exceeds capacity");
}
```

Leave the worker row query, draining/platform checks, configuration update, command insert, audit insert, and idempotency behavior unchanged.

- [ ] **Step 4: Run the focused regression test**

Run:

```bash
bun test apps/control-plane/src/worker-requests.persistence.test.ts
```

Expected: PASS, including the lower-free-capacity configuration case and existing configuration persistence cases.

- [ ] **Step 5: Commit the source and test change**

```bash
git add apps/control-plane/src/worker-requests.ts apps/control-plane/src/worker-requests.persistence.test.ts
git commit -m "fix: separate worker config from current capacity"
```

### Task 2: Verify dispatch still enforces current capacity

**Files:**
- Inspect: `packages/db/src/leases.ts:20-50`
- Test: `packages/db/src/leases.test.ts`
- Inspect: `apps/control-plane/src/reconcile.ts:43-89`
- Test: `apps/control-plane/src/reconcile.test.ts:109-131`

**Interfaces:**
- Consumes: Existing `reserveRoutingSlot` and reconciler error handling.
- Produces: Evidence that dispatch remains the current-capacity gate; no production change expected unless an existing assertion is missing.

- [ ] **Step 1: Identify the existing reservation test covering `worker_capacity_exhausted`**

Read `packages/db/src/leases.test.ts` and locate the test that exercises the worker capacity branch in `reserveRoutingSlot`. Confirm it asserts the error string `worker_capacity_exhausted` when current capacity is insufficient.

- [ ] **Step 2: Run reservation and reconciliation tests**

Run:

```bash
bun test packages/db/src/leases.test.ts apps/control-plane/src/reconcile.test.ts
```

Expected: PASS, demonstrating that dispatch still checks current worker capacity and the reconciler defers capacity exhaustion.

- [ ] **Step 3: Add one aggregate-resource assertion only if uncovered**

If reservation tests do not cover active resource sums, add a focused case that creates an active lease whose requested CPU/memory/storage consumes the worker’s reported free capacity, then asserts a new request rejects with `worker_capacity_exhausted`. Do not alter `reserveRoutingSlot`; its existing query at lines 39-42 is the required enforcement boundary.

- [ ] **Step 4: Run the focused dispatch tests again**

Run:

```bash
bun test packages/db/src/leases.test.ts apps/control-plane/src/reconcile.test.ts
```

Expected: PASS with current-capacity rejection and deferred reconciliation behavior intact.

- [ ] **Step 5: Commit any coverage-only test change**

```bash
git add packages/db/src/leases.test.ts apps/control-plane/src/reconcile.test.ts
git commit -m "test: preserve dispatch capacity admission"
```

Only create this commit if Step 3 added a test.

### Task 3: Run the complete affected verification

**Files:**
- Test: `apps/control-plane/src/worker-requests.persistence.test.ts`
- Test: `packages/db/src/leases.test.ts`
- Test: `apps/control-plane/src/reconcile.test.ts`

- [ ] **Step 1: Run all affected tests together**

```bash
bun test apps/control-plane/src/worker-requests.persistence.test.ts packages/db/src/leases.test.ts apps/control-plane/src/reconcile.test.ts
```

Expected: PASS with configuration independent of transient free capacity and dispatch still capacity-aware.

- [ ] **Step 2: Inspect the final diff for scope**

```bash
git diff HEAD~1 -- apps/control-plane/src/worker-requests.ts apps/control-plane/src/worker-requests.persistence.test.ts packages/db/src/leases.test.ts apps/control-plane/src/reconcile.test.ts
```

Confirm no telemetry schema, database migration, runtime provisioning, or unrelated API behavior changed.

- [ ] **Step 3: Push completed changes to `main`**

```bash
git push origin main
```

Expected: the committed capacity-boundary change is available on `main`.
