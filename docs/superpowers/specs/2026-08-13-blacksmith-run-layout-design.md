# Blacksmith-Inspired Run Experience

## Objective

Restyle Mars's run history and run detail screens to follow the Blacksmith references' compact, information-dense hierarchy while preserving Mars's existing sidebar, workspace selection, live data, and operational detail.

The implementation must not display invented data or unsupported views. It reuses the current `RunSummary` and `RunDetail` contracts and does not change the API, database, or ingestion paths.

## Run History

The `/runs` workspace replaces the editorial run-ledger hero and wide table with a compact `Job Run History` header and a single bordered history surface.

The surface contains:

1. A text filter that matches workflow name, repository, branch, actor, commit SHA, result, and runtime boundary.
2. Compact time-range choices that filter only the runs in the current API response. The default shows all returned runs; no control may imply access to older runs that the API did not return.
3. A duration bar chart derived from the returned runs. Bars use success, failure, running, and queued status colors and retain an accessible text description.
4. Dense run rows that expose result, workflow identity, repository, branch, actor, commit, runner boundary, queued time, duration, and a proportional duration rail.

Each row is one keyboard-focusable link to the existing run detail route. Rows must avoid nested interactive controls.

## Run Detail

The run detail workspace uses a compact breadcrumb/title row showing workflow, status, and run or job identity. A summary facts region presents started time, repository, runner, and duration.

The page has two real tab panels:

- **Logs**: searchable step list with expand/collapse controls, line counts, step durations, status icons and labels, and inline monospace output. Step output remains lazily fetched when a step is expanded. Search matches step names and any log text already loaded in the client.
- **Metrics**: the existing lifecycle telemetry, requested and observed resources, runner identity, run timeline, and action graph, reorganized into the compact panel system.

Network and Tests tabs are omitted because Mars has no corresponding datasets. No disabled placeholders are rendered.

## Data Mapping

All values come from existing contracts:

- History rows use `RunSummary`.
- Detail header, lifecycle, jobs, steps, resources, and graph use `RunDetail`.
- Step output uses the existing step-log endpoint and query behavior.

Missing values use explicit labels such as `Awaiting runner`, `Not started`, `In progress`, or `Logs unavailable`. Status is never communicated by color alone.

The current operational detail remains available. The restyle changes composition and hierarchy, not the underlying information contract.

## Visual System

The run workspace follows the references with:

- dark graphite surfaces and restrained background treatment;
- hairline borders and compact radii;
- dense neutral typography rather than the existing serif hero treatment;
- blue success/running accents and pink failure accents;
- compact controls and tightly spaced metadata;
- flat panels rather than decorative gradients.

The Mars wordmark, sidebar navigation, workspace selector, and routing behavior remain unchanged. Small inline SVG or CSS icons may be introduced. No chart or icon dependency is added.

## Interaction and Accessibility

- History filtering updates the chart and rows together.
- Time choices are semantic buttons with a clear selected state.
- The run row link has a visible focus state and descriptive accessible text.
- Detail tabs use `tablist`, `tab`, and `tabpanel` semantics with keyboard-operable controls.
- Log step expansion uses native disclosure semantics where practical.
- Expand/collapse-all applies to visible steps.
- Status uses icon, text, and color.
- Reduced-motion preferences are respected.

## Responsive Behavior

Desktop preserves the dense reference layout. At tablet widths, header facts stack and secondary row metadata wraps. On mobile, result, name, and duration remain primary while repository, actor, branch, commit, and runner information move beneath. Log output remains horizontally scrollable without forcing the full page wider than the viewport.

## Error and Empty States

Existing `QueryState` loading, error, and empty behavior remains authoritative for page-level requests. Filtered history uses an in-panel no-results state. Step logs preserve pending, unavailable, and empty distinctions. A failed log request is visible within the affected step and does not replace the rest of the detail page.

## Implementation Scope

Primary files:

- `apps/web/src/routes/RunsPage.tsx`
- `apps/web/src/components/RunTable.tsx`
- `apps/web/src/routes/RunDetailPage.tsx`
- `apps/web/src/components/LogViewer.tsx`
- `apps/web/src/styles.css`

Focused helpers may be added only when they remove repeated status, duration, or metadata logic. The existing `RunTelemetry`, `RunTimeline`, and `ActionGraph` components remain the data-backed Metrics content.

No backend, database, contract, routing, or ingestion changes are included.

## Verification

Component tests must cover:

- history text filtering and time-window behavior;
- chart and row metadata mapping;
- detail links and missing-data labels;
- tab semantics and panel switching;
- step expansion, log search, and expand/collapse-all behavior;
- status icon plus label rendering.

Run the focused web tests and web typecheck. Then launch the real application, inspect `/runs` and one real run detail at desktop and mobile widths, exercise filters, tabs, and step expansion, and confirm there are no new browser console errors.
