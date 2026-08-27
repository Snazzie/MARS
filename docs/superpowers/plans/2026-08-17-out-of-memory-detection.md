# Out-of-memory Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Windows job memory exhaustion, preserve an actionable OOM diagnosis, and give the runner a graceful failure path before forced container cleanup.

**Architecture:** Keep detection in the orchestrator lease lifecycle, where runtime samples and completion already converge. Make the runtime driver expose an idempotent graceful-stop request; Windows containers implement it by asking the job-agent to terminate the runner before Docker stop/remove. Persist structured OOM metadata through the existing lease terminal result and expose it through job detail/timing APIs, while treating post-runner-loss classification as local diagnosis only.

**Tech Stack:** Bun, TypeScript, Zod contracts, PostgreSQL migrations/query helpers, Hono control-plane APIs, React dashboard, Docker/Windows Hyper-V containers, Bun tests.

## Global Constraints

- Windows Hyper-V container jobs are first release scope; keep the runtime interface extensible.
- Existing five-second sampling cadence remains the default.
- Configured lease memory is authoritative when Docker reports an invalid limit.
- OOM detection must not infer OOM from a missing sample alone.
- Never fabricate a GitHub completion after the runner process is gone.
- Diagnostics must exclude secrets, JIT configuration, authorization material, and unbounded command output.
- Do not add automatic retries or dynamic memory resizing.

---

### Task 1: Define OOM contracts and terminal result shape

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/orchestrator/src/runtime.ts`
- Test: `packages/contracts/src/orchestration.test.ts` (or the existing contract test file that covers `WorkerEventPayload`)
- Test: `apps/orchestrator/src/lease-lifecycle.test.ts`

**Interfaces:**
- Produce `OutOfMemoryResult = { reason: "out_of_memory"; memoryWorkingSetBytes: number; memoryLimitBytes: number; detectedAt: string; gracefulStopAcknowledged: boolean }`.
- Extend the runtime lifecycle dependency with an idempotent `requestGracefulStop(leaseId: string, reason: "out_of_memory", message: string): Promise<boolean>` capability; preserve existing drivers by making the capability optional and falling back to current stop behavior.
- Preserve existing `WorkerEventPayload` validation and add only the minimum failure metadata needed to carry OOM classification.

- [ ] **Step 1: Add failing contract tests**

```ts
test("accepts a structured out-of-memory terminal result", () => {
  expect(OutOfMemoryResult.parse({
    reason: "out_of_memory",
    memoryWorkingSetBytes: 11_295_763_988,
    memoryLimitBytes: 10_737_418_240,
    detectedAt: "2026-08-17T20:59:24.015Z",
    gracefulStopAcknowledged: false,
  })).toEqual(expect.objectContaining({ reason: "out_of_memory" }));
});

test("rejects negative or non-finite OOM measurements", () => {
  expect(() => OutOfMemoryResult.parse({
    reason: "out_of_memory",
    memoryWorkingSetBytes: -1,
    memoryLimitBytes: 10,
    detectedAt: new Date().toISOString(),
    gracefulStopAcknowledged: false,
  })).toThrow();
});
```

- [ ] **Step 2: Run focused contract tests and verify failure**

Run: `bun test packages/contracts/src/orchestration.test.ts apps/orchestrator/src/lease-lifecycle.test.ts`
Expected: FAIL because the result schema and lifecycle capability do not exist.

- [ ] **Step 3: Implement the smallest strict schemas/types**

Use positive safe integers for byte counts, an offset-aware ISO datetime, and a bounded diagnostic message. Keep existing failure reasons valid for older workers.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `bun test packages/contracts/src/orchestration.test.ts apps/orchestrator/src/lease-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts apps/orchestrator/src/runtime.ts apps/orchestrator/src/lease-lifecycle.test.ts
git commit -m "feat: define OOM lifecycle result"
```

### Task 2: Make Windows memory telemetry trustworthy

**Files:**
- Modify: `apps/orchestrator/src/windows-container.ts`
- Test: `apps/orchestrator/src/windows-container.test.ts`

**Interfaces:**
- Consume the lease memory limit in the sampler factory.
- Produce `{ cpuUsagePercent, cpuTimeMs, memoryWorkingSetBytes, memoryLimitBytes }` with the configured memory limit when Docker’s second `MemUsage` field is missing, malformed, zero, or implausibly smaller than the configured limit.
- Never emit `memoryLimitBytes: 1` for a real job.

- [ ] **Step 1: Add parser/sampler failing tests**

```ts
test("falls back to configured memory when Docker reports an invalid limit", async () => {
  const sample = await makeWindowsContainerSample("10.52GiB / 1B", 10 * 1024 ** 3, dockerStub);
  expect(sample.memoryWorkingSetBytes).toBeGreaterThan(10 * 1024 ** 3);
  expect(sample.memoryLimitBytes).toBe(10 * 1024 ** 3);
});

test("parses a valid Docker memory limit", async () => {
  const sample = await makeWindowsContainerSample("512MiB / 10GiB", 10 * 1024 ** 3, dockerStub);
  expect(sample.memoryLimitBytes).toBe(10 * 1024 ** 3);
});
```

- [ ] **Step 2: Run the Windows-container tests and verify failure**

Run: `bun test apps/orchestrator/src/windows-container.test.ts`
Expected: FAIL on the malformed-limit case.

- [ ] **Step 3: Thread configured memory into `dockerSample` and fix fallback parsing**

Keep unit parsing case-insensitive. Treat a parsed limit below a small validity floor or below the configured lease limit as invalid for this driver; return the configured value. Keep working-set parsing unchanged except for finite/nonnegative validation.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `bun test apps/orchestrator/src/windows-container.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/windows-container.ts apps/orchestrator/src/windows-container.test.ts
git commit -m "fix(windows): preserve valid memory sample limits"
```

### Task 3: Add the OOM state machine and graceful-stop race

**Files:**
- Modify: `apps/orchestrator/src/lease-lifecycle.ts`
- Modify: `apps/orchestrator/src/runtime.ts`
- Test: `apps/orchestrator/src/lease-lifecycle.test.ts`

**Interfaces:**
- Add a pure helper, for example `updateMemoryPressure(state, sample, configuredLimit)`, returning the next pressure state and optional OOM evidence.
- Require two consecutive samples at or above 95% for pressure; detect immediately when working set exceeds the configured limit.
- Add a single OOM stop claim shared by the sampler and completion path.
- On detection, call `requestGracefulStop` once, wait a bounded grace period, and race it against normal completion.
- Send `runner.finished` only for a real runner completion; send structured `lease.failed`/terminal OOM metadata when forced cleanup is necessary.

- [ ] **Step 1: Add failing state-machine tests**

```ts
test("requires two consecutive near-limit samples", () => {
  let state = initialMemoryPressureState();
  ({ state } = updateMemoryPressure(state, sample(9.6), 10));
  expect(state.phase).toBe("pressured");
  ({ state } = updateMemoryPressure(state, sample(9.7), 10));
  expect(state.phase).toBe("oom_detected");
});

test("detects an over-limit sample immediately and claims one stop", () => {
  const result = updateMemoryPressure(initialMemoryPressureState(), sample(10.1), 10);
  expect(result.evidence?.reason).toBe("out_of_memory");
  expect(result.shouldStop).toBe(true);
});

test("does not classify a missing sample as OOM", () => {
  expect(updateMemoryPressure(initialMemoryPressureState(), null, 10).evidence).toBeNull();
});
```

- [ ] **Step 2: Run lifecycle tests and verify failure**

Run: `bun test apps/orchestrator/src/lease-lifecycle.test.ts`
Expected: FAIL because pressure tracking and stop racing are absent.

- [ ] **Step 3: Implement pure pressure tracking**

Track consecutive pressure count, peak bytes, last sample, and one stop claim. Reset the consecutive count below 95% while retaining peak evidence only for an already-detected event.

- [ ] **Step 4: Integrate detection with `runLeaseLifecycle`**

Keep sampling errors nonfatal. When OOM is detected, invoke the optional graceful-stop method with a bounded message such as `Job terminated: memory limit exceeded (10.52 GiB / 10.00 GiB)`. Await completion up to the grace deadline. If the runner never completes, capture the OOM result and use existing cleanup. Ensure sampler shutdown cannot deadlock cleanup.

- [ ] **Step 5: Run focused lifecycle tests and verify pass**

Run: `bun test apps/orchestrator/src/lease-lifecycle.test.ts apps/orchestrator/src/windows-agent.test.ts`
Expected: PASS, including normal completion, graceful OOM completion, and forced-stop fallback.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/lease-lifecycle.ts apps/orchestrator/src/runtime.ts apps/orchestrator/src/lease-lifecycle.test.ts
git commit -m "feat: detect and stop OOM jobs"
```

### Task 4: Implement graceful stop in the Windows worker/job-agent boundary

**Files:**
- Modify: `apps/orchestrator/src/windows-container.ts`
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Modify: `apps/job-agent/src/bootstrap.ts` or the existing runner-launch boundary used by Windows jobs
- Test: `apps/orchestrator/src/windows-container.test.ts`
- Test: `apps/orchestrator/src/windows-agent.test.ts`
- Test: `apps/job-agent/src/bootstrap.test.ts`

**Interfaces:**
- Consume the runtime `requestGracefulStop` call with reason and bounded message.
- Produce an idempotent container/job-agent stop request that first asks the runner process to terminate, then allows the existing forced Docker stop as fallback.
- The job-agent must log the bounded diagnostic and exit with a nonzero code without logging secrets or JIT data.

- [ ] **Step 1: Add failing boundary tests**

```ts
test("graceful OOM stop is idempotent and precedes forced cleanup", async () => {
  await driver.requestGracefulStop(leaseId, "out_of_memory", "Job terminated: memory limit exceeded");
  await driver.requestGracefulStop(leaseId, "out_of_memory", "Job terminated: memory limit exceeded");
  expect(dockerCalls).toEqual([expect.arrayContaining(["exec"])]);
  expect(dockerCalls.filter(call => call[0] === "exec")).toHaveLength(1);
});

test("runner launch emits bounded OOM diagnostic", async () => {
  const result = await runRunnerWithStopSignal({ reason: "out_of_memory", message: "Job terminated: memory limit exceeded" });
  expect(result.exitCode).not.toBe(0);
  expect(result.logs).toContain("memory limit exceeded");
});
```

- [ ] **Step 2: Run focused boundary tests and verify failure**

Run: `bun test apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/windows-agent.test.ts apps/job-agent/src/bootstrap.test.ts`
Expected: FAIL because no graceful-stop protocol exists.

- [ ] **Step 3: Implement the minimal stop signal**

Use the existing Windows container command wrapper and job-agent runner-launch boundary. Keep the signal idempotent by storing a per-lease stop promise/flag. Do not use `docker stop` as the graceful request; reserve it for the existing cleanup fallback.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `bun test apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/windows-agent.test.ts apps/job-agent/src/bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/windows-container.ts apps/orchestrator/src/windows-agent.ts apps/job-agent/src/bootstrap.ts apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/windows-agent.test.ts apps/job-agent/src/bootstrap.test.ts
git commit -m "feat(windows): gracefully stop OOM runners"
```

### Task 5: Persist and expose OOM diagnosis

**Files:**
- Modify: `packages/db/src/schema.ts` and migration registration in `packages/db/src/index.ts` only if a new column is required by existing terminal-result storage
- Modify: `apps/control-plane/src/worker-lifecycle.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: relevant contract DTOs in `packages/contracts/src`
- Test: `apps/control-plane/src/worker-lifecycle.test.ts`
- Test: `apps/control-plane/src/http/dashboard-routes.test.ts` or existing dashboard route tests

**Interfaces:**
- Consume structured OOM result from worker events/lease terminal result.
- Produce job detail and timing responses with `failureReason: "out_of_memory"`, peak bytes, configured limit, detection time, and graceful acknowledgement.
- Preserve existing generic runner-loss behavior when no OOM evidence exists.

- [ ] **Step 1: Add failing persistence/API tests**

```ts
test("retains OOM diagnosis after lease reaping", async () => {
  await applyWorkerLeaseEvent(db, oomLeaseFailedEvent);
  await applyWorkerLeaseEvent(db, leaseReapedEvent);
  expect(await readJobDetail(jobId)).toMatchObject({ failureReason: "out_of_memory" });
});
```

- [ ] **Step 2: Run focused control-plane tests and verify failure**

Run: `bun test apps/control-plane/src/worker-lifecycle.test.ts apps/control-plane/src/http/dashboard-routes.test.ts`
Expected: FAIL because DTOs and persistence mapping do not expose OOM.

- [ ] **Step 3: Implement structured mapping**

Prefer the existing JSON terminal-result field if it can retain the structured payload without migration. Add a migration only if the current schema or query contract cannot preserve it. Validate all numeric values and redact diagnostic text at the API boundary.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `bun test apps/control-plane/src/worker-lifecycle.test.ts apps/control-plane/src/http/dashboard-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/index.ts apps/control-plane/src/worker-lifecycle.ts apps/control-plane/src/http/dashboard-routes.ts packages/contracts/src apps/control-plane/src/worker-lifecycle.test.ts apps/control-plane/src/http/dashboard-routes.test.ts
git commit -m "feat: expose OOM job diagnosis"
```

### Task 6: Render OOM distinctly and verify end to end

**Files:**
- Modify: `apps/web/src/routes/RunDetailPage.tsx`
- Modify: `apps/web/src/routes/RunDetailPage.test.tsx`
- Modify: any generated route/API contract file only through the repository’s existing generation command if required
- Test: existing Windows smoke harness or a new focused smoke test under `tests/`

**Interfaces:**
- Consume the job detail DTO from Task 5.
- Produce a distinct OOM status/message with GiB values and a separate fallback message for runner communication loss.

- [ ] **Step 1: Add failing UI test**

```tsx
test("renders OOM details separately from runner loss", () => {
  render(<RunDetailPage initialData={oomJobDetail} />);
  expect(screen.getByText(/memory limit exceeded/i)).toBeVisible();
  expect(screen.getByText(/10\.52 GiB/)).toBeVisible();
});
```

- [ ] **Step 2: Run the focused UI test and verify failure**

Run: `bun test apps/web/src/routes/RunDetailPage.test.tsx`
Expected: FAIL because the page does not render the new failure reason.

- [ ] **Step 3: Implement distinct rendering**

Show the reason, peak usage, configured limit, detection time, and whether graceful termination was acknowledged. Keep copy concise and avoid implying GitHub completed normally when the runner was already lost.

- [ ] **Step 4: Run focused UI tests and the Windows smoke test**

Run: `bun test apps/web/src/routes/RunDetailPage.test.tsx tests/windows-playwright-smoke.mjs`
Expected: PASS, or report the environment limitation if a Windows Docker engine is unavailable.

- [ ] **Step 5: Run repository verification**

Run: `bun test packages/contracts/src/orchestration.test.ts apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/lease-lifecycle.test.ts apps/orchestrator/src/windows-agent.test.ts apps/job-agent/src/bootstrap.test.ts apps/control-plane/src/worker-lifecycle.test.ts apps/control-plane/src/http/dashboard-routes.test.ts apps/web/src/routes/RunDetailPage.test.tsx`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS for all workspaces.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/RunDetailPage.tsx apps/web/src/routes/RunDetailPage.test.tsx tests
 git commit -m "feat: show OOM failures clearly"
```

## Final verification

Run the focused behavioral suite above, then exercise a disposable Windows job whose memory usage crosses its configured limit. Verify both outcomes:

1. Runner alive: GitHub receives a normal failed result with the bounded OOM diagnostic.
2. Runner killed: GitHub may show runner loss, but Mars job detail and timing history show `out_of_memory` with peak and configured bytes.
