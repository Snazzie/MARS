# Worker Cache and Health Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an expandable live-health view to each worker card showing cache health, current jobs, and system usage.

**Architecture:** Add a strict `WorkerHealth` contract and a read-only global-admin endpoint backed by one worker-health query plus active lease/job joins. The frontend keeps the existing worker query for configuration and polls the new endpoint only while the Live health section is expanded. Current connection state comes from the authenticated socket map; active jobs come from active lease states, not stale heartbeat data.

**Tech Stack:** Bun, TypeScript, Hono, Zod contracts, PostgreSQL tagged SQL, React, TanStack Query, Bun tests, browser smoke verification.

## Global Constraints

- Preserve existing worker adoption, configuration, drain, resume, removal, and image-build behavior.
- Use decimal strings for byte counts; never coerce 64-bit byte values through unsafe JavaScript numbers.
- Require global-admin authorization for worker health data.
- Do not expose credentials, authenticated proxy URLs, cache keys, signed URLs, or certificates.
- Treat the in-memory authenticated socket map as authoritative for connection state.
- Return stale/null telemetry fields in successful responses; reserve HTTP errors for authorization and unknown workers.
- Follow existing strict Zod DTO and `request()` API-client patterns.

---

### Task 1: Define the worker health contract

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Test: `packages/contracts/src/dashboard-api.test.ts`

**Interfaces:**
- Produces: `WorkerHealth`, `WorkerHealthUsage`, `WorkerHealthConnection`, `WorkerHealthCache`, and `WorkerHealthJob` schemas/types consumed by the database, HTTP route, API client, and React component.

- [ ] **Step 1: Write failing contract tests**

Add cases proving:

```ts
expect(WorkerHealth.safeParse(validHealth).success).toBe(true);
expect(WorkerHealth.safeParse({ ...validHealth, usage: { ...validHealth.usage, memoryBytes: { actual: 9007199254740993 } } }).success).toBe(false);
expect(WorkerHealth.safeParse({ ...validHealth, jobs: [{ ...validHealth.jobs[0], requested: { ...validHealth.jobs[0].requested, storageBytes: "9007199254740993" } }] }).success).toBe(true);
expect(WorkerHealth.safeParse({ ...validHealth, cache: { ...validHealth.cache, proxyOrigin: "http://user:secret@host:3128" } }).success).toBe(false);
```

Use real valid UUID/timestamp fixtures and include null GitHub metadata, null telemetry timestamps, and a large decimal byte string.

- [ ] **Step 2: Run the focused contract test**

Run:

```bash
bun test packages/contracts/src/dashboard.test.ts
```

Expected: FAIL because the `WorkerHealth` schemas do not exist.

- [ ] **Step 3: Implement strict schemas**

Add schemas with these fields:

```ts
WorkerHealth = {
  observedAt: timestamp.nullable(),
  connection: {
    state: ConnectionState,
    lastHeartbeatAt: timestamp.nullable(),
    lastDoctorAt: timestamp.nullable(),
    heartbeatAgeSeconds: nonnegativeSafe.nullable(),
    doctorAgeSeconds: nonnegativeSafe.nullable()
  },
  usage: {
    cpu: { actual: nonnegativeSafe, reserved: nonnegativeSafe, free: nonnegativeSafe },
    memoryBytes: { actual: decimalString, reserved: decimalString, free: decimalString },
    storageBytes: { actual: decimalString, reserved: decimalString, free: decimalString },
    pods: { actual: nonnegativeSafe, reserved: nonnegativeSafe, free: nonnegativeSafe }
  },
  cache: {
    desiredTtlSeconds: positiveSafe,
    effectiveTtlSeconds: positiveSafe.nullable(),
    ready: z.boolean(),
    generation: id.nullable(),
    sizeBytes: decimalString,
    entryCount: nonnegativeSafe,
    observedAt: timestamp.nullable(),
    error: z.string().max(1000).nullable()
  },
  jobs: z.array(WorkerHealthJob)
}
```

Define `WorkerHealthJob` with nullable `jobId`, repository/name fields, lease ID, nonempty lease state, nullable `startedAt`/`ageSeconds`, and decimal-string byte fields.

- [ ] **Step 4: Run the focused contract test**

Run:

```bash
bun test packages/contracts/src/dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the contract change**

```bash
git add packages/contracts/src/dashboard.ts packages/contracts/src/dashboard.test.ts
git commit -m "feat(contracts): add worker health DTO"
```

---

### Task 2: Add database projection for worker health

**Files:**
- Modify: `packages/db/src/dashboard.ts`
- Test: `packages/db/src/dashboard.test.ts`

**Interfaces:**
- Consumes: `WorkerHealth` schemas from Task 1.
- Produces: `getWorkerHealth(db, workerId, workerConnected)` returning `WorkerHealth | null`.

- [ ] **Step 1: Write failing database projection tests**

Add a fake database test where the worker query returns:

- adopted worker data;
- nested `doctor.capacity` and `doctor` readiness data;
- desired cache TTL from `desired_configuration`;
- cache status with generation, effective TTL, size, entry count, observed timestamp, and error;
- four active leases, one with dashboard job/repository metadata and one without.

Assert the returned DTO contains all rows, preserves byte strings exactly, maps connection state from `workerConnected`, and omits terminal leases. Add a missing-worker case that returns `null`.

- [ ] **Step 2: Run the focused database test**

Run:

```bash
bun test packages/db/src/dashboard.test.ts
```

Expected: FAIL because `getWorkerHealth` does not exist.

- [ ] **Step 3: Implement the projection**

Add `getWorkerHealth` beside the existing worker detail functions. Use a transaction or separate read queries consistent with the existing dashboard DB layer:

1. Select the worker by ID with heartbeat, doctor, desired configuration, and identity fields.
2. Return `null` if absent.
3. Select `worker_cache_status` for the worker, defaulting cache fields to safe null/zero values when no row exists.
4. Select active `runner_leases` using states `reserved`, `requested`, `dispatched`, `provisioning`, `sandbox_ready`, `online`, and `busy`, left joining dashboard jobs, runs, and repositories.
5. Derive `ageSeconds` from lease start/update timestamps using the database timestamp and clamp negative values to zero.
6. Extract capacity from the doctor payload without unsafe numeric conversion for memory/storage.
7. Compute connection state via `workerConnected(workerId)`, never via persisted `workers.connection_state`.
8. Parse the final object with `WorkerHealth.parse`.

Do not include proxy credentials, cache keys, or certificates.

- [ ] **Step 4: Run focused database tests**

Run:

```bash
bun test packages/db/src/dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the database projection**

```bash
git add packages/db/src/dashboard.ts packages/db/src/dashboard.test.ts
git commit -m "feat(db): project worker health telemetry"
```

---

### Task 3: Expose the worker health endpoint

**Files:**
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `getWorkerHealth` from Task 2 and `WorkerHealth` from Task 1.
- Produces: `GET /api/workers/:workerId/health`.

- [ ] **Step 1: Write failing route tests**

Add tests asserting:

- unauthenticated request returns `401`;
- authenticated non-admin request returns `403`;
- unknown worker returns `404`;
- admin receives a strict `WorkerHealth` response with jobs, usage, cache, and online state;
- worker health database errors are handled by the existing safe route wrapper;
- no returned body contains proxy credentials or certificates.

- [ ] **Step 2: Run focused route tests**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/http/dashboard-api.test.ts
```

Expected: FAIL because the route is absent.

- [ ] **Step 3: Implement the route**

Register the route near the existing worker cache route:

```ts
app.get("/api/workers/:workerId/health", safe(async (c) => {
  if (!c.get("user").isGlobalAdmin) return error(c, 403, "forbidden", "Global administrator authorization required");
  const health = await getWorkerHealth(deps.db, c.req.param("workerId"), deps.workerConnected);
  return health ? c.json(WorkerHealth.parse(health), { headers: { "cache-control": "no-store" } }) : error(c, 404, "not_found", "Resource not found");
}));
```

Use the repository’s existing `safe`, `error`, authorization, and no-store patterns rather than adding route-local variants.

- [ ] **Step 4: Run focused route tests**

Run:

```bash
bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/http/dashboard-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the endpoint**

```bash
git add apps/control-plane/src/http/dashboard-routes.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/http/dashboard-api.test.ts apps/control-plane/src/http/types.ts
git commit -m "feat(api): expose worker health telemetry"
```

---

### Task 4: Add the frontend health client and polling hook

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/components/useWorkerHealth.ts`
- Test: `apps/web/src/api.test.ts`
- Test: `apps/web/src/components/useWorkerHealth.test.ts`

**Interfaces:**
- Consumes: `WorkerHealth` from Task 1 and `/api/workers/:workerId/health` from Task 3.
- Produces: `getWorkerHealth(workerId)` and a query hook/options object enabled only while expanded.

- [ ] **Step 1: Write failing client/query tests**

Test that:

- `getWorkerHealth` requests the exact worker health path and parses the strict contract;
- the query is disabled when `expanded=false`;
- the query refetch interval is active while expanded and disabled while collapsed;
- API errors preserve the existing `ApiRequestError` behavior.

- [ ] **Step 2: Run focused frontend tests**

Run:

```bash
bun test apps/web/src/api.test.ts apps/web/src/components/useWorkerHealth.test.ts
```

Expected: FAIL because the client function/hook does not exist.

- [ ] **Step 3: Implement client and query options**

Add:

```ts
export const getWorkerHealth = (workerId: string) =>
  request(`/api/workers/${workerId}/health`, WorkerHealth, { cache: "no-store" });
```

Use TanStack Query options with a stable key such as `["worker-health", workerId]`, `enabled: expanded`, and a short polling interval only while expanded. Keep the health query independent from the existing worker list query.

- [ ] **Step 4: Run focused frontend tests**

Run:

```bash
bun test apps/web/src/api.test.ts apps/web/src/components/useWorkerHealth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the client/query layer**

```bash
git add apps/web/src/api.ts apps/web/src/api.test.ts apps/web/src/components/useWorkerHealth.ts apps/web/src/components/useWorkerHealth.test.ts
git commit -m "feat(web): poll worker health telemetry"
```

---

### Task 5: Implement the expandable WorkerCard health UI

**Files:**
- Modify: `apps/web/src/components/WorkerCard.tsx`
- Create: `apps/web/src/components/WorkerHealthPanel.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/components/WorkerHealthPanel.test.tsx`
- Modify: `apps/web/src/components/WorkerCard.test.tsx`

**Interfaces:**
- Consumes: the worker-health query from Task 4 and `WorkerHealth` DTO.
- Produces: accessible expandable Live health UI embedded in `WorkerCard`.

- [ ] **Step 1: Write failing component tests**

Cover:

- collapsed card does not render health details or start polling;
- expand control exposes `aria-expanded` and `aria-controls`;
- expanded state renders usage, cache, and jobs sections;
- large byte strings render without numeric precision loss;
- cache error, no snapshot, stale telemetry, offline, and no-active-jobs states have distinct text;
- job rows render lease state, repository/job metadata, age, and requested resources;
- independent loading and error states do not hide successful subsections.

- [ ] **Step 2: Run focused component tests**

Run:

```bash
bun test apps/web/src/components/WorkerCard.test.tsx apps/web/src/components/WorkerHealthPanel.test.tsx
```

Expected: FAIL because the panel does not exist.

- [ ] **Step 3: Implement `WorkerHealthPanel`**

Build three sections:

1. **System usage:** actual/reserved/free cards for CPU, memory, storage, and pods.
2. **Cache health:** readiness, desired/effective TTL, generation, entries, size, observation age, proxy status without displaying credentials, and error/remediation.
3. **Running jobs:** accessible table with job ID, repository/name, lease state, age, and resource request.

Use text status labels in addition to color. Use `<time dateTime>` for timestamps, `<section>` landmarks, table captions, `role="status"` for loading, and `role="alert"` for errors. Compute stale status from age fields returned by the server.

- [ ] **Step 4: Integrate the panel into `WorkerCard`**

Add a button with `aria-expanded`, an `aria-controls` target, and a stable label such as `Show live health` / `Hide live health`. Render `WorkerHealthPanel` only after expansion, passing the worker ID and organization context needed by existing card callbacks.

- [ ] **Step 5: Add focused styles**

Add styles for the health summary grid, stale/error badges, usage values, cache metadata, and responsive jobs table. Follow the existing dark dashboard tokens and avoid changing unrelated worker-card styles.

- [ ] **Step 6: Run focused component tests**

Run:

```bash
bun test apps/web/src/components/WorkerCard.test.tsx apps/web/src/components/WorkerHealthPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the UI**

```bash
git add apps/web/src/components/WorkerCard.tsx apps/web/src/components/WorkerHealthPanel.tsx apps/web/src/styles.css apps/web/src/components/WorkerCard.test.tsx apps/web/src/components/WorkerHealthPanel.test.tsx
 git commit -m "feat(web): show live worker health"
```

---

### Task 6: Run end-to-end verification and browser smoke test

**Files:**
- No source changes unless verification exposes a contract defect.

- [ ] **Step 1: Run the changed-contract test set**

Run:

```bash
bun test packages/contracts/src/dashboard.test.ts packages/db/src/dashboard.test.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/http/dashboard-api.test.ts apps/web/src/api.test.ts apps/web/src/components/WorkerCard.test.tsx apps/web/src/components/WorkerHealthPanel.test.tsx
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Start the actual dev surface**

Run the repository’s normal dev command and wait for both control plane and web readiness. Do not substitute unit tests for this check.

- [ ] **Step 3: Exercise the browser flow**

Open `http://localhost:5173/workers`, expand Live health for an adopted worker, and verify:

- connection and age indicators are visible;
- CPU/memory/storage/pod usage renders;
- cache readiness, TTL, observation age, and errors render;
- current active jobs match the lease-backed worker state;
- refresh updates timestamps without collapsing the panel;
- offline/stale/partial-error states remain understandable.

- [ ] **Step 4: Inspect final diff and preserve unrelated work**

Confirm only the planned files and the approved design/plan documents are part of the implementation commits. Do not stage or revert unrelated existing modifications.

- [ ] **Step 5: Commit verification-only adjustments if needed**

If browser verification reveals a real contract defect, add a focused regression test first, fix it, rerun the affected checks, and commit with a message describing the defect.
