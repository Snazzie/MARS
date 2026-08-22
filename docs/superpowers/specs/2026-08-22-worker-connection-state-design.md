# Worker Connection State Convergence

## Problem

The control plane persists `workers.connection_state='online'` when a worker authenticates, but live dispatchability is held in the process-local WebSocket dispatcher. If the control plane or worker exits without the close handler completing, the database row remains online. Routing then has contradictory state: SQL reports online while the dispatcher reports no connected worker.

## Decision

Use both startup reconciliation and a heartbeat watchdog.

### Startup reconciliation

At control-plane startup, mark persisted worker rows `connection_state='offline'` before scheduling reconciliation. This clears state left by a previous control-plane process. A worker that connects after startup sets itself online through the existing authenticated connection path.

The update must be limited to `connection_state='online'`; it must not alter admission, configuration, draining, leases, or heartbeat timestamps.

### Heartbeat watchdog

Run a bounded periodic task in the control plane. It marks workers offline when their heartbeat is older than a fixed liveness window. The update must only affect rows still marked online and must use a server-side timestamp comparison. The watchdog is defensive; routing still requires the live dispatcher socket.

The liveness window is larger than the normal ping interval to tolerate scheduling jitter, while ensuring abandoned state converges without operator intervention.

## Data flow

1. Process starts.
2. Startup SQL clears stale persisted online states.
3. Worker authenticates over WebSocket and updates its row online with `last_heartbeat_at=now()`.
4. Worker heartbeat/pong traffic refreshes `last_heartbeat_at`.
5. Watchdog marks rows offline after the liveness window.
6. Dispatcher socket presence remains the authoritative dispatch gate.

## Error handling

Startup reconciliation failure must fail control-plane startup rather than silently retaining stale state. Watchdog query failures are logged and retried on the next interval; they must not stop the scheduler or WebSocket server.

## Tests

Add focused tests for the state transition SQL behavior and watchdog scheduling/error isolation. Existing worker connection tests must continue to prove that a worker is not dispatchable before authentication and is online only after successful activation.
