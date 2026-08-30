# Centralized Capacity-Aware Dispatch Design

## Goal

Keep job assignment in the control plane while preventing repeated capacity failures and unnecessary log noise when workers are full.

## Decision

The control plane remains the sole job assigner. Workers do not poll or request work. The control plane discovers queued GitHub jobs, selects matching workers, reserves leases transactionally, generates JIT credentials, and dispatches leases over the authenticated worker websocket.

Capacity exhaustion is an expected deferred state, not a job failure. A queued job remains queued when the authoritative reservation check reports insufficient worker capacity. The reconciliation loop must avoid emitting one error per expected capacity deferral and may report only aggregate actionable failures.

## Capacity boundary

`scheduler.ts` performs preliminary candidate filtering from the latest worker doctor and pool snapshot. `packages/db/src/leases.ts` remains authoritative: it locks the worker and pool, checks active leases, worker limits, pool resources, and reported free CPU/memory, then either reserves the lease or rejects it. A race between preliminary selection and reservation is expected and safe.

## Retry behavior

Capacity-deferred jobs remain eligible for later reconciliation. Lease completion, failure, expiry, or a fresh worker doctor update provides the natural capacity-change signal. The existing periodic reconciliation remains as a bounded fallback; it must not turn an expected full-worker condition into repeated error logs.

## Logging

Per-job `worker_capacity_exhausted` messages are suppressed or downgraded from errors because they represent normal backpressure. Genuine failures such as invalid repository data, JIT generation errors, dispatch errors, and database failures remain visible. Aggregate reconciliation output may report reserved, deferred, and unexpected-failure counts when non-zero.

## Scope

Change only control-plane scheduling/reconciliation classification, retry signaling, and tests. Do not move GitHub polling or JIT generation to workers. Do not weaken transactional lease checks. Do not alter worker websocket ownership or heartbeat protocol.

## Acceptance criteria

- Control plane continues assigning jobs; workers never poll for work.
- A full worker causes queued jobs to remain queued/deferred.
- `worker_capacity_exhausted` does not produce repeated per-job error logs.
- Capacity becoming available allows a queued job to be assigned on the next reconciliation signal or bounded fallback tick.
- Transactional reservation still prevents duplicate claims and preserves all existing resource-limit checks.
- Existing successful dispatch, JIT failure, lease release, and unexpected-error behavior remains intact.
