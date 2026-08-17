# Job Timing History Design

## Goal

Add historical timing data for completed jobs so operators can compare execution speed over time and evaluate correlations with vCPU allocation, resource changes, runtime, and parallelism.

The first release covers completed jobs only. It reports correlation, not causation.

## Chosen approach

Persist one immutable timing snapshot per completed dashboard job. Do not reconstruct history solely from mutable pool and worker rows, because later configuration changes would make old comparisons inaccurate. Do not add a raw event store; existing run stages and job lifecycle timestamps provide the required source data.

## Data model

Add `dashboard_job_timing_snapshots`, keyed by organization and dashboard job, with a uniqueness constraint that permits exactly one snapshot per job. Store:

- dashboard job, run, repository, workflow, and job identity;
- completion timestamp and terminal outcome;
- runtime platform, driver/boundary, pool identity, and artifact digest;
- requested and effective/observed vCPU, memory, storage, and concurrency/parallelism;
- queue, startup/allocation, execution, cleanup, and total durations in milliseconds;
- snapshot creation timestamp.

All duration values are non-negative integers. Resource and runtime values are copied at terminalization time so the record remains historically accurate. No logs, credentials, JIT configuration, or other secret-like data are stored.

The timing table follows the production retention policy. Initial retention is 90 days and must use the same configurable operational-retention mechanism as job logs.

## Lifecycle and consistency

When a job reaches its terminal/reaped lifecycle state, write the snapshot in the same transaction as the terminal state transition where possible. Use an organization/job uniqueness constraint and idempotent insertion so retries, webhook replays, reconnects, and reconciliation cannot create duplicates.

A job that is queued, running, or otherwise nonterminal has no timing snapshot. If lifecycle data is incomplete, preserve the terminal job state and record a bounded zero/null value according to the contract rather than inventing a duration. The API must make missing measurements explicit.

## API

Add a paginated timing-history endpoint scoped to an organization. Filters:

- completed-at date range;
- repository;
- workflow and job name;
- runtime platform/driver;
- vCPU allocation;
- concurrency/parallelism;
- terminal outcome.

Return individual completed-job measurements for drill-down and grouped aggregates for comparison. Aggregates include sample count, minimum, maximum, median/p50, and p95 for queue, execution, cleanup, and total durations. Grouping supports time buckets and selected comparison dimensions. Every aggregate includes its sample count; the API never presents a percentile without indicating the population size.

Use existing cursor pagination conventions. Validate all filter and resource values with contracts. Do not expose active or partial jobs through this endpoint.

## UI

Add a Timing History view reachable from Runs. It contains:

1. a trend chart for selected duration (queue, execution, cleanup, or total);
2. comparison controls for repository/workflow, runtime, vCPU, and concurrency;
3. a grouped comparison table showing sample count, median, p95, and range;
4. a completed-job detail list with the captured resource/runtime snapshot.

Labels must distinguish queue time, execution time, cleanup time, and total time. Empty and low-sample states must be explicit. The UI must avoid language implying that a resource change caused a performance change; use neutral comparison language and show sample counts.

Active/queued jobs remain in the existing Runs views and are excluded from timing-history aggregates.

## Verification

- Schema test verifies the table, uniqueness constraint, non-negative duration constraints, required dimensions, and retention registration.
- Lifecycle integration test reaches terminal/reaped state twice and proves exactly one snapshot is stored with the captured resource/runtime values.
- Reconciliation/replay test proves duplicate webhook or worker events do not duplicate snapshots.
- API tests cover date and dimension filters, cursor pagination, empty data, grouped percentiles, and exclusion of active jobs.
- Contract tests reject malformed timestamps, negative durations, invalid resources, and secret-like fields.
- Web tests cover controls, neutral comparison labels, sample counts, empty/low-sample states, and the completed-only boundary.

## Scope boundaries

This feature does not add causal inference, forecasting, alerts, autoscaling recommendations, raw lifecycle event storage, active-job partial timing, or Linux runtime implementation. It does not alter scheduler decisions; it only records and presents completed-job measurements.
