# Runner/service-layer observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture trustworthy Windows runner termination and resource evidence so an abrupt GitHub Actions runner disappearance is not misclassified as out of memory.

**Architecture:** Keep the existing append-only `ProgramData\\Whitesmith\\logs\\worker.log` as the service-host sink, but write one JSON object per lifecycle event with a stable lease correlation ID. Extend the Rust host’s Windows Job Object wrapper to collect accounting and termination evidence. Carry only sanitized runtime evidence across the existing orchestrator lifecycle; classify OOM only from explicit validated memory evidence and preserve unknown termination as runner failure.

**Tech Stack:** Rust 2024, `windows-service` 0.8, `windows-sys` 0.59 Windows Job Objects APIs, Bun/TypeScript, Zod worker contracts, Bun tests.

## Global Constraints

- Modify only the Windows service host and orchestrator lifecycle boundary; do not change GitHub workflows or add centralized storage.
- Never log JIT configuration, tokens, request bodies, job bodies, private keys, or raw worker credentials.
- A forced termination or missing completion is not OOM without explicit validated memory-limit evidence.
- Preserve the existing human-readable `worker.log` usability and service supervision behavior.
- Do not add dependencies unless the existing Windows API feature set cannot provide the required fields.

---

### Task 1: Define sanitized termination evidence types

**Files:**
- Modify: `packages/contracts/src/orchestration.ts:15-65`
- Modify: `apps/orchestrator/src/runtime.ts:1-4`
- Test: `packages/contracts/src/orchestration.test.ts`
- Test: `apps/orchestrator/src/lease-lifecycle.test.ts`

**Interfaces:**
- Produces `RuntimeTerminationCause = z.enum(["child_exit", "service_stop", "forced_job_termination", "child_disappeared", "service_host_error"])`.
- Produces strict `RuntimeTerminationEvidence` with `cause`, nullable `exitCode`, boolean `exitObserved`, nonnegative `elapsedMs`, nullable `childPid`, nullable `servicePid`, nullable `activeProcessCount`, nullable `peakProcessCount`, nullable `peakProcessMemoryBytes`, nullable `peakJobMemoryBytes`, nullable `kernelTimeMs`, nullable `userTimeMs`, nullable `lastSampleOccurredAt`, nullable `sampleCount`, and nullable `samplingGapMs`.
- `RuntimeLease.completion` remains `Promise<number>` for compatibility; add optional `termination?: RuntimeTerminationEvidence` and optional `correlationId: string`.

- [ ] **Step 1: Write contract tests for valid and invalid evidence**

```ts
test("accepts sanitized forced-termination evidence", () => {
  expect(RuntimeTerminationEvidence.parse({
    cause: "forced_job_termination",
    exitCode: 1,
    exitObserved: false,
    elapsedMs: 900_000,
    childPid: 1234,
    servicePid: 456,
    activeProcessCount: 2,
    peakProcessCount: 4,
    peakProcessMemoryBytes: 10_000,
    peakJobMemoryBytes: 12_000,
    kernelTimeMs: 4_000,
    userTimeMs: 8_000,
    lastSampleOccurredAt: new Date().toISOString(),
    sampleCount: 42,
    samplingGapMs: 5_000,
  }).cause).toBe("forced_job_termination");
});

test("rejects sensitive or unknown evidence fields", () => {
  expect(RuntimeTerminationEvidence.safeParse({ cause: "child_exit", exitCode: 0, commandLine: "secret" }).success).toBe(false);
});
```

- [ ] **Step 2: Run the focused contract tests and verify failure**

Run: `bun test packages/contracts/src/orchestration.test.ts apps/orchestrator/src/lease-lifecycle.test.ts`

Expected: FAIL because the new schemas and runtime fields do not yet exist.

- [ ] **Step 3: Add strict schemas and runtime fields**

```ts
export const RuntimeTerminationCause = z.enum(["child_exit", "service_stop", "forced_job_termination", "child_disappeared", "service_host_error"]);
export const RuntimeTerminationEvidence = z.object({
  cause: RuntimeTerminationCause,
  exitCode: z.number().int().nonnegative().nullable(),
  exitObserved: z.boolean(),
  elapsedMs: z.number().int().nonnegative().safe(),
  childPid: z.number().int().positive().nullable(),
  servicePid: z.number().int().positive().nullable(),
  activeProcessCount: z.number().int().nonnegative().nullable(),
  peakProcessCount: z.number().int().nonnegative().nullable(),
  peakProcessMemoryBytes: z.number().int().nonnegative().nullable(),
  peakJobMemoryBytes: z.number().int().nonnegative().nullable(),
  kernelTimeMs: z.number().int().nonnegative().nullable(),
  userTimeMs: z.number().int().nonnegative().nullable(),
  lastSampleOccurredAt: z.string().datetime({ offset: true }).nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  samplingGapMs: z.number().int().nonnegative().nullable(),
}).strict();
```

- [ ] **Step 4: Run focused tests and verify pass**

Run: `bun test packages/contracts/src/orchestration.test.ts apps/orchestrator/src/lease-lifecycle.test.ts`

Expected: PASS for the new schema cases and all existing tests.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts apps/orchestrator/src/runtime.ts apps/orchestrator/src/lease-lifecycle.test.ts
git commit -m "feat: define runner termination evidence"
```

### Task 2: Add structured Windows service-host logging and accounting

**Files:**
- Modify: `apps/windows-service-host/Cargo.toml:6-14`
- Modify: `apps/windows-service-host/src/main.rs:1-190`
- Test: `apps/windows-service-host/src/main.rs:256-275`

**Interfaces:**
- Produces `TerminationCause`, `JobAccounting`, `ServiceRecord`, and `TerminationEvidence` Rust types with serde-compatible JSON output without adding a serialization dependency; use a small escaping helper for controlled JSON fields or add only the minimal serialization dependency if required by the existing workspace policy.
- `Job::accounting() -> io::Result<JobAccounting>` reads `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` and `QueryInformationJobObject`.
- `supervise_child(...) -> io::Result<SupervisionOutcome>` returns the child status plus explicit cause and optional accounting instead of only a numeric code.
- `append_record(record: &ServiceRecord)` writes one timestamped JSONL line and flushes it.

- [ ] **Step 1: Write Rust tests for cause and accounting serialization**

```rust
#[test]
fn forced_termination_is_not_oom() {
    let evidence = TerminationEvidence::forced_job_termination(42, 1_000);
    assert_eq!(evidence.cause, TerminationCause::ForcedJobTermination);
    assert!(!evidence.oom);
}

#[test]
fn records_escape_controlled_strings_and_preserve_unavailable_accounting() {
    let json = ServiceRecord::host_error("worker\\nfailed").to_json_line();
    assert!(json.contains("worker\\\\nfailed"));
    assert!(json.contains("\"accounting\":null"));
}
```

- [ ] **Step 2: Run the Rust tests and verify failure**

Run: `cargo test --manifest-path apps/windows-service-host/Cargo.toml`

Expected: FAIL because structured records, accounting, and supervision outcome types do not yet exist.

- [ ] **Step 3: Implement structured JSONL records and Windows accounting**

Use `GetCurrentProcessId`, `GetProcessTimes`, and `QueryInformationJobObject(JobObjectExtendedLimitInformation)` at spawn, stop, forced termination, and child-exit boundaries. Keep unavailable values as `null`; include an `accountingError` field only when a Windows API call fails. Use event names such as `service_started`, `child_spawned`, `job_assigned`, `service_stop_requested`, `job_terminated`, `child_exited`, `child_disappeared`, and `service_host_error`.

The supervision loop must classify outcomes as follows:

```rust
if stop.try_recv().is_ok() {
    append_record(service_stop_requested(...));
    on_stop()?;
    let accounting_before = job.accounting().ok();
    job.terminate();
    let status = child.wait().ok();
    return Ok(SupervisionOutcome::forced(TerminationCause::ServiceStop, status, accounting_before));
}
if let Some(status) = child.try_wait()? {
    let cause = if status.success() { TerminationCause::ChildExit } else { TerminationCause::ChildExit };
    return Ok(SupervisionOutcome::child_exit(cause, status, job.accounting().ok()));
}
```

If `try_wait` reports no child while the job still has no observable completion, emit `child_disappeared`; do not fabricate an OOM field. Preserve the existing service exit-code behavior by mapping successful child completion to the current success code and nonzero child status to the raw nonzero code.

- [ ] **Step 4: Run Rust tests and verify pass**

Run: `cargo test --manifest-path apps/windows-service-host/Cargo.toml`

Expected: PASS, including existing service supervision tests.

- [ ] **Step 5: Commit the service-host instrumentation**

```bash
git add apps/windows-service-host/Cargo.toml apps/windows-service-host/src/main.rs
git commit -m "feat: log Windows runner termination evidence"
```

### Task 3: Propagate correlation and termination evidence through orchestrator lifecycle

**Files:**
- Modify: `apps/orchestrator/src/runtime.ts:1-4`
- Modify: `apps/orchestrator/src/lease-lifecycle.ts:53-120`
- Modify: `apps/orchestrator/src/worker-client.ts:1-6` only if event payload normalization is required
- Test: `apps/orchestrator/src/lease-lifecycle.test.ts`

**Interfaces:**
- Consumes `RuntimeTerminationEvidence` from Task 1 and `RuntimeLease.termination` from Task 2’s runtime adapter.
- Produces `runner.finished` or `lease.failed` payloads containing sanitized `termination` evidence and a non-secret `correlationId`.

- [ ] **Step 1: Add failing lifecycle tests for classification and sampling gaps**

```ts
test("reports runner failure, not OOM, when completion disappears without memory evidence", async () => {
  const events: WorkerEvent[] = [];
  await runLeaseLifecycle(command, disappearingDriver, bootstrap, event => events.push(event));
  const failure = events.find(event => event.type === "lease.failed");
  expect(failure?.payload).toMatchObject({ reason: "runner_failed" });
  expect(failure?.payload).not.toHaveProperty("oom");
  expect(failure?.payload).toHaveProperty("termination.cause", "child_disappeared");
});

test("retains last sample and gap when runtime completion rejects", async () => {
  const events: WorkerEvent[] = [];
  await runLeaseLifecycle(command, rejectingDriver, bootstrap, event => events.push(event));
  expect(events.at(-2)?.payload).toMatchObject({ termination: { sampleCount: expect.any(Number) } });
});
```

- [ ] **Step 2: Run the lifecycle tests and verify failure**

Run: `bun test apps/orchestrator/src/lease-lifecycle.test.ts`

Expected: FAIL because completion failures currently emit only `runner_failed` without termination evidence or correlation data.

- [ ] **Step 3: Implement correlation and evidence mapping**

Create `const correlationId = crypto.randomUUID()` at lifecycle start. Include it in internal logs and every lifecycle event payload. Track `sampleCount`, `lastSampleOccurredAt`, and the elapsed time since the previous sample. On normal completion, attach runtime termination evidence if available. On rejection or missing completion, synthesize `child_disappeared` or `service_host_error` only from the runtime adapter’s explicit cause; otherwise use a diagnostic state with `cause: "child_disappeared"`, `exitObserved: false`, and null resource values, while keeping `reason: "runner_failed"`.

Do not add `oom` merely because `completion` rejects. Keep the existing `updateMemoryPressure` path as the sole producer of `OutOfMemoryResult`, and merge its explicit evidence with termination evidence only when both are present.

- [ ] **Step 4: Run focused lifecycle tests and verify pass**

Run: `bun test apps/orchestrator/src/lease-lifecycle.test.ts apps/orchestrator/src/runtime.ts`

Expected: PASS for explicit OOM, unknown termination, cleanup failure, and existing resource-sampling behavior.

- [ ] **Step 5: Commit orchestrator evidence propagation**

```bash
git add apps/orchestrator/src/runtime.ts apps/orchestrator/src/lease-lifecycle.ts apps/orchestrator/src/worker-client.ts apps/orchestrator/src/lease-lifecycle.test.ts
git commit -m "feat: propagate runner termination evidence"
```

### Task 4: Verify end-to-end contracts and release behavior

**Files:**
- Modify: `apps/orchestrator/src/lease-lifecycle.test.ts` only for uncovered contract assertions
- Modify: `apps/windows-service-host/src/main.rs` only for test-discovered defects

**Interfaces:**
- Consumes all outputs from Tasks 1–3.
- Produces verified Rust binary behavior and type-safe worker event payloads.

- [ ] **Step 1: Run focused Rust and TypeScript suites**

Run: `cargo test --manifest-path apps/windows-service-host/Cargo.toml && bun test packages/contracts/src/orchestration.test.ts apps/orchestrator/src/lease-lifecycle.test.ts`

Expected: PASS with no sensitive fields in serialized records.

- [ ] **Step 2: Run workspace typecheck**

Run: `bun run typecheck`

Expected: PASS across contracts, orchestrator, control plane, and job agent.

- [ ] **Step 3: Run the build that packages the service host**

Run: `bun run build`

Expected: PASS and the Windows service-host artifact remains present in the release set.

- [ ] **Step 4: Inspect the diff for scope and classification regressions**

Run: `git diff HEAD~3 --stat && git diff HEAD~3 --check`

Expected: only the specified contract, orchestrator, and Windows service-host files are changed; no workflow, secret, or unrelated runtime changes appear.

- [ ] **Step 5: Commit any verified corrections**

```bash
git add packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts apps/orchestrator/src/runtime.ts apps/orchestrator/src/lease-lifecycle.ts apps/orchestrator/src/worker-client.ts apps/orchestrator/src/lease-lifecycle.test.ts apps/windows-service-host/Cargo.toml apps/windows-service-host/src/main.rs
git commit -m "chore: verify runner observability release"
```
