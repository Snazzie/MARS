# Timing Label Optimization Design

## Goal

Add an actionable label optimization suggestion to `/runs/timing` that preserves the Windows routing label, recommends safer lower `VCPU`/`G` values from run history, and lets the user create a pull request updating the selected workflow job.

## Scope and decisions

- The optimization target is the currently selected timing-history job and its workflow file.
- The Windows routing label remains unchanged, for example `mars-windows-x64`.
- Numeric labels use the existing formats: `<n>VCPU` and `<n>G`.
- Recommendations use successful completed runs in the active timing range.
- Defaults are conservative and editable: p95 observed CPU/memory demand plus a safety margin, rounded up to integer labels.
- The PR changes only the selected workflow job's `runs-on` value; unrelated workflow jobs and content remain unchanged.
- Existing workflow PR confirmation, expected-head-SHA validation, idempotency, and result-link behavior remain in use.

## User experience

The selected job detail on `/runs/timing` shows an **Optimize runner labels** panel when enough successful history and telemetry exist. It displays:

- current labels;
- recommended `VCPU` and `G` labels;
- successful sample count and telemetry coverage;
- observed p95 CPU and memory values;
- a caveat when history or telemetry is insufficient.

The numeric labels are editable. The user reviews a before/after diff, confirms the change, and creates a PR. No action is available when the recommendation is unavailable, the proposed labels are invalid, or the change is a no-op.

## Architecture

### Recommendation data

Add a server-side recommendation contract and endpoint scoped to organization, repository, workflow/job identity, and the active timing range. The server aggregates authoritative successful run history and returns:

- current workflow labels for the selected job;
- recommended numeric labels;
- raw p95 CPU and memory values;
- successful run count and telemetry coverage;
- a machine-readable unavailable reason when confidence is inadequate.

The browser requests this data only after a job is selected and passes the active range/filter context needed to reproduce the displayed history. The server remains authoritative so recommendations are consistent and auditable rather than dependent on paginated browser state.

### PR mutation

Extend the existing runner-workflow preview/create contract to support one selected job mutation with editable labels. Preview reads the current workflow head, validates the selected file/job and labels, and returns a precise job-level diff plus `headSha`. Create re-reads the workflow and head, rejects stale heads and no-op changes, then creates the branch/commit/PR through the existing GitHub app service.

The mutation must preserve the Windows routing label and replace only the numeric resource labels for that job. Existing arbitrary labels remain unless the user explicitly changes the editable numeric values through this flow.

## Recommendation policy

1. Filter to successful completed runs for the selected job and active range.
2. Require at least 5 successful runs and at least 80% CPU/memory telemetry coverage. The endpoint returns unavailable when either threshold is not met.
3. Compute p95 CPU peak percent and p95 memory working-set bytes from available samples.
4. Apply a fixed 25% safety factor, then round CPU to `ceil(p95CpuPeakPercent / 100 * 1.25)` vCPUs and memory to `ceil(p95MemoryPeakBytes / 1024^3 * 1.25)` GiB.
5. Clamp recommendations to positive integer labels. If a metric is unavailable, retain its current valid numeric label rather than inventing a value.
6. Return an unavailable state instead of inventing a value when neither a safe recommendation nor a valid current value can be established.

The UI must label these as recommendations, not guarantees; sampled telemetry remains subject to the existing resource-history caveat.

## Error handling and safety

- Missing repository/workflow mapping returns a user-visible unavailable state.
- Missing telemetry never counts as zero.
- Invalid, duplicate, non-positive, or non-integer numeric labels are rejected by shared schemas and the server.
- Stale workflow heads fail with the existing conflict behavior and require a fresh preview.
- No-op proposals disable PR creation.
- GitHub permission, repository availability, and rate-limit errors use the existing API error surface.
- Successful PR creation shows the URL and does not imply that the PR was merged.

## Testing

Add contract tests for percentile/safety-margin rounding, insufficient history, missing telemetry, preservation of the Windows label, editable numeric labels, no-op prevention, selected-job-only workflow mutation, stale-head rejection, and API schema parsing. Add component tests for loading, unavailable, editable recommendation, preview diff, confirmation, create error, and success-link states. Exercise the actual `/runs/timing` surface with the existing web smoke path after implementation.

## Non-goals

- Automatically changing runner pools or worker capacities.
- Recommending a different operating system or Windows routing label.
- Updating every workflow file in a repository from one action.
- Auto-merging or auto-approving the generated PR.
- Replacing the existing general runner workflow migration flow.
