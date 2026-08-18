# Runner/service-layer observability

## Goal

Capture enough evidence to distinguish an ordinary child-process failure, an intentional service stop, a forced sandbox termination, and a true out-of-memory event when a Whitesmith Windows runner disappears during a GitHub Actions job.

## Scope

This change is limited to the Windows service host and the orchestrator lifecycle boundary. It does not change GitHub workflow files, add centralized log storage, or classify missing evidence as OOM.

## Service-host records

`apps/windows-service-host` will append structured JSONL records to its existing `worker.log`. Each record contains a UTC timestamp, event name, service PID, child PID when known, correlation ID, and sanitized fields. No JIT configuration, tokens, request bodies, or job logs are emitted.

The host records service start and stop, child spawn, job-object assignment, graceful stop request, forced job termination, child exit, and host failure. Child completion records include the raw Windows exit code, whether `try_wait` observed the exit, elapsed runtime, and job-object accounting captured at completion or forced termination.

Job-object accounting includes active and peak process counts, peak process memory, peak job memory when available, kernel/user CPU time, and I/O counters. Host memory/commit state and the relevant child process identity are captured at lifecycle boundaries. Accounting failures are represented explicitly as unavailable fields plus an error message, not silently omitted.

Termination causes are mutually exclusive and explicit: `child_exit`, `service_stop`, `forced_job_termination`, `child_disappeared`, or `service_host_error`. A forced termination is not itself labeled OOM.

## Orchestrator evidence

The orchestrator creates one non-secret correlation ID per lease lifecycle and passes it to the service/runtime boundary where supported. Lifecycle logs and worker events include that ID. When completion is not observed, the orchestrator records the last resource sample timestamp, sample count, sampling gap, last memory working set/limit, and runtime termination evidence.

The orchestrator maps only explicit, validated memory evidence to `out_of_memory`. An unobserved child exit, service-host failure, missing heartbeat, or forced termination without memory-limit evidence remains `runner_failed` with a diagnostic reason. Existing memory-pressure detection remains unchanged except for preserving the distinction between detection evidence and termination evidence.

## Tests

- Rust unit tests cover JSON record serialization, termination-cause classification, accounting conversion, and unavailable accounting fields.
- TypeScript tests cover correlation propagation, missing-completion diagnostics, and classification: explicit OOM versus unknown/runner failure.
- Tests assert sensitive fields never appear in serialized diagnostics.

## Acceptance criteria

1. Every service-host lifecycle termination produces a machine-readable record unless the host process itself cannot write.
2. A runner disappearing before normal completion leaves evidence distinguishing missing completion from explicit OOM whenever the host survives long enough to record it.
3. Job-object peak memory and child exit code are available for postmortem analysis.
4. The orchestrator never reports OOM solely because a runner or service disappeared.
5. Existing worker logs remain usable by humans and existing startup/supervision behavior is preserved.
