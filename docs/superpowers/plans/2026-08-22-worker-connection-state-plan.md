# Worker Connection State Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make persisted worker connection state converge to reality after control-plane restart or lost heartbeats.

**Architecture:** Add a small connection-state reconciliation module with startup reset and periodic heartbeat expiry. Wire it into control-plane startup without changing dispatcher routing, which remains authoritative for live dispatchability.

**Tech Stack:** Bun, TypeScript, postgres tagged SQL, bun:test.

## Global Constraints

- Startup reconciliation must run before scheduling jobs.
- Startup SQL changes only `connection_state`.
- Heartbeat expiry must use server-side `now()` and only update rows currently marked online.
- Watchdog failures are logged and retried; they must not stop WebSocket or scheduler operation.
- No manual database repair or service-state mutation.

### Task 1: Add connection-state reconciliation module

**Files:**
- Create: `apps/control-plane/src/worker-connection-state.ts`
- Test: `apps/control-plane/src/worker-connection-state.test.ts`

**Interfaces:**
- `resetPersistedWorkerConnections(db): Promise<void>` updates online workers to offline.
- `expireStaleWorkerConnections(db, staleAfterMs): Promise<number>` updates online workers whose `last_heartbeat_at` is older than the supplied interval and returns affected-row count.

Steps:
- Write tests using the repository's mock tagged database pattern; assert exact SQL intent and affected-row handling.
- Run the focused test and verify failure before implementation.
- Implement both functions with tagged SQL and no unrelated worker mutations.
- Run the focused test and verify pass.

### Task 2: Wire lifecycle reconciliation into control plane

**Files:**
- Modify: `apps/control-plane/src/index.ts`
- Test: `apps/control-plane/src/reconcile-loop.test.ts` or the new module test where lifecycle behavior is isolated.

**Interfaces:**
- Startup invokes `resetPersistedWorkerConnections(db)` before `startReconciliationScheduler`.
- A `setInterval` watchdog invokes `expireStaleWorkerConnections(db, configuredWindow)` and logs failures without throwing out of the timer callback.

Steps:
- Add environment-configurable interval/window with safe defaults larger than the heartbeat interval.
- Add startup invocation and fail startup if reset rejects.
- Add watchdog timer with error logging and affected-row logging only when rows change.
- Run focused control-plane tests.

### Task 3: Verify behavior

**Files:**
- Existing focused tests only.

Steps:
- Run `bun test apps/control-plane/src/worker-connection-state.test.ts apps/control-plane/src/worker-connection.test.ts`.
- Run the control-plane typecheck if available.
- Inspect the final diff for scope and report exact evidence.
