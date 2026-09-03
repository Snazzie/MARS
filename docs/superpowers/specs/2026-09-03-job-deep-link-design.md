# Job Deep Links Design

## Goal

Allow operators to open a specific dashboard job from the Runs page and the Workers page managed-containers section in a new browser tab.

## Navigation contract

A job link targets the existing run-detail route with a fragment:

`/runs/{runId}#job-{jobId}`

`runId` is the local dashboard run identifier and `jobId` is the local dashboard job identifier. The route remains the existing `/runs/$runId` route; no new API endpoint or route is introduced.

## UI behavior

- Each job section rendered in `RunDetailView` receives the stable DOM id `job-{job.id}`.
- The job heading includes an `Open job` link.
- Each managed container row in `RunningContainers` includes an `Open job` link built from its existing `runId` and `jobId` fields.
- Links open in a new tab with `target="_blank"` and `rel="noreferrer"`.
- Link accessible names identify the job, for example `Open job build in a new tab`.
- On run-detail load, a matching URL fragment is scrolled into view after the job sections render. Missing or malformed fragments have no effect.

## Data and architecture

The existing `OverviewRunningContainer` contract already contains `jobId`; the run detail contract already contains each job's `id` and the parent run's `id`. No backend or contract changes are needed. A small shared URL helper keeps link construction consistent between the two surfaces.

## Accessibility and resilience

Links remain native anchors generated through the existing router/link conventions. Stable ids make fragment navigation and browser history work without application state. The link text and accessible name identify the destination job. Hash navigation is additive and does not block rendering if the target is absent.

## Verification

- Component tests verify the generated job deep-link path, new-tab attributes, and stable job ids.
- Run-detail behavior is verified with a browser smoke check confirming the fragment target is visible.
- Existing web tests covering Runs, RunDetailView, and RunningContainers remain passing.
