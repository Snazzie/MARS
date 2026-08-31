# Worker Capacity Configuration Boundary

## Problem

Worker configuration currently compares administrator-selected appliance capacity against the worker's current `doctor.capacity.free*` telemetry. This rejects configuration while the worker is temporarily occupied and treats missing free-capacity telemetry as zero. Current resource availability belongs at dispatch time, not configuration time.

## Goals

- Store administrator-selected worker capacity and per-job policy limits without considering current utilization.
- Prevent dispatch from overcommitting actual worker resources.
- Preserve existing per-job, pool, organization, and concurrency safeguards.
- Make configuration behavior independent of transient or stale free-capacity telemetry.

## Non-goals

- Redesign worker telemetry.
- Change the meaning or units of `actual*` and `free*` doctor fields.
- Change worker runtime provisioning behavior.
- Add a new capacity schema or database column.

## Design

### Configuration

`configurePendingWorker` validates the submitted `WorkerConfiguration` schema and policy relationships, but MUST NOT compare appliance resources with `doctor.capacity.freeVcpu`, `freeMemoryBytes`, or `freeStorageBytes`.

The existing `workers.limits` fields remain the configured policy ceiling:

- `maxVcpuPerPod`
- `maxMemoryBytesPerPod`
- `maxStorageBytesPerPod`
- `maxConcurrentPods`

Configuration continues to persist the desired configuration and enqueue `worker.configure` as it does today.

### Dispatch

`reserveRoutingSlot` remains responsible for current-capacity admission. Under its existing worker/pool transaction lock, it continues to enforce:

- organization per-pod limits and concurrency;
- pool resource ceilings and concurrency;
- configured worker per-pod limits and concurrency;
- current worker free-capacity telemetry when available;
- rejection as `worker_capacity_exhausted` when the current worker cannot admit the request.

The reconciler continues to defer capacity-exhausted jobs rather than treating them as permanent failures.

### Error behavior

A valid configuration MUST NOT return `worker configuration exceeds capacity` solely because current free capacity is below the configured appliance capacity. Capacity exhaustion during dispatch remains an operational scheduling outcome.

No new API error shape is required for this change. Existing configuration validation and conflict errors remain unchanged.

## Data flow

1. Administrator submits total worker capacity and policy limits.
2. Control plane validates schema/policy and stores the configuration.
3. Worker applies the configuration and reports observed configuration.
4. Reconciler selects eligible jobs.
5. Reservation transaction checks current active leases and free capacity.
6. Capacity-unavailable jobs remain queued/deferred; admitted jobs are dispatched.

## Tests

Update configuration request tests to prove that configuration succeeds when reported free capacity is lower than the submitted appliance capacity.

Retain or add reservation tests proving that dispatch rejects/defer-capacity behavior when current worker capacity is exhausted. The test MUST cover aggregate active resource usage, not only per-job worker limits.

## Acceptance criteria

- No configuration path rejects based on `doctor.capacity.free*`.
- Dispatcher/reservation still prevents overcommit using current capacity and active leases.
- Existing worker policy ceilings continue to reject jobs exceeding configured per-pod limits.
- Configuration no longer returns HTTP 500 for this expected capacity-policy distinction.
