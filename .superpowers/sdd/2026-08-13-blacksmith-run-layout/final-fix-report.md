# Final review fix wave

## Findings fixed

- Removed the loaded-detail legacy page header from `apps/web/src/routes/RunDetailPage.tsx`; back navigation, query/search organization behavior, `QueryState` loading/error/retry handling, and an honest screen-reader loading heading remain.
- Added loaded-log filtering in `apps/web/src/components/LogViewer.tsx` through `searchQuery` and `filterLoadedLogItems`. Already-loaded unattributed job chunks participate in search without fetching step logs. A job-text match renders only the unattributed output; a query with no loaded match reports `No matching loaded log output.`

## Focused regression coverage

- `apps/web/src/components/LogViewer.test.tsx`: loaded unattributed output matches; unrelated step text does not count as a job-text match.
- Existing `apps/web/src/components/RunDetailView.test.tsx` was included in the focused run.

## Verification

- `bun test apps/web/src/components/RunDetailView.test.tsx apps/web/src/components/LogViewer.test.tsx` — 8 passed, 0 failed, 46 expectations.
- `bun run --filter @mars/web typecheck` — passed (exit code 0).

## Commit

Changes are present in the worktree at final-fix verification. Git reported the affected files clean after the preceding integration commit (`85e5352 fix(web): scope run visual tokens`); no unrelated files were changed in this wave.


## Final recovery verification

- `bun test apps/web/src/components/RunDetailView.test.tsx apps/web/src/components/LogViewer.test.tsx apps/web/src/routes/RunsPage.test.tsx apps/web/src/routes/RunDetailPage.test.tsx`
  ```
   10 pass
   0 fail
   48 expect() calls
  Ran 10 tests across 4 files.
  ```
- `bun run --filter @mars/web typecheck`
  ```
  @mars/web typecheck: Exited with code 0
  ```
- Added `filterLoadedLogChunks` regression coverage for matching, no-match, and empty-query behavior; the unattributed panel now explicitly reports `No matching loaded log output in unattributed job logs.` when filtered loaded chunks are absent.
- Added `RunDetailPage.test.tsx` static route regression coverage proving the legacy `page-header` is absent while back navigation and the loading heading remain.