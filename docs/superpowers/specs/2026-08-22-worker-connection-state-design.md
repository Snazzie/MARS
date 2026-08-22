# In-Memory Worker Connection State

## Problem

`workers.connection_state` persisted WebSocket liveness. When a worker or control-plane process stopped without the close handler completing, the database retained `online` even though the dispatcher had no socket. Routing then exposed contradictory state.

## Decision

Connection status is process-local only. The authenticated worker socket map/dispatcher is the sole source of truth for whether a worker is connected and dispatchable.

The control plane must stop writing `connection_state` during authentication, socket close, worker join, or startup. Existing database reads remain only as compatibility input for old clients/tests; production control-plane APIs override the value from the live dispatcher before returning or making readiness decisions.

Persisted worker data remains responsible for durable identity, admission, configuration, doctor telemetry, and heartbeat timestamps. Those fields do not represent connection status.

## Data flow

1. Worker authenticates.
2. The control plane registers its socket in `WorkerCommandDispatcher`.
3. Routing calls `dispatcher.isConnected(workerId)`.
4. Socket close unregisters the socket; no database status update occurs.
5. Dashboard/API worker responses derive `connectionState` from the same dispatcher callback.
6. Restarting the control plane starts with no connected workers; workers become online only after re-authentication.

## Error handling

No stale persisted status can affect routing or readiness. A missing socket is offline immediately, including after process restart. Worker heartbeat timestamps may still be persisted for telemetry and health diagnostics, but are not used as connection truth.

## Tests

Cover that authentication and close do not issue `connection_state` updates, routing uses live dispatcher presence, and dashboard worker responses override stale database connection values with the callback result.
