# Bounded Job Dispatch Concurrency

## Problem

Queued-job reconciliation processes jobs sequentially. A pool configured with `concurrency: 3` therefore admits only one job at a time while each job waits for GitHub preflight, JIT configuration, and worker dispatch.

## Design

Keep reconciliation ticks single-flight, but process queued jobs inside a tick with bounded parallelism. The reconciliation function will accept or derive a maximum number of concurrent job attempts and run independent jobs through a small worker pool. The bound prevents unbounded GitHub/API and worker load while allowing available pool slots to fill promptly.

Capacity remains authoritative in the existing reservation transaction. Each job reserves its routing slot before requesting JIT configuration. Existing in-memory reservation accounting prevents this reconciliation pass from selecting more jobs than the candidate pool capacity; database checks remain the cross-process safety mechanism.

## Error handling

Each job attempt retains its current isolated error handling. Preflight, reservation, JIT, dispatch, and cleanup failures update that job's report counters without cancelling unrelated attempts. GitHub rate-limit blocking remains scoped to the installation and prevents additional work for that installation.

## Testing

Add a regression test with three eligible queued jobs and a concurrency bound of three. The test pauses each job during an async stage and verifies all three reach that stage before any completes, proving the scheduler is no longer serial. Existing capacity and failure tests must continue to pass.
