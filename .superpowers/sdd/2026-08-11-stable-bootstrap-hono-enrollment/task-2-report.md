# Task 2 report

Status: DONE

Removed the legacy `createDashboardApi` Request dispatcher and migrated dashboard query validation, typed errors, tenant guards, settings, worker, run, repository, pool, and log handlers to direct canonical Hono routes. Added direct repository/pool mutation routes, registered worker routes in the app, restored the adopted-socket dispatcher callback, and rejected unknown worker actions. Rewrote focused dashboard coverage to use `createControlPlaneApp(...).request()`; no `/api/v1` dashboard aliases remain.

Verification:
- `bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/dashboard-api.test.ts` — 11 passed, 0 failed.
- `bun run --filter '@mars/control-plane' typecheck` — passed.
- Restored the canonical installer URL in worker enrollment responses and covered it with a focused route assertion.
- Settings PUT now validates the payload before consuming `Idempotency-Key`, preserving corrected retries after malformed requests.
- Settings PUT now checks missing idempotency before body parsing, then validates, consumes, and updates in that order; focused tests cover missing-key precedence and same-key corrected retry.
- Settings regression uses a stateful DB double to prove malformed requests do not consume the key and the corrected retry consumes once and updates once with expected values.
