# Runner Diagnostics Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve GitHub runner `_diag` logs before sandbox cleanup and provide a temporary environment-controlled mode that leaves failed/successful leases intact for debugging.

**Architecture:** Keep existing raw runtime diagnostics and per-worker diagnostic persistence. Extend the Windows container diagnostic collection to copy runner `_diag` files before the container is stopped or removed. Gate lease stop/removal behind `MARS_DEBUG_PRESERVE_LEASES=1`, emitting an explicit event/log when preservation is active. Diagnostic failures must not prevent normal cleanup when preservation is disabled.

**Tech Stack:** Bun, TypeScript, PowerShell, Windows containers, existing worker diagnostic chunk protocol.

## Global Constraints

- Do not expose tokens, JIT configuration, authorization headers, or signed URLs in diagnostics.
- Keep diagnostics bounded and chunked through the existing worker event path.
- Preserve existing cleanup behavior unless `MARS_DEBUG_PRESERVE_LEASES=1` is set.
- Cleanup-disable mode is temporary debugging support, not the production default.
- Do not alter runner binaries or add a new service.

---

### Task 1: Preserve runner `_diag` files in Windows diagnostics

**Files:**
- Modify: `apps/orchestrator/src/windows-container.ts`
- Modify: `apps/orchestrator/src/lease-lifecycle.ts`
- Test: `apps/orchestrator/src/lease-lifecycle.test.ts`

**Interfaces:**
- Extend the existing raw diagnostic collection contract to include runner `_diag` file contents or a clearly delimited diagnostic section.
- Keep `collectRawDiagnostics(leaseId): Promise<string>` compatible with existing drivers.

- [ ] **Step 1: Add a failing lifecycle assertion**
  Add a fake driver with `collectRawDiagnostics` returning a manifest containing `Runner_*.log` and `Worker_*.log`; assert the emitted `diagnostic.chunk` contains both names and contents.

- [ ] **Step 2: Run the focused test and verify failure**
  Run `bun test apps/orchestrator/src/lease-lifecycle.test.ts`; expect the new assertion to fail because the current fake/collection path does not include runner logs.

- [ ] **Step 3: Implement bounded `_diag` collection**
  In the Windows container driver, before stop/removal, copy/read only `_diag\Runner_*.log` and `_diag\Worker_*.log`, cap total bytes, redact obvious credential-bearing lines, and append a manifest containing lease/container identity and collection errors. Keep Docker inspect and Docker log capture.

- [ ] **Step 4: Run focused tests**
  Run `bun test apps/orchestrator/src/lease-lifecycle.test.ts apps/orchestrator/src/windows-container.test.ts`; expect PASS.

### Task 2: Add temporary lease preservation mode

**Files:**
- Modify: `apps/orchestrator/src/lease-lifecycle.ts`
- Test: `apps/orchestrator/src/lease-lifecycle.test.ts`
- Modify: `.env` only if needed for local debugging; do not commit secrets or enable the flag by default.

**Interfaces:**
- Environment variable: `MARS_DEBUG_PRESERVE_LEASES=1`.
- When enabled, skip `stopLease` and `removeLease` after diagnostics and emit a redacted warning/event identifying the lease.

- [ ] **Step 1: Add a failing preservation test**
  Set `Bun.env.MARS_DEBUG_PRESERVE_LEASES='1'`, run the lifecycle with spies, and assert neither cleanup method is called; restore the environment in `finally`.

- [ ] **Step 2: Run the focused test and verify failure**
  Run `bun test apps/orchestrator/src/lease-lifecycle.test.ts`; expect the preservation assertion to fail.

- [ ] **Step 3: Implement the environment gate**
  Evaluate the flag at cleanup time. If enabled, skip both cleanup calls and emit one warning. If disabled, preserve current stop-then-remove behavior and failure event semantics.

- [ ] **Step 4: Run focused tests**
  Run `bun test apps/orchestrator/src/lease-lifecycle.test.ts`; expect PASS.

### Task 3: Verify end-to-end local debugging behavior

**Files:**
- No source changes unless verification reveals a defect.

- [ ] **Step 1: Enable preservation only in the current local process environment**
  Launch the orchestrator/control-plane with `MARS_DEBUG_PRESERVE_LEASES=1`; do not commit this setting as a default.

- [ ] **Step 2: Exercise one disposable Windows job**
  Confirm the lease/container remains available after runner exit and that the diagnostic directory includes runner logs.

- [ ] **Step 3: Run the changed behavioral tests**
  Run `bun test apps/orchestrator/src/lease-lifecycle.test.ts apps/orchestrator/src/windows-container.test.ts`.

- [ ] **Step 4: Run typecheck**
  Run `bun run typecheck` from the repository root.

- [ ] **Step 5: Disable preservation after investigation**
  Remove/unset `MARS_DEBUG_PRESERVE_LEASES` before returning normal cleanup to production behavior.
