# Secure Queued Job Execution Implementation Plan

> **For agentic workers:** Execute task-by-task with TDD. Each task has an independently testable deliverable.

**Goal:** Reconcile queued GitHub Actions jobs and execute them on ephemeral Tart VMs using label-bound GitHub JIT runner configuration, authenticated worker dispatch, lifecycle callbacks, and deterministic cleanup.

**Architecture:** The control plane first reserves an available runner slot for a routing queue (pool, repository, and label set), then obtains a short-lived installation token and calls GitHub's repository-scoped `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig` endpoint with runner name, runner group, work folder, and complete labels. GitHub assigns the JIT runner to a matching queued job; webhook events bind the lease to the actual GitHub job. The JIT config is delivered through the authenticated worker socket and durable command store as ciphertext, never plaintext. Tart starts the VM, runs `Runner.Listener run --jitconfig`, emits lifecycle events, and reaps the VM.

**Tech Stack:** Bun, TypeScript, Zod, PostgreSQL, GitHub App installation tokens, authenticated WebSockets, Tart, GitHub Actions runner listener.

## Global Constraints

- JIT config endpoint: `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`.
- Installation tokens must have repository Administration write permission; fail closed if GitHub returns insufficient permission.
- Never persist or log `encoded_jit_config`, installation tokens, runner claims, or bootstrap plaintext; durable worker commands persist only sealed ciphertext.
- Labels are case-insensitive and cumulative; the pool trigger label is mandatory.
- A lease reserves a routing slot, not a specific GitHub job; webhook assignment binds the actual job ID exactly once.
- Only approved, available repositories and adopted, online, ready, non-draining workers may receive leases.
- Tart resources must be validated against worker limits and read back after boot.
- Every lease has an expiry and terminal cleanup path.

---

### Task 1: Define JIT and lifecycle contracts

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Test: `packages/contracts/src/orchestration.test.ts`

**Interfaces:**
- Produce `RunnerJitConfigRequest`, `RunnerJitConfig`, `LeaseBootstrapEnvelope`, and `LeaseLifecycleEvent` Zod schemas.
- Produce worker command payload types for `tart.create_lease`, `tart.runner_started`, `tart.runner_completed`, and `tart.reap_lease`.

- [ ] Write failing tests for strict JIT response parsing, expiry, nonce binding, and rejection of missing runner labels.
- [ ] Run `bun test packages/contracts/src/orchestration.test.ts`; confirm failure because schemas are absent.
- [ ] Implement strict schemas with no secret aliases or optional plaintext claim fields.
- [ ] Run the focused test and confirm pass.

### Task 2: Add lease lifecycle persistence

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/leases.ts`
- Test: `packages/db/src/leases.test.ts`

- `reserveRoutingSlot(sql, input): Promise<LeaseReservation>` atomically locks a queued routing queue, selects a valid pool/worker, inserts one lease reservation, and marks the slot reserved before any JIT API call.
- `bindLeaseToJob(sql, leaseId, githubJobId): Promise<void>` binds the first matching webhook job exactly once and rejects conflicting job IDs.
- `completeLease(sql, leaseId, result): Promise<void>` transitions terminal state and updates the bound dashboard job.
- `expireLeases(sql, now): Promise<string[]>` marks stale reservations/leases failed and returns worker IDs needing cleanup.

- [ ] Write failing tests for duplicate reservation, disabled/revoked/offline candidates, capacity exhaustion, conflicting webhook binding, expiry, and terminal idempotency.
- [ ] Run tests and observe expected missing-function failures.
- [ ] Add lease columns for routing key, nonce, runner name, expiry, dispatch attempts, bound GitHub job ID, terminal result, and cleanup state; add indexes and safe `ALTER TABLE` migration statements.
- [ ] Implement transaction-locked reservations using `FOR UPDATE SKIP LOCKED`; release reservation if JIT generation fails.
- [ ] Run focused tests against the existing SQL fixture and confirm pass.

### Task 3: Implement GitHub queued-job and JIT client

**Files:**
- Modify: `apps/control-plane/src/github-app.ts`
- Create: `apps/control-plane/src/github-jobs.ts`
- Test: `apps/control-plane/src/github-jobs.test.ts`

**Interfaces:**
- `listQueuedJobs(installationId, owner, repo): Promise<QueuedGithubJob[]>` uses the installation token and repository jobs API.
- `generateJitConfig(input): Promise<RunnerJitConfig>` calls `/repos/{owner}/{repo}/actions/runners/generate-jitconfig` with runner name, runner group ID, work folder, and complete labels.

- [ ] Write failing fetcher tests asserting exact endpoint, headers, body, and no token/config leakage in thrown errors.
- [ ] Verify failure for missing `encoded_jit_config` and GitHub 403 permission errors.
- [ ] Implement installation-token creation and repository API calls; require `administration:write` capability from the installation metadata or fail closed on 403.
- [ ] Run focused GitHub tests and confirm pass.

### Task 4: Implement reconciliation and atomic scheduler

**Files:**
- Modify: `apps/control-plane/src/scheduler.ts`
- Create: `apps/control-plane/src/reconcile.ts`
- Test: `apps/control-plane/src/reconcile.test.ts`

- `reconcileQueuedJobs(deps): Promise<ReconcileReport>` scans approved repositories and queued jobs, upserts routing queues, reserves slots before JIT generation, and returns reserved/skipped/failed counts.
- `labelsMatch(requested, poolLabels, triggerLabel): boolean` remains the single routing predicate.

- [ ] Write failing tests for webhook-missed jobs, partial labels, duplicate scans, stale queues, and no eligible worker.
- [ ] Run focused tests and confirm failure.
- [ ] Implement bounded repository/job pagination, per-queue reservation transaction, JIT generation after reservation, and reservation release on API failure.

### Task 5: Dispatch sealed bootstrap envelopes

**Files:**
- Modify: `apps/control-plane/src/worker-dispatch.ts`
- Create: `apps/control-plane/src/lease-dispatch.ts`
- Test: `apps/control-plane/src/lease-dispatch.test.ts`

**Interfaces:**
- `dispatchLeaseBootstrap(deps, reservation): Promise<void>` seals the JIT config with a lease nonce and sends a command over an authenticated socket; the durable command store persists ciphertext for replay.
- Secret detection permits only the typed encrypted envelope field; plaintext secret keys remain rejected.

- [ ] Write failing tests proving plaintext JIT config is rejected, ciphertext is accepted and replayable, duplicate dispatch is idempotent, and timeout transitions the reservation failure.
- [ ] Implement envelope encryption using a worker-bound key agreement or authenticated TLS channel plus ciphertext-at-rest; persist only ciphertext and its hash, never plaintext.
- [ ] Dispatch `tart.create_lease` and process attestation before marking the lease sandbox-ready.
### Task 6: Implement guest JIT runner bootstrap

**Files:**
- Modify: `apps/job-agent/src/index.ts`
- Modify: `apps/orchestrator/src/mac-agent.ts`
- Modify: `apps/orchestrator/src/tart.ts`
- Test: `apps/job-agent/src/index.test.ts`
- Test: `apps/orchestrator/src/mac-agent.test.ts`

**Interfaces:**
- `accept-lease --stdin` decrypts and validates the one-time envelope, writes ephemeral runner config, and invokes `Runner.Listener run --jitconfig`.
- `handleMacWorkerCommand` handles `tart.create_lease`, runner start, completion, and reap events.

- [ ] Write failing tests for nonce mismatch, expired envelope, replay, listener exit propagation, and guaranteed VM removal.
- [ ] Run focused tests and confirm failure.
- [ ] Implement secure stdin handling, zeroing buffers, restrictive temporary files, runner process execution, and finally-based cleanup.
- [ ] Run focused worker tests and confirm pass.

### Task 7: Wire webhook, periodic reconciliation, and retry cleanup

**Files:**
- Modify: `apps/control-plane/src/runs.ts`
- Modify: `apps/control-plane/src/index.ts`
- Create: `apps/control-plane/src/reconciliation-loop.ts`
- Test: `apps/control-plane/src/reconciliation-loop.test.ts`

**Interfaces:**
- Webhook persistence triggers a non-blocking reconciliation pass.
- Periodic loop scans missed jobs, expires leases, retries bounded dispatch failures, and reaps terminal Tart VMs.

- [ ] Write failing tests for webhook-triggered scan, interval retry, and cleanup after worker disconnect.
- [ ] Run tests and confirm failure.
- [ ] Wire lifecycle events to lease/job state updates and install a bounded timer with graceful shutdown.
- [ ] Run focused tests and confirm pass.

### Task 8: End-to-end verification

**Files:**
- Create: `tests/queued-job-lifecycle.test.ts`
- Modify: `.env` only if local test configuration requires documented names

- [ ] Exercise queued webhook miss → reconciliation → JIT request → atomic lease → worker bootstrap → terminal event → Tart cleanup with deterministic fakes.
- [ ] Run `bun test tests/queued-job-lifecycle.test.ts` and confirm pass.
- [ ] Run `bun run typecheck`, `bun test`, and `bun run build`.
- [ ] Run a local smoke scenario with a fake GitHub API and authenticated worker socket; verify no secret appears in PostgreSQL rows, command logs, or thrown errors.
