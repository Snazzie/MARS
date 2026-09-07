# Task 1 Report — Admission and reconciliation ordering

## Files changed

- `packages/db/src/leases.ts`
  - Renamed organization resource ceiling rejection to `organization_resource_ceiling_exceeded`.
  - Renamed organization concurrent lease rejection to `organization_capacity_exhausted`.
- `packages/db/src/leases.test.ts`
  - Added focused coverage for both organization reservation error names.
- `apps/control-plane/src/reconcile.ts`
  - Added optional `ReconcileDeps.preflight` callback.
  - Runs `reserve -> preflight -> JIT -> dispatch`.
  - Releases and decrements local reservation accounting when preflight returns false or throws.
  - Defers `organization_capacity_exhausted` with worker/pool capacity errors while preserving resource-ceiling failures.
  - Preserved installation blocking after rate-limit/JIT failures.
- `apps/control-plane/src/reconcile.test.ts`
  - Added coverage proving organization capacity is deferred before preflight/JIT/dispatch, resource-ceiling errors fail, and preflight false/error paths release reservations.
- `apps/control-plane/src/job-reconciler.ts`
  - Removed eager GitHub job preflight loop.
  - Loads all local queued rows and candidates before reconciliation.
  - Lazily constructs per-installation GitHub clients from the post-reservation preflight callback.
  - Preserved exact job/run/attempt validation, 404/410 missing handling, non-queued authoritative snapshots, installation blocking, and normalized label persistence/release behavior.
- `apps/control-plane/src/job-reconciler.test.ts`
  - Updated ordering and stale/missing expectations.
  - Added ten-job organization-capacity amplification regression (zero token/GitHub requests).
  - Added normalized changed-label persistence/release coverage.

## Verification

Command:

```text
bun test packages/db/src/leases.test.ts apps/control-plane/src/reconcile.test.ts apps/control-plane/src/job-reconciler.test.ts
```

Output:

```text
41 pass
0 fail
89 expect() calls
Ran 41 tests across 3 files.
```

`git diff --check` passed for all six Task 1 source/test files (Git reported only existing LF/CRLF normalization warnings).

## Concerns

- The development server/live GitHub/database scenarios were not run; this task was verified with the required focused tests only.
- An unrelated pre-existing working-tree change remains in `apps/web/src/components/JobResourceDetail.tsx` and is not included in the Task 1 commit.
