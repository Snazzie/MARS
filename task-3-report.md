# Task 3 report

Implemented the dashboard projection and UI separation between GitHub Actions cache state and runner-package cache state.

## Changes

- Extended `WorkerCacheSummary` and `WorkerHealthCache` with nullable effective runner configuration and runner-package aggregate telemetry fields.
- Extended worker detail/list and live-health dashboard SQL projections to read runner cache columns, preserving existing Actions `entryCount`/`sizeBytes` semantics.
- Added dashboard mapping defaults for pre-telemetry runner state (`null` effective configuration, zero runner entries/bytes) and populated runner telemetry.
- Relabeled health metrics to `Actions entries` and `Actions size`; added runner enabled, capacity, entries, size, and observed-time fields. Proxy availability remains tied to listener readiness.
- Changed empty inventory copy to `No GitHub Actions cache entries.` while retaining runner-cache configuration and purge controls.
- Updated dashboard, API, health-panel, and worker-card fixtures/assertions for nullable pre-telemetry and populated runner status.
- Updated `getWorkerCacheSummary` and dashboard API health fixtures so all API paths carry runner fields.

## Verification

`bun test packages/contracts/src/dashboard-api.test.ts packages/db/src/worker-cache.test.ts packages/db/src/dashboard.test.ts apps/web/src/api.test.ts apps/web/src/components/WorkerHealthPanel.test.tsx apps/web/src/components/WorkerCard.test.tsx`

Result: 89 passing, 0 failing.

`bun test apps/control-plane/src/dashboard-api.test.ts`

Result: 23 passing, 0 failing.
