Implemented package ready-row aggregate status, mutation sink, service runnerCacheStatus, runner telemetry emissions, post-snapshot status frame, and focused tests. Package cache focused test: 6 pass, 0 fail. Combined orchestrator suite: 25 pass, 1 pre-existing/flaky timeout in retry discovery test; package path passed. Commit 074c557.
 
Review fixes (commit 0940573):
- Aligned `PackageDownloadCache.setTelemetrySink` with the typed two-argument mutation contract. Package mutations emit `worker.runner_cache_status` plus the package aggregate payload; service wiring receives the event and emits the full runner status.
- Isolated telemetry sink failures from package persistence. A throwing sink can no longer make a successful publish fall through cleanup or leave eviction work incomplete.
- Added a package regression proving a throwing sink still yields MISS then HIT with one upstream call and a ready aggregate.
- Extended service coverage to assert purge and TTL eviction return runner status and telemetry to zero while Actions status generation/count/bytes remain unchanged.

Verification:
- `bun test apps/orchestrator/src/action-cache/package-download-cache.test.ts apps/orchestrator/src/action-cache/service.test.ts` — 27 pass, 1 skip, 0 fail (118 assertions).
- `bunx tsc --noEmit -p apps/orchestrator/tsconfig.json` — pass.