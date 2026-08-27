# Per-worker lease preservation control

## Problem

`MARS_DEBUG_PRESERVE_LEASES` is injected into the Windows installer when the worker is downloaded. Changing the control-plane environment does not affect an installed worker and requires reinstalling it. The preservation policy also has no operator-visible per-worker state.

## Goals

- Enable or disable lease/container preservation for an individual worker at runtime.
- Apply changes immediately to running leases, future leases, and pending cleanup commands.
- Persist the desired value in the control-plane database.
- Persist the applied value on the worker so restart does not lose it.
- Deliver the change through the existing durable worker command/replay path.
- Expose the control through the dashboard API and dashboard UI for global administrators.
- Remove the environment-variable and installer-templating dependency.

## Non-goals

- Preventing runner communication failures or changing runner-loss classification.
- Preserving leases after worker revocation or explicit destructive removal.
- Changing lease allocation, capacity accounting, or cleanup retry policy.
- Automatically enabling preservation for existing workers.

## Data model

Add a non-null boolean `preserve_leases` column to `workers`, defaulting to `false`. This is the control-plane desired state. Worker detail responses expose `preserveLeases`.

The worker stores the applied value in its existing durable worker state file/data root. The local value is loaded before the worker reconnects. A missing value is treated as `false` for backward compatibility. The dashboard reports the desired value plus the existing durable command/application status; no second worker column is required.

The worker's doctor payload reports the applied value so the control plane can distinguish a pending command from an applied setting.

## Control-plane API and UI

Add a global-admin-only mutation for an organization worker:

```text
POST /api/organizations/:organizationId/workers/:workerId/lease-preservation
{ "enabled": true | false }
```

The endpoint validates worker ownership, writes `workers.preserve_leases`, creates a durable worker command, and returns the updated worker detail or an equivalent mutation response. Existing idempotency and dashboard invalidation conventions apply.

The worker detail UI adds a clearly labeled toggle such as `Preserve failed containers`, with explicit warning text that enabling it retains runtime resources and can consume worker capacity. The UI reflects desired state and command/application status using existing worker configuration/connection indicators.

## Command protocol

Add a dedicated command type `worker.set_lease_preservation` with payload:

```json
{ "enabled": true }
```

The command is durable and replayable. The worker validates that the command targets its own worker ID, persists the value atomically to the local state file, updates its in-memory setting, and emits an acknowledgement event. The control plane records the applied state only after a valid acknowledgement, using the existing command acknowledgement/replay conventions.

On worker reconnect, unacknowledged commands replay. If the worker is offline, the database remains the source of truth and the command remains pending until delivery.

## Runtime behavior

Lifecycle cleanup reads the worker's current in-memory preservation setting after runner completion/failure and before stop/remove:

- `true`: skip `stopLease` and `removeLease`, emit `lease.failed` with reason `debug_preserve`, and leave the runtime available for inspection.
The same current setting is checked by durable cleanup-command handling. This covers leases whose original lifecycle lost communication and were later recovered by control-plane inventory reconciliation.

Changing the setting affects already-running leases and pending cleanup commands. When disabling preservation, the control plane transitions existing `debug_preserved` leases for that worker back to cleanup-pending and dispatches normal stop/remove commands. This makes disable immediate for already-preserved runtimes; command delivery remains durable if the worker is offline. Enabling preservation does not retroactively alter cleanup commands already acknowledged.


Remove `MARS_DEBUG_PRESERVE_LEASES` from `.env.example`, compose configuration, installer substitution, worker service environment, and all runtime checks.

## Failure handling and security

- Only global administrators may mutate the setting.
- Invalid or stale worker IDs return the existing not-found/authorization errors.
- Command dispatch failure leaves the database desired state updated and the durable command pending/replayable; the API reports the existing command/worker availability status rather than silently claiming application.
- Local persistence failure prevents acknowledgement and leaves the prior in-memory setting unchanged.
- The setting and command payload contain no secrets.
- Preservation remains disabled by default for all existing and newly enrolled workers.

## Testing

Add contract tests for:

1. Schema/default and worker detail serialization.
2. Authorized enable/disable API mutations, idempotency, invalid worker access, and command dispatch.
3. Command persistence, replay, local state persistence, acknowledgement, and restart loading.
4. Lifecycle cleanup with the setting enabled and disabled.
5. Durable cleanup commands observing a runtime toggle.
6. Dashboard toggle rendering and mutation refresh.
7. Installer output no longer containing the environment-variable placeholder or environment assignment.

Verification must include focused package tests, control-plane/orchestrator tests, dashboard tests, and a smoke path that toggles a worker while a lease is active and confirms cleanup behavior changes without reinstalling the worker.
