# Overview Period Control

## Goal
Let operators switch the overview window between 24 hours, 7 days, and 30 days without leaving the dashboard.

## Design
`OverviewPage` owns a local `period` state, defaulting to `24h`. A compact accessible segmented control presents exactly `24h`, `7d`, and `30d` beside the existing run-ledger action. Each option is a native radio input styled as a button. The selected period is included in the TanStack Query key and passed to `getOverview`, so changing it refetches the correct server-derived aggregates and timeseries. The page eyebrow reflects the active window.

## Scope
No backend or contract changes. No URL persistence. Existing loading, error, and retry states remain unchanged.

## Verification
Add a route test proving the default 24-hour request and a period-change control contract; run focused web tests, typecheck, and production build.
