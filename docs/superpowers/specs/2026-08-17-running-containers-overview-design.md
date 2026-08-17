# Running Containers Overview Design

## Goal

Add a section below the overview charts listing all currently running containers in the active overview scope.

## Scope

The section is organization-scoped for a selected organization and includes all visible active leases in the global `all` overview. A container is active when its lease state is one of `reserved`, `requested`, `dispatched`, `provisioning`, `sandbox_ready`, `online`, or `busy`.

Each row shows the job/container identity, repository/workflow context, worker/runtime, latest CPU sample, latest memory working set versus configured memory limit, and sample freshness. Rows are newest first. Missing or stale telemetry is rendered as unavailable, never as zero.

Disk usage is not currently emitted by any runtime. The UI will explicitly show disk usage as unavailable rather than confusing the requested storage allocation with actual consumption.

## Data flow

Extend the overview DTO and dashboard query to return active container rows. The query joins active leases to dashboard jobs, runs, workers, and the latest resource sample for each lease. The existing overview API validates and returns the expanded DTO. The web overview renders the section after the existing charts and preserves the existing empty state behavior.

The section uses the existing overview query refresh/invalidation behavior. No independent polling loop is introduced.

## Error and empty states

- No active leases: `No containers are running.`
- Missing CPU or memory sample: show `Not reported`.
- Disk: show `Not reported` with an explanatory caption.
- API/query errors continue through the existing overview query error state.

## Verification

Add contract/query coverage for active lease filtering, latest-sample selection, scope isolation, and empty results. Add component rendering coverage for populated, unavailable, and empty states. Run the focused DB/web tests and the repository typecheck.
