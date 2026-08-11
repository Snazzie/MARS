# Post-Enrollment Resource Configuration

## Problem

Worker enrollment currently carries administrator-selected resource limits in the worker bootstrap contract. Enrollment should establish worker identity and report observed capacity only. Resource policy and appliance sizing must be selected explicitly in the UI after an administrator accepts the pending worker.

## Goals

- Remove administrator resource policy from the enrollment request.
- Keep enrollment limited to platform, cryptographic identity, machine identity, and doctor/capacity telemetry.
- Let a global administrator select organization, appliance sizing, and runtime ceilings during adoption.
- Prevent scheduling until the worker has applied and acknowledged the selected configuration.
- Preserve fail-closed validation against reported capacity and safe-integer bounds.

## Non-goals

- Changing worker authentication or enrollment-code secrecy.
- Adding new runtime drivers.
- Automatically inferring resource policy from reported capacity.
- Allowing organization administrators to adopt workers.

## Data flow

1. The installer starts the worker with a one-use enrollment code.
2. The worker calls `POST /api/workers/join` with identity and telemetry, but no `limits`.
3. The control plane stores the worker as `pending` with `limits = null` and reports it in the Workers UI.
4. A global administrator opens the adoption form, selects organization, appliance vCPU/RAM/disk, and runtime ceilings/concurrency.
5. The control plane validates the request against immutable reported capacity and positive safe-integer constraints, persists the selected configuration, and sends a secret-free configuration command.
6. The worker applies the configuration and acknowledges it with the command ID and observed values.
7. The control plane marks configuration ready and enables scheduling only after the acknowledgement matches the requested configuration.

## Contracts

`WorkerBootstrapRequest` no longer contains `limits`. The pending worker response exposes reported capacity and nullable policy limits. The adoption request contains organization ID plus appliance sizing and runtime ceilings. All resource values remain positive safe integers; requested values cannot exceed reported capacity or configured system/Kata reserves.

The configuration command contains no enrollment code, GitHub token, private key, or job claim. Commands remain durable, ID-addressed, acknowledged, and replayable through the existing worker command channel.

## State behavior

- `pending/unconfigured`: identity accepted; no jobs or configuration-dependent commands.
- `adopted/unconfigured`: administrator accepted identity and saved policy; configuration command pending.
- `adopted/ready`: worker acknowledged the exact policy and doctor checks pass; scheduling allowed.
- `adopted/error`: configuration or doctor failure; active work drains and new work is blocked.
- Rejected, revoked, or conflicting workers never receive jobs or configuration.

Adoption is idempotent for the same request. A conflicting admission state or mismatched worker identity remains a conflict. Reconfiguration that lowers active ceilings drains current work before applying the new configuration.

## UI

The enrollment wizard generates only the one-use code and installer commands. It has no resource fields. The pending worker card displays fingerprint, platform, reported capacity, and doctor status. The Adopt action opens a form for organization, appliance sizing, and runtime ceilings. The worker detail view displays requested, observed, and effective values, configuration state, acknowledgement errors, and a retry action.

## Error handling

- Enrollment payloads containing `limits` are rejected as invalid rather than silently accepted.
- Missing, fractional, zero, negative, unsafe, or over-capacity values return a validation error without changing admission state.
- Configuration acknowledgement mismatches set configuration error and keep scheduling blocked.
- Worker disconnect during configuration leaves the command durable for replay; it does not mark the worker ready.

## Verification

Add tests for limit-free enrollment, rejection of enrollment limits, adoption validation, over-capacity rejection, command persistence/replay, acknowledgement matching, and scheduling gates. Exercise the browser flow from pending worker through adoption and ready state. Confirm no enrollment request, persisted bootstrap record, command, or log contains plaintext enrollment codes or unrelated secrets.
