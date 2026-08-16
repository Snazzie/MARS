# Worker Configuration Reconciliation Design

## Problem

The control plane records a worker as configured after one exact `worker.configured` acknowledgement, but the Windows and macOS orchestrators keep the applied runtime limits only in process memory. A worker process restart restores executable defaults. When that worker reconnects, the control plane retains `configuration_state='ready'`, does not resend the desired configuration, and may schedule work that the restarted worker rejects.

The Workers page consequently reports stale readiness. It can say `Ready` when the live runtime is enforcing different limits.

## Decision

The control plane is authoritative for desired worker configuration. It persists the complete desired configuration independently of command history and reapplies that configuration on every authenticated worker connection. A worker is schedulable only after the current connection has acknowledged the current desired revision with exact observed values.

The UI reports success only after that exact acknowledgement. Command creation or delivery is not success.

## State Model

Worker configuration uses four explicit states:

- `unconfigured`: no desired configuration exists.
- `applying`: a desired configuration exists, but the current worker connection has not exactly acknowledged it.
- `ready`: the current connection exactly acknowledged the desired revision and observed values.
- `error`: the worker returned a malformed or mismatched acknowledgement for the current command.

Persist these worker fields:

- `desired_configuration`: the complete validated `WorkerConfiguration` value, including appliance allocation, runtime limits, and guest platforms.
- `configuration_revision`: the SHA-256 revision of the canonical desired configuration.
- `configuration_command_id`: the current delivery command.
- `applied_configuration_revision`: the last exactly acknowledged revision.
- `configuration_applied_at`: the time of the last exact acknowledgement.

`commands` remains the durable delivery ledger, not the source of desired state. Command retention must not erase the configuration required after a later worker restart.

## Configuration Save Flow

When an administrator saves worker configuration:

1. Validate the full configuration against worker identity, guest-platform rules, drain requirements, and observed host capacity.
2. Canonicalize it and calculate the revision.
3. In one transaction, persist `desired_configuration` and `configuration_revision`, create a `worker.configure` command, set `configuration_command_id`, set state to `applying`, and clear neither the prior applied revision nor its timestamp.
4. Replay commands to the connected worker.
5. Return command acceptance to the client, but do not report the configuration as updated.

Keeping the prior applied revision and timestamp allows the UI to report the last successful application while a replacement is pending or has failed. The worker remains unschedulable unless state is `ready` and the applied revision equals the desired revision.

## Reconnect Reconciliation

After socket challenge authentication succeeds, before the worker can affect schedulable live state:

1. Lock the worker row.
2. If no desired configuration exists, leave it `unconfigured`.
3. If a pending `worker.configure` command already targets the desired revision, reuse it.
4. Otherwise create a new command from `desired_configuration`, update `configuration_command_id`, and set state to `applying`.
5. Replay the command on the authenticated socket.

Every authenticated connection performs this reconciliation. Resending is intentional and idempotent: it avoids trusting process-local or worker-local state after either a process restart or an ambiguous network failure. Reconnects reuse an existing pending current-revision command to prevent command-table growth.

The database connection state and in-memory socket registry may become online after authentication, but scheduling continues to require configuration state `ready` and matching desired/applied revisions.

## Acknowledgement Flow

A `worker.configured` event is accepted only when all of these match the current worker row and command:

- worker ID;
- command ID;
- desired revision;
- canonical desired appliance allocation;
- canonical desired runtime limits;
- canonical desired guest platforms.

An exact acknowledgement atomically:

- sets state to `ready`;
- sets `applied_configuration_revision` to the desired revision;
- sets `configuration_applied_at=now()`;
- marks the command acknowledged through the existing dispatcher;
- writes a `worker.configuration_applied` audit event.

A malformed or mismatched acknowledgement sets state to `error` only when it refers to the current command and revision. Stale acknowledgements cannot overwrite newer desired state. The previous successful applied revision and timestamp remain available for diagnosis, but the worker is not schedulable.

Disconnecting does not erase desired configuration or the last acknowledgement. A subsequent authenticated connection always moves a configured worker through `applying` and exact acknowledgement before scheduling resumes.

## UI Contract

`WorkerDetail` exposes:

- the four-state `configurationState`;
- `configurationRevision`;
- `appliedConfigurationRevision`;
- `configurationAppliedAt`.

The Workers page renders:

- `unconfigured`: `Needs configuration`;
- `applying`: `Applying configuration…`;
- `ready`: `Configuration updated` and the acknowledgement timestamp;
- `error`: `Configuration update failed`, plus the last successful acknowledgement time when one exists.

The page polls every two seconds while any adopted worker is `applying`. Saving the configuration form closes the form and invalidates worker queries, but does not display a success message based only on the mutation response. Success appears only when a subsequent worker query returns `ready`, matching desired/applied revisions, and `configurationAppliedAt`.

Operational connection state remains separate. An offline worker can retain its last successful configuration timestamp, but it is displayed as offline and cannot schedule work.

## Failure Handling

- Worker offline during save: desired state persists as `applying`; authentication later creates or replays the command.
- Socket closes during delivery: the next authenticated connection reuses the pending current-revision command.
- Control-plane restart: desired state remains on the worker row; worker authentication reconstructs delivery without relying on retained process state.
- Worker restart: reconnect forces reapplication before scheduling.
- Mismatched observation: state becomes `error`; no scheduling occurs.
- New configuration while an old acknowledgement is in flight: command and revision checks reject the stale acknowledgement.

## Verification

Automated behavioral coverage must prove:

1. Saving configuration persists complete desired state and reports `applying`, not `ready`.
2. An exact acknowledgement records applied revision/time and returns the worker to `ready`.
3. A mismatched acknowledgement produces `error` and cannot make the worker schedulable.
4. A configured worker reconnect changes from `ready` to `applying`, receives the desired configuration, and returns to `ready` only after exact acknowledgement.
5. Duplicate reconnect handling reuses a pending current-revision command rather than creating duplicates.
6. A control-plane restart can reconstruct a command from desired state after old commands have been pruned.
7. Stale acknowledgements cannot overwrite a newer configuration.
8. The Workers page renders `Applying configuration…`, then `Configuration updated` with the acknowledgement time, and polls only while application is pending.
9. A worker restarted after receiving 10-vCPU/10-GiB limits reapplies those limits and accepts a matching lease instead of reverting to 4-vCPU/6-GiB defaults.

A runtime smoke must restart the actual Windows worker service, observe the UI transition through `applying` to `ready`, and then dispatch a `10VCPU`/`10G` workflow job successfully.
