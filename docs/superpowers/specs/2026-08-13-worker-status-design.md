# Worker Status in Workers and Pools

## Goal
Make worker availability and readiness visible in both the Workers and Runner Pools views.

## Design
Use the existing `WorkerDetail` fields; do not add a new status API or database schema.

### Workers view
Each worker card displays two explicit statuses:

- Operational: `Online` or `Offline` (and `Draining` when applicable).
- Readiness: `Ready`, `Needs configuration`, or `Error`.

The existing admission state remains available as supporting worker metadata, not as a replacement for operational/readiness status.

### Pools view
Each pool card displays worker coverage derived from the existing worker list:

- Worker-bound pools show the bound worker's operational and readiness status.
- Shared pools aggregate matching workers and show online and ready counts.
- Pools with zero ready workers show a clear `No ready workers` warning.

Pool enablement remains separate from worker status; an enabled pool with no ready workers is visibly unavailable rather than incorrectly presented as healthy.

## Data flow
The UI fetches the existing global pool and global worker summaries, then joins pool workers by `workerId` where present. Shared pools use platform/driver-compatible worker counts. No persistence changes are needed.

## Error handling
Worker-status data follows the existing query error and loading states. If worker data cannot be loaded, pool data remains visible with an explicit unavailable-status label rather than a fabricated healthy state.

## Verification
- Contract/typecheck passes.
- Existing Workers and Pools tests pass.
- Add focused UI assertions for online/offline, readiness, shared-pool counts, and zero-ready warnings.
- Browser smoke test confirms both views render the statuses using live control-plane data.
