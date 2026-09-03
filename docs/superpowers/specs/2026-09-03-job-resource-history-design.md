# Job Resource History UI Design

## Objective

Replace the current timing-history tables at `/runs/timing` with an operational view that shows CPU, memory, and execution duration over time for each distinct job. The page must make it easy to scan job names, choose one, understand its resource trend, and open an individual run for investigation.

The page does not display per-job disk usage because Mars does not currently collect it. Labels and explanatory text must name the available scope explicitly: CPU, memory, and duration.

## Primary user flow

1. Open `/runs/timing` and see dataset scope, telemetry coverage, and a sortable list of jobs.
2. Search or filter the job list by time range, platform, vCPU, or parallelism.
3. Select a job identified by repository, workflow, and job name.
4. Review aligned CPU, memory, and execution-duration charts for its completed runs.
5. Hover or focus a run to inspect exact values across the charts.
6. Open the corresponding run from a chart point or the accessible measurements table.

## Information architecture

### Header

Use the title **Resource history** and description **CPU, memory, and execution time for completed jobs.**

Move methodology and telemetry caveats into an **About these metrics** disclosure. The disclosure explains that resource values are sampled, peaks are the highest observed samples rather than exact process-level peaks, and missing telemetry is not treated as zero.

### Filter toolbar

Provide one compact toolbar containing:

- Search by job or repository.
- Time-range segmented control: 24 hours, 7 days, 30 days, and 90 days.
- Platform select.
- vCPU select populated from observed values.
- Parallelism select populated from observed values.
- Reset filters action, visible only when a non-default filter is active.
- Last-updated timestamp and explicit refresh action.

Select controls replace unrestricted numeric inputs. Filters apply consistently to summary values, job rows, and selected-job measurements.

### Summary strip

Show four concise dataset facts:

- Jobs observed.
- Completed runs.
- Median execution time.
- Telemetry coverage percentage.

These describe the filtered dataset and must not use decorative or celebratory KPI styling.

### Job list and detail workspace

Use a two-column layout on desktop:

- Job list: approximately 35% width.
- Selected-job detail: approximately 65% width.

On narrow screens, place a full-width job selector/list above the detail content. The page itself must not overflow horizontally.

## Job identity and list behavior

A job identity is the tuple of repository ID, workflow name, and job name. The server returns a stable opaque job key derived from that identity. Jobs with the same display name in different repositories or workflows remain separate.

Each job row shows:

- Job name.
- Repository and workflow.
- Number of completed runs in the selected range.
- Latest completion time.
- Median execution duration.
- Highest observed CPU peak.
- Highest observed memory peak.
- Compact trend indicators for duration, CPU, and memory.
- A warning marker when telemetry coverage is partial or unavailable.

Rows can be sorted by latest run, duration, CPU, memory, or run count. The selected row has a blue leading edge and a brighter panel background. Search matches job and repository names. If filtering removes the current selection, select the first remaining job; otherwise preserve the selection.

## Selected-job detail

The heading shows the job name, repository, workflow, platform, observed resource configuration, run count, and telemetry coverage.

Below it, render three vertically aligned charts sharing the same ordered run positions:

1. **CPU:** average CPU line with peak CPU points.
2. **Memory:** peak working-set line with an optional requested-memory reference line.
3. **Execution duration:** bars representing execution duration.

Run positions are evenly spaced by completed-run order instead of proportional wall-clock intervals. This avoids long idle periods compressing the useful data while dates remain visible on the axis and in tooltips.

Successful runs use the normal metric colors. Failed and cancelled runs retain their metric values and receive a distinct outcome marker. Partial telemetry uses hollow points. Missing metrics create chart gaps and display as unavailable in text; they never become zero.

Hovering or focusing a point shows:

- Completion timestamp.
- Outcome.
- Execution duration.
- CPU average and peak.
- Memory peak.
- Requested vCPU and memory.
- Telemetry sample count and quality.
- An action to open the run.

Clicking or activating a point selects that run consistently across all charts. Below the charts, an accessible measurements table presents the same runs and values, including a link to each run.

## Visual language

Retain the existing Mars application shell, warm graphite palette, typography, spacing density, and bordered operational panels.

Metric colors:

- CPU: blue.
- Memory: Mars orange.
- Duration: neutral sand.
- Failure or degraded telemetry: pink.

Use sans-serif text for labels and job names and monospace text for measurements. Charts use thin grid lines, direct axis labels, and no decorative gradients. Format measurements for humans: `74%`, `1.8 GiB`, and `6m 12s`; never expose raw bytes or milliseconds in primary UI text.

## TanStack Charts implementation

Use the existing `@tanstack/charts` dependency and repository conventions:

- `Chart` from `@tanstack/charts/react`.
- `defineChart` with `lineY` and `barY` marks.
- Point, band, and linear scales as appropriate.
- The TanStack tooltip plugin.
- Memoized chart rows and definitions.

Create separate `CpuTrendChart`, `MemoryTrendChart`, and `DurationTrendChart` components. They may share formatting and row-transformation helpers, but they must retain independent chart definitions because their marks, units, and missing-value behavior differ.

React owns the selected job and selected run. All charts receive the same ordered run array. Synchronize click and keyboard selection through a shared selected-run ID. Use public TanStack Charts APIs for hover synchronization when available; otherwise retain independent hover tooltips and synchronize only durable click/focus selection. Do not intercept or manipulate chart DOM internals.

Every chart has a concise accessible label and an equivalent table. Keyboard users can select jobs, move through actionable points supported by the chart library, select a run, and open its detail page. Visible focus indicators use the existing Mars focus treatment.

## Component boundaries

- `TimingHistoryPage`: filter state, selected job key, selected run ID, and query orchestration.
- `TimingToolbar`: controlled search and filter inputs, reset, refresh, and last-updated state.
- `TimingSummary`: filtered dataset facts and coverage.
- `JobResourceList`: grouping display, sorting, selection, and telemetry warnings.
- `JobResourceDetail`: selected-job metadata and composition of charts and table.
- `CpuTrendChart`: CPU average and peak visualization.
- `MemoryTrendChart`: memory peak and requested-memory reference visualization.
- `DurationTrendChart`: execution-duration visualization.
- `JobRunMeasurements`: accessible values and run navigation.
- Formatting helpers: bytes, duration, percentage, timestamps, and trend deltas.

Do not add a generic dashboard or chart framework. Existing reusable controls and Mars page patterns remain authoritative.

## Data contract

The existing paginated timing-history endpoint cannot produce a dependable overview because the first page may omit job identities or distort summaries. Add a purpose-built read endpoint:

`GET /api/organizations/:organizationId/job-resource-trends`

Accepted query parameters:

- `from` and `to` timestamps. The client defaults to the last 7 days and derives exact timestamps for the 24-hour, 7-day, 30-day, and 90-day controls.
- `platform`.
- `vcpu`.
- `concurrency`.
- `search`.
- `sort`, one of `latest`, `duration`, `cpu`, `memory`, or `runs`; default `latest`.
- `cursor` and `limit` for job summaries; default 50 and maximum 100.
- `jobKey` for the selected job.
- `pointLimit` for selected-job measurements; minimum 2, default 100, and maximum 200. When more measurements exist, retain evenly distributed points while always preserving the earliest and latest runs in the range.

The response contains:

- `summary`: job count, completed-run count, median execution duration, telemetry-covered run count, and telemetry coverage percentage.
- `jobs`: the requested page of stable job summaries with all job-list fields.
- `nextCursor`: an opaque cursor for the next job-summary page or `null`.
- `selectedJob`: the selected summary and its time-ordered run points.
- `filters`: available platform, vCPU, and parallelism values for the selected time range.
- `generatedAt`: the server timestamp used by the last-updated indicator.

Telemetry coverage is the percentage of completed runs containing at least one resource sample. Each run retains its separate `available`, `partial`, or `unavailable` telemetry state.

The server performs grouping, aggregation, authorization, numeric normalization, deterministic ordering, and point limiting. The browser does not download all raw timing records to calculate overview values. Existing `/job-timings` behavior remains available for detailed history consumers.

When `jobKey` is omitted, the endpoint returns points for the first job under the active sort. When a requested key does not exist under the active filters, it does the same and returns the replacement job key. An empty result returns `selectedJob: null`.

## Loading, empty, and failure states

- Initial loading uses structural skeletons matching the toolbar, list, and chart regions.
- Background refresh preserves current data and shows a subtle updating indicator.
- No completed jobs explains that records appear after completed jobs provide timing data.
- No filter matches preserves filters and offers one-click reset.
- A selected job without resource telemetry retains the duration chart and explains which metrics are unavailable.
- Partial telemetry produces one coverage warning near the detail heading instead of repeating warnings in every cell.
- API failure preserves stale query data when available and presents an inline retry banner.
- Additional job summaries load automatically near the list boundary using `nextCursor`; no prominent page-level “Load more timing records” control appears.

## Responsive behavior

At desktop widths, the list remains visible while detail content scrolls naturally. At tablet and mobile widths, controls wrap into a readable vertical order, the list precedes detail content, and chart labels remain legible. Measurement tables may scroll within their own bounded container but must not cause page overflow.

## Verification criteria

- Filters update dataset totals, job summaries, and selected-job points consistently.
- Selecting a job updates all three charts and the measurements table.
- CPU, memory, and duration use human-readable units.
- Missing resource values render as gaps or unavailable text, never zero.
- Failed and cancelled runs retain valid measurements and display outcome markers.
- A 90-day view does not require downloading all raw timing records.
- Job identities do not merge across repositories or workflows.
- Chart information is available through accessible labels and the measurements table.
- Keyboard users can select jobs and open runs.
- Mobile layout has no page-level horizontal overflow.
- Initial loading, refreshing, empty, no-match, partial-telemetry, stale-data, and error states are distinct and actionable.
- Existing Mars visual language and TanStack Charts conventions are preserved.
