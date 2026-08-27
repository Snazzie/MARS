# Out-of-memory detection and graceful job failure

## Goal

When a job runtime exceeds its configured memory budget, Mars should identify the cause as out-of-memory instead of leaving only GitHub's generic self-hosted-runner communication failure. When the runner is still alive, the worker should stop the job through the runner boundary and allow GitHub to receive a normal failed result with an actionable message. If the operating system has already killed the runner, Mars must still classify and retain the OOM diagnosis locally.

## Scope

- Windows Hyper-V container jobs first; preserve the same runtime abstraction for future drivers.
- Existing five-second resource sampling and lease lifecycle.
- Existing lease/job terminal-result and timing-history paths.
- No GitHub runner fork, GitHub API attempt to fabricate a completed job, or change to unrelated resource scheduling.

## Detection contract

The runtime sample must report a trustworthy memory limit. Windows container sampling must reject malformed Docker `MemUsage` limits instead of converting them to `1`; the configured lease memory limit is the fallback. A sample is eligible for OOM detection only when its working-set and limit are positive finite values and the limit is the lease's configured limit or a valid runtime limit consistent with it.

Use a small state machine in the worker lifecycle:

- `normal`: no pressure evidence.
- `pressured`: working set is at least 95% of the configured limit; require two consecutive samples to avoid one-sample noise.
- `oom_detected`: working set exceeds the configured limit, or pressure persists and the runtime reports a hard memory failure.
- `runner_lost_after_pressure`: no runner completion arrives after an OOM stop attempt; classify locally without pretending that GitHub received a final result.

Record the peak working set, configured limit, most recent sample, and detection timestamp. Do not infer OOM from a missing sample alone. A runtime timeout, provisioning error, cleanup failure, or ordinary nonzero runner exit remains its existing reason unless OOM evidence exists.

## Graceful termination

Extend the runtime lifecycle with an explicit, idempotent stop-request operation that can be initiated by the sampler and raced against normal runtime completion. The Windows container driver must attempt a graceful runner stop through the job-agent/container boundary before force-stopping and removing the container. The stop request must carry a redacted diagnostic message and an OOM failure code understood by the job-agent; it must never include secrets, tokens, JIT configuration, or full command output.

The lifecycle behavior is:

1. Detect OOM pressure.
2. Atomically claim the OOM stop so only one sampler/action performs it.
3. Ask the job-agent/runner to terminate normally with the diagnostic message.
4. Wait for the normal completion event within a bounded grace period.
5. If completion arrives, send `runner.finished` with the failure result and continue ordinary cleanup.
6. If completion does not arrive, force-stop/remove the runtime, send a lease failure carrying `out_of_memory`, and retain the local diagnosis.

A runner that has already been killed cannot be made to complete its GitHub protocol exchange. The implementation must state this limitation in the job detail and must not claim successful GitHub completion from a control-plane event alone.

## Persisted result and UI behavior

Add a structured OOM terminal result rather than encoding diagnostics in an arbitrary string. It contains `reason: "out_of_memory"`, `memoryWorkingSetBytes`, `memoryLimitBytes`, `detectedAt`, and whether graceful termination was acknowledged. Existing `runner.finished` and `lease.failed` contracts must remain backward-compatible; add the new reason only where the current lifecycle allows a terminal failure reason.

Job detail/timing APIs should expose the structured result and a human-readable diagnosis. The dashboard should render OOM distinctly from runner loss and include values in GiB. Existing GitHub logs remain untouched; the job-agent diagnostic is redacted and bounded.

## Configuration and accounting

The configured lease memory limit is authoritative for detection. Pool admission must continue rejecting requests above pool/worker ceilings; a stored pool configuration that advertises less memory than a requested job is a separate configuration error and must not be silently normalized by OOM detection.

## Tests and verification

- Windows Docker stats parsing: valid units, malformed/missing limit fallback, and no `1`-byte limit.
- Lifecycle state machine: two-sample 95% pressure, direct over-limit detection, noise reset, single stop claim, graceful completion, and grace-period fallback.
- Contract validation: structured OOM terminal result and permitted lease failure reason.
- Database persistence/API: OOM reason and measurements survive reaping and appear in job detail/timing responses.
- Dashboard: OOM presentation is distinct from generic runner communication loss.
- Smoke scenario: a disposable Windows job crosses its memory budget, receives the diagnostic termination path when the runner remains alive, and leaves a classified local result when forced termination is required.

## Non-goals

- Retrying OOM jobs automatically.
- Increasing memory allocation dynamically.
- Completing a GitHub job after the runner process is gone.
- Treating every runner communication failure as OOM without supporting telemetry.
