# Run Telemetry Design

## Goal

Expose the existing run lifecycle timestamps as operator-readable queue and execution telemetry without changing API or database contracts.

## Data

Use the existing `RunSummary`/`RunDetail` fields:

- `queuedAt`: lifecycle start/job creation time
- `startedAt`: execution start, nullable while queued
- `completedAt`: terminal time, nullable while active
- `durationMs`: existing derived total/runtime duration

Derived values:

- time to start = `startedAt - queuedAt`, nullable until running
- run duration = `completedAt - startedAt`, nullable until terminal
- total lifecycle = `completedAt - queuedAt`, nullable until terminal

Negative or invalid timestamp differences render as an unavailable em dash rather than a negative duration.

## UI

Run detail gets a telemetry strip with four labeled metrics: Job created, Time to start, Run duration, and Total lifecycle. Each timestamp metric includes an absolute local date/time and compact relative/duration value where useful. Active runs show `Waiting to start`, `Running`, or `Completion pending` instead of fabricated durations.

The Runs table adds compact columns for Queued, Start delay, and Duration. Existing result, boundary, and navigation behavior remains unchanged. On narrow screens, the table keeps its existing horizontal overflow behavior.

## Constraints

- No backend, contract, or database changes.
- Preserve existing dark console visual system.
- Use accessible table headers and metric labels.
- Keep formatting deterministic in tests by injecting/using explicit ISO values.
