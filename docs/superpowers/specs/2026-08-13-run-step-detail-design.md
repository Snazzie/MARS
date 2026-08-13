# Run Step Detail Design

## Goal
Show every GitHub Actions step inside each run job as a collapsed row with its result and duration; expanding a row loads persisted logs for that step.

## Scope
The feature applies to the existing Whitesmith run-detail page. A job remains the top-level execution unit, with runner/resource metadata unchanged. Its GitHub Actions steps become the primary expandable log units.

## Data model and ingestion
Extend the internal GitHub job snapshot with normalized step records containing a stable step ID, name, status, conclusion, number, queued/start/completion timestamps, and derived duration. Parse `workflow_job.steps` from REST discovery and webhook payloads. Upsert step records monotonically: preserve the earliest non-null start time, first non-null completion time, terminal conclusion, and prevent completed steps from regressing.

Persist steps in `dashboard_job_steps`, keyed by organization, run, and dashboard job. Persist step log chunks in a step-scoped table keyed by organization, run, job, step, and sequence. Worker log events must carry the associated step ID when available. Existing job-level log chunks remain as a fallback for logs that cannot be attributed to a step.

## API
Extend the strict dashboard contracts so `RunDetail.jobs[]` includes `steps[]`. Add an authenticated endpoint:

`GET /api/organizations/:organizationId/runs/:runId/jobs/:jobId/steps/:stepId/logs`

The endpoint uses the existing cursor/limit log contract, organization membership authorization, and bounded ordered chunks. It returns an error state rather than exposing secrets or unbounded output.

## UI
On the run-detail page, render each job with its existing result, runner, teardown, and resource information. Render its steps collapsed by default. Each step row shows the step name, normalized result, and duration. Expanding a step fetches its logs once through TanStack Query and displays loading, empty, retry, unavailable, and bounded-log states. Job-level logs remain accessible as a fallback when step attribution is unavailable.

## Verification
Add tests covering REST/webhook step normalization and convergence, monotonic updates and exact replay handling, step-log authorization and pagination, and UI collapsed-by-default rendering, result/duration display, expansion, successful log loading, and log error/empty states. Run the focused control-plane, database, contracts, and web tests plus typecheck and build.

## Non-goals
Do not change GitHub workflow execution, external GitHub URLs, runner allocation, job resource accounting, or the existing run list behavior.
