# Job Resource Telemetry Design

## Goal

Add per-job CPU and memory load visibility to the existing completed-job performance history. This feature measures sampled runtime utilization; it does not add fleet-wide operational metrics or causal inference.

## Scope

Workers sample active jobs every 5 seconds. Raw samples are retained for 7 days. Completed-job aggregates are stored in the existing 90-day timing snapshot history.

Supported measurements:

- normalized CPU utilization percentage;
- cumulative CPU time;
- memory working-set bytes;
- memory limit bytes.

The first release supports Windows containers, Hyper-V VMs, and macOS Tart VMs. Linux/Kata collection remains excluded with the existing runtime boundary.

## Architecture

Add a `job.resource_sample` worker event containing `jobId`, `leaseId`, `occurredAt`, `cpuUsagePercent`, `cpuTimeMs`, `memoryWorkingSetBytes`, and `memoryLimitBytes`.

Runtime collectors resolve the lease-specific runtime identity:

- Windows container: container/process counters;
- Hyper-V: VM performance counters keyed by VM name;
- Tart: VM/process counters keyed by Tart VM identifier.

The worker emits samples only while the lease is active. The control plane validates the authenticated worker, lease, job, timestamp, and metric bounds before storing a sample. Duplicate delivery is safe through a uniqueness key on organization/job/timestamp. Samples from unknown, mismatched, stale, or terminal leases are rejected without changing job state.

## Storage

Add `dashboard_job_resource_samples` with organization, job, run, lease, occurred-at, CPU, and memory fields. Enforce non-negative values, CPU percentage within the normalized range, and a uniqueness constraint for duplicate event replay. Add indexes for job/time retrieval and retention deletion.

Raw samples are pruned after 7 days using the existing retention scheduler and `MARS_RETENTION_JOB_RESOURCE_SAMPLES_DAYS`, default `7`. The existing job timing snapshot stores only aggregates, not raw samples.

Extend timing snapshots with nullable aggregate fields:

- `telemetry_state`: `available`, `partial`, or `unavailable`;
- `telemetry_sample_count`;
- CPU average, p50, p95, peak, and CPU time;
- memory average and peak.

Null aggregates plus `unavailable` are required when no trustworthy samples exist. Zero must mean measured idle usage, never missing data.

## Aggregation

At completed-job snapshot creation, query the job’s valid samples and calculate average, p50, p95, peak, and cumulative CPU time plus average/peak memory. Mark `available` when samples exist within 10 seconds of both the execution start and completion and no adjacent samples are more than 15 seconds apart. Mark `partial` when samples exist but fail one of those coverage checks. Mark `unavailable` when no valid sample exists.

Aggregation is idempotent with the existing organization/job timing snapshot uniqueness constraint. Late duplicate events cannot alter a completed aggregate unless an explicit reconciliation path replaces a partial aggregate with a verified complete one.

## API and UI

Extend timing-history DTOs and endpoints with aggregate telemetry fields. Add a per-job sample endpoint for raw samples retained within seven days. Keep organization authorization and cursor conventions.

Timing History displays CPU average/p50/p95/peak, CPU time, memory average/peak, telemetry state, and sample count. A per-job chart may show the raw seven-day CPU series. Filters and grouping continue to support vCPU, runtime, platform, and parallelism.

Use neutral diagnostic labels:

- high CPU with long execution: likely CPU-bound;
- low CPU with long execution: likely wait/I/O-bound;
- unavailable/partial: insufficient telemetry.

These labels must state that they are diagnostic correlations, not causal conclusions.

## Failure handling and security

Collector failures must not fail or terminate the job. Invalid samples are dropped and counted in worker/control-plane logs without storing secrets or raw logs. Event authentication and lease ownership checks are mandatory. Bound sample frequency, payload size, and per-job sample count to prevent an abusive worker from exhausting storage.

## Verification

- Worker event contract rejects invalid ranges, malformed timestamps, mismatched identifiers, and secret-like fields.
- Runtime collector tests verify Windows, Hyper-V, and Tart identity/counter mapping.
- Control-plane tests verify authorization, duplicate delivery, out-of-order samples, stale samples, terminal lease rejection, and bounded values.
- Aggregation tests verify average, p50, p95, peak, CPU time, memory values, partial sequences, unavailable telemetry, and idempotency.
- Retention tests verify seven-day deletion and configurable override.
- API tests verify organization scoping, cursor pagination, and raw sample bounds.
- Web tests verify available/partial/unavailable states, sample counts, charts, and neutral diagnostic copy.

## Out of scope

Prometheus/OpenTelemetry export, fleet-level alerts, autoscaling recommendations, causal inference, raw retention beyond seven days, Linux/Kata implementation, and changes to scheduler decisions.
