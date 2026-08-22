# In-Memory Worker Connection State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop stale persisted worker connection state from claiming workers are online.

**Architecture:** Use `WorkerCommandDispatcher.isConnected(workerId)` as the sole live connection predicate. Remove connection-state writes from worker authentication, socket close, and enrollment. Inject the predicate into HTTP/dashboard code so API responses and readiness checks agree with routing.

**Tech Stack:** Bun, TypeScript, postgres tagged SQL, bun:test.

## Global Constraints

- Connection status is process-local only.
- No control-plane path writes `workers.connection_state` for liveness.
- Dispatcher socket presence is authoritative for routing and readiness.
- Heartbeat timestamps remain telemetry only.

### Task 1: Remove persisted liveness writes

**Files:** `apps/control-plane/src/worker-connection.ts`, `apps/control-plane/src/index.ts`, `apps/control-plane/src/worker-requests.ts`, `apps/control-plane/src/http/dashboard-routes.ts`.

Remove `connection_state='online'` and `connection_state='offline'` mutations while retaining durable identity, doctor, admission, and configuration updates.

### Task 2: Project live state into APIs

**Files:** `apps/control-plane/src/http/types.ts`, `apps/control-plane/src/index.ts`, `apps/control-plane/src/http/dashboard-routes.ts`, `packages/db/src/dashboard.ts`.

Add an optional `workerConnected` callback, wire it to `dispatcher.isConnected`, and use it to override dashboard worker DTO state and readiness checks.

### Task 3: Verify behavior

Run focused worker connection, dashboard, database dashboard, scheduler, and control-plane typecheck tests. Confirm no production source writes `connection_state` for socket liveness.
