# Platform Job Outcomes

## Goal

Make the overview dashboard show the platform distribution of queued, running, completed, and failed jobs in a vertical stacked bar chart.

## Data semantics

The chart counts jobs, not workflow runs, because one workflow run can contain jobs targeting different operating systems. The panel is renamed from **Run outcomes** to **Job outcomes**.

The overview response exposes four outcome buckets in this fixed order:

1. Queued
2. Running
3. Completed
4. Failed

Each bucket contains counts for macOS, Ubuntu, Windows, and Other. Platform classification uses the job's requested runner labels, case-insensitively:

- labels containing `macos` map to macOS;
- labels containing `ubuntu` or `linux` map to Ubuntu;
- labels containing `windows` map to Windows;
- jobs without one of those labels map to Other.

If labels from multiple platform groups are present, the first matching group in the order macOS, Ubuntu, Windows wins. This keeps classification deterministic for malformed or custom label sets.

Queued and running counts represent current state. Completed and failed counts include jobs completed within the selected overview period: 24 hours, 7 days, or 30 days. A completed job with conclusion `success` belongs to Completed; every other completed conclusion belongs to Failed. These rules retain the existing overview semantics.

Organization-scoped requests include only that organization's jobs. The all-workspace request includes only jobs belonging to organizations visible to the authenticated user.

## Contract and backend

Extend `OverviewDto` with a required `jobOutcomes` array. Each item contains an `outcome` value (`queued`, `running`, `completed`, or `failed`) and integer counts under `platforms.macos`, `platforms.ubuntu`, `platforms.windows`, and `platforms.other`.

The dashboard database layer computes all outcome/platform cells in one aggregate query per overview request. It reuses the same organization membership boundary as the existing overview query and applies the selected period only to completed outcomes. Missing cells are returned as zero so the client always receives all four outcomes and all four platforms.

## Chart

Replace `OutcomeBars` with a vertical stacked bar chart:

- the horizontal axis lists Queued, Running, Completed, and Failed;
- the vertical axis shows job counts;
- each bar stacks macOS, Ubuntu, Windows, and Other in a stable order;
- a visible legend maps platform names to stable colors;
- each outcome remains visible when its total is zero;
- if every count is zero, show the existing chart empty-state treatment instead of an empty plot.

The chart receives already-aggregated contract data and does no platform inference. Its accessible name is **Job outcomes**. Its image description enumerates every outcome/platform count so the same distribution is available without relying on color or geometry.

## Error handling

Contract validation rejects missing outcomes, missing platform cells, negative counts, unknown outcomes, and extra fields. Existing overview loading, retry, and request-error handling remains unchanged.

## Verification

- Contract tests parse the complete `jobOutcomes` shape and reject invalid cells.
- Database tests cover platform classification, Other fallback, status/conclusion grouping, period filtering, and organization/all-workspace access boundaries.
- Component tests verify the four outcome labels, platform legend, zero-data state, and accessible summary.
- Run focused tests, web typecheck, and the production build.
- Launch the dashboard and inspect the overview chart in Chromium at desktop and narrow viewport widths.
