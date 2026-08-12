# Post-Enrollment Resource Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move worker resource policy out of enrollment and into authenticated post-enrollment adoption/configuration in the UI.

**Architecture:** Enrollment submits identity and observed capacity only. A global administrator adopts a pending worker with organization, appliance sizing, and runtime ceilings; the control plane validates and persists the policy, dispatches a durable secret-free configuration command, and enables scheduling only after matching worker acknowledgement. Existing worker admission, command, and dashboard patterns remain in place.

**Tech Stack:** Bun, TypeScript, Hono, Zod, PostgreSQL/Drizzle-style SQL, React 19, TanStack Query, Bun tests.

## Global Constraints

- `WorkerBootstrapRequest` MUST NOT contain administrator-selected `limits`.
- Enrollment MUST store reported capacity/doctor telemetry and `limits = null`.
- Only a global administrator may adopt or configure a worker.
- Appliance and runtime resource values MUST be positive safe integers and fit reported capacity/reserves.
- Workers MUST NOT receive jobs while pending, unconfigured, configuring, or in error.
- Configuration commands MUST contain no enrollment code, GitHub token, private key, or job claim.
- Configuration acknowledgement MUST match the requested configuration before readiness/scheduling.
- Existing secret-safe command persistence and command-ID acknowledgement semantics remain mandatory.

---

### Task 1: Update enrollment and contract schemas

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/control-plane/src/worker-requests.ts`
- Modify: `apps/orchestrator/src/mac-agent.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Test: `tests/contracts.test.ts`
- Test: `apps/control-plane/src/worker-requests.test.ts` (create if absent, following existing worker request tests)

**Interfaces:**
- `WorkerBootstrapRequest` consumes `{ code, platform, publicKey, vmUuid, machineUuid, doctor, capacity }` and rejects a `limits` property.
- `WorkerLimits` remains the runtime ceiling type.
- Introduce/export an adoption configuration type containing `organizationId`, appliance `vcpu`, `memoryBytes`, `storageBytes`, and runtime `limits`.
- `requestPendingWorker` persists `limits` as SQL `NULL` and preserves reported capacity in doctor JSON.

- [ ] **Step 1: Add failing schema and join tests**
  - Assert a valid limit-free bootstrap request parses.
  - Assert the same request with `limits` fails strict Zod parsing.
  - Assert a pending worker insert uses `NULL` for policy limits while retaining doctor/capacity telemetry.
  - Assert Mac/Windows join payload builders no longer require or emit limits.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
bun test tests/contracts.test.ts apps/control-plane/src/worker-requests.test.ts
```

Expected: failures identify the required `limits` field and current payload persistence.

- [ ] **Step 3: Implement the contract and persistence cutover**
  - Remove `limits` from `WorkerBootstrapRequest` and keep `.strict()` behavior.
  - Add nullable policy typing where pending worker DTOs expose limits.
  - Remove default limit construction from join payloads; retain only reported capacity and doctor data.
  - Update SQL insert/update mappings so enrollment never writes administrator policy.
  - Keep all resource schemas positive safe integers.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
bun test tests/contracts.test.ts apps/control-plane/src/worker-requests.test.ts
bun run --filter '@whitesmith/contracts' typecheck
bun run --filter '@whitesmith/control-plane' typecheck
bun run --filter '@whitesmith/orchestrator' typecheck
```

Expected: all focused tests and typechecks pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/orchestration.ts apps/control-plane/src/worker-requests.ts apps/orchestrator/src/mac-agent.ts apps/orchestrator/src/index.ts tests/contracts.test.ts apps/control-plane/src/worker-requests.test.ts
git commit -m "refactor: remove resource policy from enrollment"
```

---

### Task 2: Add post-enrollment configuration command and state transitions

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/control-plane/src/worker-dispatch.ts`
- Modify: `apps/control-plane/src/http/worker-routes.ts`
- Modify: `apps/control-plane/src/worker-requests.ts`
- Modify: `apps/control-plane/src/index.ts`
- Modify: `packages/db/src/schema.ts` or the existing worker migration/schema file that defines `workers.limits` and configuration state
- Test: `apps/control-plane/src/worker-dispatch.test.ts`
- Test: `apps/control-plane/src/http/app.test.ts`
- Test: `apps/control-plane/src/worker-requests.test.ts`

**Interfaces:**
- Add a versioned `worker.configure` command payload containing worker ID, appliance sizing, runtime limits, and a configuration revision/fingerprint; it MUST pass existing `containsSecret` checks.
- Add a typed worker configuration acknowledgement event containing command ID, revision, and observed applied values.
- Add `configurePendingWorker(db, workerId, organizationId, configuration, adminId)` that validates state/capacity, persists policy and `admission_state='adopted'`, leaves `configuration_state='unconfigured'`, and writes an audit event.
- Register `POST /api/workers/pending/:workerId/configure` with global-admin and `Idempotency-Key` enforcement.

- [ ] **Step 1: Add failing command, route, and validation tests**
  - Assert the configuration command serializes without secrets.
  - Assert a pending worker can be configured with valid values and gets a durable command.
  - Assert missing, fractional, non-positive, unsafe, and over-capacity values return validation errors without mutating admission/policy.
  - Assert a non-admin and an unauthenticated caller cannot configure.
  - Assert repeated identical idempotency requests are safe and conflicting state returns `409`.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
bun test apps/control-plane/src/worker-dispatch.test.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/worker-requests.test.ts
```

Expected: failures show missing command/event and configuration route behavior.

- [ ] **Step 3: Implement configuration persistence and route**
  - Validate appliance sizing and runtime ceilings against reported capacity plus existing reserve rules.
  - Persist organization and requested policy atomically with the adoption audit event.
  - Generate a stable revision/fingerprint from canonical configuration fields; do not include secrets.
  - Dispatch the configuration command through the existing durable worker dispatcher.
  - Keep scheduling blocked until acknowledgement handling marks the exact revision ready.
  - Return the worker detail/configuration revision to the UI.

- [ ] **Step 4: Add acknowledgement handling and scheduling gate**
  - Validate worker ID, command ID, revision, and observed resource values.
  - Mark `configuration_state='ready'` only for an exact match and successful doctor state.
  - Mark `configuration_state='error'` on mismatch or failed application; preserve the command for diagnostics/retry.
  - Ensure scheduler admission requires adopted, online, configured-ready workers.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
bun test apps/control-plane/src/worker-dispatch.test.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/worker-requests.test.ts tests/worker-dispatch.test.ts
bun run --filter '@whitesmith/control-plane' typecheck
bun run --filter '@whitesmith/contracts' typecheck
```

Expected: command replay, acknowledgement, validation, and scheduling-gate tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/orchestration.ts apps/control-plane/src/worker-dispatch.ts apps/control-plane/src/http/worker-routes.ts apps/control-plane/src/worker-requests.ts apps/control-plane/src/index.ts packages/db apps/control-plane/src/worker-dispatch.test.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/worker-requests.test.ts tests/worker-dispatch.test.ts
git commit -m "feat: configure workers after adoption"
```

---

### Task 3: Build post-enrollment adoption UI

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/components/PendingWorkerRequests.tsx`
- Modify: `apps/web/src/components/WorkerCard.tsx`
- Modify: `apps/web/src/routes/WorkersPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/components/PendingWorkerRequests.test.tsx`
- Test: `apps/web/src/routes/WorkersPage.test.tsx` (create if absent, following existing route tests)

**Interfaces:**
- Add `configurePendingWorker(workerId, input)` API client using the typed adoption configuration and generated idempotency key.
- Pending worker UI consumes reported capacity and renders appliance sizing plus runtime ceiling fields.
- Successful configuration invalidates pending-worker and organization-worker queries.

- [ ] **Step 1: Add failing component/API tests**
  - Assert pending worker cards show reported capacity and no enrollment-time resource form.
  - Assert opening Adopt exposes organization, appliance vCPU/RAM/disk, and runtime ceiling/concurrency inputs.
  - Assert invalid local values show field errors and do not call the API.
  - Assert successful configuration displays configuring state and refreshes worker data.
  - Assert configuration errors remain visible with retry.

- [ ] **Step 2: Run focused UI tests and confirm failure**

```bash
bun test apps/web/src/components/PendingWorkerRequests.test.tsx apps/web/src/routes/WorkersPage.test.tsx
```

Expected: failures identify missing post-enrollment form and API function.

- [ ] **Step 3: Implement typed API and adoption form**
  - Remove any resource fields from enrollment wizard state and copy.
  - Add a controlled adoption/configuration form with exact integer/unit labels.
  - Display capacity limits beside fields and prevent values above reported capacity.
  - Show fingerprint confirmation, doctor status, and explicit “Apply configuration” action.
  - Render `pending`, `configuring`, `ready`, and `error` states with accessible labels, focus, and retry.

- [ ] **Step 4: Run focused UI tests and typecheck**

```bash
bun test apps/web/src/components/PendingWorkerRequests.test.tsx apps/web/src/routes/WorkersPage.test.tsx
bun run --filter '@whitesmith/web' typecheck
```

Expected: UI behavior and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/components/PendingWorkerRequests.tsx apps/web/src/components/WorkerCard.tsx apps/web/src/routes/WorkersPage.tsx apps/web/src/styles.css apps/web/src/components/PendingWorkerRequests.test.tsx apps/web/src/routes/WorkersPage.test.tsx
 git commit -m "feat: configure worker resources in dashboard"
```

---

### Task 4: Verify end-to-end adoption and release behavior

**Files:**
- Modify: `apps/control-plane/src/http/app.test.ts` if route coverage needs completion
- Modify: `tests/worker-dispatch.test.ts` if cross-component coverage belongs there
- Modify: `docs/superpowers/specs/2026-08-11-post-enrollment-resource-configuration-design.md` only if verification reveals a precise contract correction

- [ ] **Step 1: Run the complete focused regression set**

```bash
bun test tests/contracts.test.ts tests/worker-dispatch.test.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/worker-bootstrap.test.ts apps/control-plane/src/worker-requests.test.ts apps/control-plane/src/worker-dispatch.test.ts apps/web/src/components/PendingWorkerRequests.test.tsx apps/web/src/routes/WorkersPage.test.tsx
```

Expected: all enrollment, adoption, command, scheduler, and UI tests pass.

- [ ] **Step 2: Run workspace verification**

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
```

Expected: zero diagnostics and successful control-plane/web builds with dashboard assets.

- [ ] **Step 3: Exercise the live browser flow**
  - Open `/workers` as a global administrator.
  - Generate an enrollment code; confirm no resource fields are shown.
  - Submit a limit-free worker join fixture; confirm pending card shows only observed capacity.
  - Open Adopt, enter organization plus appliance/runtime resources, and apply.
  - Confirm configuration command/acknowledgement transitions to ready and scheduling becomes eligible only then.
  - Submit an over-capacity configuration and confirm the worker remains unschedulable with a visible validation error.

- [ ] **Step 4: Commit any verification-only contract corrections**

```bash
git status --short
git commit -am "test: verify post-enrollment worker configuration"
```

Only commit if verification required a source or test correction; do not create an empty commit.

## Self-review checklist

- Spec coverage: enrollment schema/persistence (Task 1), post-adoption command/state/scheduler (Task 2), UI flow (Task 3), and verification/security (Task 4) are covered.
- Placeholder scan: every step contains concrete files, interfaces, commands, expected results, and no deferred work.
- Type consistency: `WorkerBootstrapRequest` is limit-free; adoption/configuration owns resource values; command acknowledgement carries revision and observed values; scheduler consumes only ready workers.
- Existing unrelated changes must remain untouched.
