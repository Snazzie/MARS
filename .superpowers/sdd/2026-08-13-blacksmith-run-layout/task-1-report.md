# Task 1 Report: Data-Backed Run History Surface

## Files changed

- Renamed `apps/web/src/components/RunTable.tsx` to `apps/web/src/components/RunHistory.tsx`.
- Renamed `apps/web/src/components/RunTable.test.tsx` to `apps/web/src/components/RunHistory.test.tsx`.
- Updated `apps/web/src/routes/RunsPage.tsx` with the compact Runs heading and `RunHistory` surface while preserving the 2-second query polling contract.
- Added scoped run-history styling to `apps/web/src/styles.css` for the toolbar, chart, dense rows, semantic result states, focus states, and responsive layout.
- `apps/web/src/routes/RunsPage.test.tsx` required no changes because its polling assertion remains valid.

## Behavior delivered

- Added `RunHistoryRange` with `all`, `1h`, `2h`, `4h`, `12h`, `1d`, and `2d` ranges.
- Added deterministic `filterRuns` with case-insensitive search over workflow, repository, branch, actor, commit, result, and runtime boundary metadata.
- Preserved exact queued-time range boundaries and the `all` default.
- Preserved `runDetailLink` organization context and removed the `RunTable` export/path entirely.
- Added controlled search and range controls with `aria-pressed` state.
- Added duration chart bars scaled to the maximum visible nonzero duration, with queued markers remaining visible.
- Added dense result rows with semantic status marks/labels, workflow/run number, actor, runtime boundary, queued time, repository/branch, short commit SHA with full accessible metadata, formatted duration, and proportional duration rails.
- Added the in-panel `No runs match these filters.` state.
- Supports `allowDetails={false}` for server-rendered tests and a covering TanStack Router `Link` when details are enabled.

## Verification

Command:

```bash
bun test apps/web/src/components/RunHistory.test.tsx apps/web/src/routes/RunsPage.test.tsx
```

Result: **6 pass, 0 fail; 10 expect() calls.**

## Commits

- `d967c96` — `feat(web): add Blacksmith run history`

## Self-review concerns

- No known functional concerns. Repository-wide typecheck/build/lint and browser smoke were intentionally not run because the Task 1 brief restricts verification to the focused tests.
