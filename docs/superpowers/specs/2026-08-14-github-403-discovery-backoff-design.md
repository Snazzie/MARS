# GitHub 403 Discovery Backoff Design

## Goal

Stop repeatedly polling repositories that GitHub has denied with HTTP 403 while preserving an explicit, administrator-controlled recovery path.

A denied repository is excluded from automatic job discovery for 24 hours. A global administrator can queue an earlier retry for one repository from the repository registry. The HTTP request only queues work; the existing discovery scheduler performs the GitHub request.

## Current behavior

`discoverAvailableRepositoryJobs()` selects every available repository on every discovery cycle. A per-repository failure increments the cycle's failure count, but no failure state is persisted. A repository returning `github_403` is therefore retried every 30 seconds and produces repeated GitHub requests and log messages.

The repository registry already lists each repository and hosts GitHub connection actions. It is the appropriate surface for showing a paused repository and requesting a retry.

## Persistence

Add nullable columns to `dashboard_repositories`:

- `discovery_error text`
- `discovery_retry_at timestamptz`

These columns belong to the repository because the cooldown has the same lifecycle and tenant boundary as the repository. A separate table adds a join and deletion lifecycle without providing a second independent entity.

State meanings:

| Persisted values | Meaning |
| --- | --- |
| `discovery_error IS NULL`, `discovery_retry_at IS NULL` | Active |
| `discovery_error = 'github_403'`, `discovery_retry_at > now()` | Paused |
| `discovery_error = 'github_403'`, `discovery_retry_at <= now()` | Recheck queued |

No in-memory cooldown is used. The state must survive control-plane restarts and remain consistent if another process reads the repository registry.

## Automatic discovery

The normal discovery query selects available repositories from approved installations only when:

```sql
discovery_retry_at IS NULL OR discovery_retry_at <= now()
```

Per-repository outcomes update state as follows:

- `github_403`: set `discovery_error='github_403'` and `discovery_retry_at=now() + interval '24 hours'`.
- Successful discovery: clear both columns.
- `github_404`: retain the existing behavior that marks the repository unavailable.
- Any other error: retain the existing normal-cycle retry behavior and failure accounting; do not create a 24-hour cooldown.

Repositories skipped because their retry time is in the future are not included in the discovery report's repository or failure counts. A known paused repository therefore does not make discovery health stale or unsuccessful.

A forced repository becomes eligible by setting its retry time to `now()`. The existing non-overlapping scheduler picks it up on the next cycle, normally within 30 seconds. If GitHub still returns 403, that attempt installs a new 24-hour deadline. If it succeeds, the persisted error and deadline are cleared.

## Dashboard contract

Extend `RepositorySummary` with:

- `discoveryState: "active" | "paused" | "queued"`
- `discoveryRetryAt: string | null`

The database listing derives `discoveryState` from the persisted fields and current time. `discoveryRetryAt` is exposed only as an operational deadline; the raw internal error value is not part of the dashboard contract.

Both organization-scoped and all-workspace repository listings return the same fields.

## Force-recheck API

Add:

```text
POST /api/organizations/:organizationId/repositories/:repositoryId/discovery/recheck
```

Requirements:

- The caller must be a global administrator.
- The repository must belong to the requested organization and remain available through an approved installation.
- The request requires `Idempotency-Key` and uses the existing dashboard mutation record.
- The repository must currently have `discovery_error='github_403'` and a future retry deadline.
- The mutation sets `discovery_retry_at=now()` and leaves `discovery_error='github_403'` intact so the UI can represent the durable queued state.
- The route invalidates the repository dashboard key.
- A newly accepted request returns HTTP 202 with `{ "queued": true }`.
- A repeated idempotent request returns the same accepted result without issuing or scheduling duplicate GitHub work.
- A repository that is not paused returns HTTP 409. An unknown or cross-tenant repository returns HTTP 404.
- The endpoint never calls GitHub directly.

## Repository registry UI

Each repository row shows discovery state separately from installation access:

- Active: no additional warning or action.
- Paused: show `Discovery paused until <time>` and, for global administrators, a **Recheck now** button.
- Queued: show `Recheck queued`; disable the button.

Workspace members who are not global administrators can see the paused state and retry deadline but cannot trigger the mutation. The action is per repository; there is no bulk workspace action.

After an accepted mutation, the client updates or invalidates the repository query so the row changes to queued. Subsequent repository refreshes show either a renewed pause after another 403 or active state after success.

## Error handling and concurrency

The database is authoritative. UI state does not optimistically report a successful GitHub check.

The existing scheduler prevents overlapping discovery cycles within one control-plane process. An idempotent force request only changes repository eligibility and cannot directly create overlapping GitHub requests. If multiple control-plane processes are introduced later, discovery claiming will require database coordination as a separate scheduler concern; this feature does not introduce an in-memory lock or pretend to solve multi-process scheduling.

Repository uninstallation or removal retains existing availability behavior. Foreign keys and repository deletion remove cooldown state with the repository because the state is stored on the same row.

## Verification

### Database and discovery

- Schema migration is repeatable and preserves existing repositories as active.
- Repository listings map active, paused, and queued persisted values into the dashboard contract.
- A future retry deadline excludes a repository from discovery.
- A 403 writes a deadline approximately 24 hours in the future.
- A successful retry clears both persisted fields.
- 404 and non-403 behavior remain unchanged.

### HTTP

- Global administrators can queue one paused repository and receive HTTP 202.
- Non-admin members receive HTTP 403.
- Cross-tenant and unknown repositories receive HTTP 404.
- Active or already queued repositories receive HTTP 409 unless the same idempotency key is replayed.
- Replaying the accepted idempotency key converges without a second mutation.

### UI

- Paused rows show the retry deadline.
- Only global administrators receive the enabled **Recheck now** action.
- Accepted requests transition the row to `Recheck queued`.
- Queued rows cannot be submitted repeatedly.

### End-to-end

Using the real control-plane and web UI, seed or produce a paused repository, click **Recheck now**, observe HTTP 202 and the queued state, then run the scheduler and observe either active state on success or a new 24-hour pause on another 403.
