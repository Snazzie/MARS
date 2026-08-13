# Final review fix wave

## Findings fixed

- Removed the loaded-detail legacy page header from `apps/web/src/routes/RunDetailPage.tsx`; back navigation, query/search organization behavior, `QueryState` loading/error/retry handling, and an honest screen-reader loading heading remain.
- Added loaded-log filtering in `apps/web/src/components/LogViewer.tsx` through `searchQuery` and `filterLoadedLogItems`. Already-loaded unattributed job chunks participate in search without fetching step logs. A job-text match renders only the unattributed output; a query with no loaded match reports `No matching loaded log output.`

## Focused regression coverage

- `apps/web/src/components/LogViewer.test.tsx`: loaded unattributed output matches; unrelated step text does not count as a job-text match.
- Existing `apps/web/src/components/RunDetailView.test.tsx` was included in the focused run.

## Verification

- `bun test apps/web/src/components/RunDetailView.test.tsx apps/web/src/components/LogViewer.test.tsx` — 8 passed, 0 failed, 46 expectations.
- `bun run --filter @whitesmith/web typecheck` — passed (exit code 0).

## Commit

Changes are present in the worktree at final-fix verification. Git reported the affected files clean after the preceding integration commit (`85e5352 fix(web): scope run visual tokens`); no unrelated files were changed in this wave.
