# Task 2 report: Persist separate runner status through control plane

## Implemented

- Added canonical `WorkerRunnerCacheStatus` and `worker.runner_cache_status` schemas to the orchestration contracts. The status is strict and validates UUID generation, positive integer capacity, canonical nonnegative decimal byte strings, nonnegative safe entry counts, and offset-aware timestamps.
- Included the runner status event in both `WorkerCacheTelemetry` and `WorkerEventPayload`, preserving strict telemetry envelopes.
- Added generation-safe runner telemetry persistence in `applyWorkerCacheTelemetry`. The handler validates the payload, locks the worker cache status row inside a transaction, requires an exact current-generation match, and atomically updates runner enabled, capacity, size, count, and observed-at columns. Stale or malformed events leave Actions snapshot and inventory untouched.
- Added nullable runner telemetry columns to the canonical runtime schema, baseline migration SQL, and Drizzle schema. Runner capacity uses PostgreSQL `bigint` to match the safe integer contract. Runtime `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements support in-place upgrades; absent runner telemetry remains NULL. Snapshot generation rollover clears prior-generation runner fields.
- Added an explicit in-place upgrade path for the prior final baseline journal in `migrateDatabase`: it applies the runner-column ALTERs transaction-safely/idempotently and stamps the journal with the current baseline hash while continuing to reject unknown or unsafe migration states.
- Added contract coverage for valid runner status, strict unknown-field rejection, negative counts, invalid decimal byte values, and event payload parsing.
- Added database coverage for matching-generation updates and stale-generation no-op behavior.
- Added explicit exclusion for `worker.runner_cache_status` in direct lease-event handling so malformed dispatch cannot fall through to lease SQL; authenticated routing remains owned by `applyWorkerCacheTelemetry`.
- Preserved unrelated existing modifications in `apps/control-plane/src/job-discovery.ts` and `job-discovery.test.ts`.

## Verification

Command run:
```text
bun test packages/contracts/src/orchestration.test.ts packages/db/src/worker-cache.test.ts packages/db/src/schema.test.ts packages/db/src/migrate.test.ts apps/control-plane/src/worker-lifecycle.test.ts
```

Result: **78 passed, 0 failed** across five focused suites (285 expectations).

Project-wide formatters, linters, and tests were intentionally not run per the task brief.
