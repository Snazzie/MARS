# Run Step Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist GitHub Actions step results and step-scoped logs, then display each step collapsed in run details with expandable logs.

**Architecture:** Extend the existing GitHub job snapshot and monotonic persistence path with normalized steps. Store step metadata and step log chunks separately, expose strict run-detail and cursor APIs, and replace always-visible job logs with expandable step rows while retaining an unattributed job-log fallback.

**Tech Stack:** Bun, TypeScript, PostgreSQL, Zod, Hono, React, TanStack Query, TanStack Router.

## Global Constraints

- Preserve monotonic lifecycle behavior: terminal steps cannot regress; earliest non-null start and first non-null completion win.
- Persist step history; expanded logs must not depend on a live GitHub request.
- Keep organization membership authorization on every step-log request.
- Bound log reads with the existing cursor and limit conventions; never expose secrets.
- Keep existing job resource, runner, and fallback job-log behavior.
- Do not alter workflow execution, scheduling, runner allocation, or run-list behavior.

---

### Task 1: Add step contracts and database persistence

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/dashboard.ts`
- Test: `packages/db/src/dashboard.test.ts`

**Interfaces:**
- Produces `RunStep` and `RunDetail.jobs[].steps`.
- Produces `listStepLogChunks(db, organizationId, runId, jobId, stepId, after, limit)` returning `CursorPage<LogChunk>`.

- [ ] **Step 1: Add the failing contract test**

Create a representative step and assert `RunStep.parse` accepts its exact shape: `{id,name,number,status,conclusion,queuedAt,startedAt,completedAt,durationMs}`. Assert `RunDetail.parse` rejects a job missing `steps`.

- [ ] **Step 2: Add the failing database query test**

Extend the dashboard test fixture with a job row whose `steps` value is a JSON string and assert the detail normalizer returns `requestedLabels` as an array and `steps` as parsed objects. Add a step-log fixture and assert cursor ordering and `hasMore` behavior.

- [ ] **Step 3: Add schema tables and indexes**

Add idempotent schema statements:

```sql
CREATE TABLE IF NOT EXISTS dashboard_job_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL,
  github_step_id bigint,
  step_number integer NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  conclusion text,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (organization_id, job_id, step_number),
  FOREIGN KEY (organization_id, run_id) REFERENCES dashboard_runs(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, job_id) REFERENCES dashboard_jobs(organization_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS dashboard_step_log_chunks (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  job_id uuid NOT NULL,
  step_id uuid NOT NULL REFERENCES dashboard_job_steps(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  content text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, step_id, sequence)
);
CREATE INDEX IF NOT EXISTS dashboard_job_steps_job_idx ON dashboard_job_steps(organization_id, job_id, step_number);
CREATE INDEX IF NOT EXISTS dashboard_step_logs_idx ON dashboard_step_log_chunks(organization_id, run_id, job_id, step_id, sequence);
```

- [ ] **Step 4: Extend contracts and DB normalization**

Define `RunStep` with the fields above, add `steps: z.array(RunStep)` to `RunJob`, normalize JSONB values recursively, derive `durationMs` from timestamps when not stored, and return steps ordered by `step_number` from `getRunDetail`.

- [ ] **Step 5: Implement step-log pagination**

Implement `listStepLogChunks` with the same authorization boundary inputs and cursor semantics as `listLogChunks`, selecting `organization_id`, `run_id`, `job_id`, `sequence`, `content`, `occurred_at` and returning bounded `CursorPage<LogChunk>`.

- [ ] **Step 6: Run focused database tests**

Run `bun test packages/db/src/dashboard.test.ts` and `bun run --filter @mars/db typecheck`.

---

### Task 2: Normalize and persist GitHub steps

**Files:**
- Modify: `apps/control-plane/src/runs.ts`
- Modify: `apps/control-plane/src/github-jobs.ts`
- Modify: `apps/control-plane/src/github-app.ts`
- Modify: `apps/control-plane/src/job-discovery.ts`
- Test: `apps/control-plane/src/runs.test.ts`
- Test: `apps/control-plane/src/github-jobs.test.ts`

**Interfaces:**
- Consumes `RunStep`-compatible GitHub step snapshots.
- Produces `GithubJobSnapshot.steps` and monotonic step rows through `applyGithubJobSnapshot`.

- [ ] **Step 1: Add red REST/webhook convergence tests**

Use a job payload with `steps: [{number:1,name:"Build",status:"completed",conclusion:"success",started_at,completed_at}]`. Assert REST and equivalent webhook normalization produce identical step snapshots. Assert a queued step with `started_at` remains internally queued with `startedAt: null`, and a completed step cannot regress when a queued snapshot is replayed.

- [ ] **Step 2: Extend snapshot types and parsers**

Add a normalized step type with numeric `number`, non-empty `name`, normalized status (`queued`, `in_progress`, `completed`), nullable conclusion, and timestamps. Parse `workflow_job.steps` from webhook payloads and REST job responses; reject malformed step numbers/statuses with `github_payload_invalid`.

- [ ] **Step 3: Upsert steps in the existing transaction**

After the dashboard job upsert in `applyGithubJobSnapshot`, insert/update each step using the job’s dashboard ID. Use SQL conditions equivalent to the existing run/job monotonic rules: terminal rows stay terminal, queued rows may advance to in-progress/completed, `started_at=LEAST(existing, excluded)` when both exist, and `completed_at=COALESCE(existing, excluded)`.

- [ ] **Step 4: Persist step metadata from both paths**

Ensure `applyWorkflowJobWebhook` passes normalized steps and discovery’s `listJobs` path applies them through the same `applyGithubJobSnapshot` transaction. Do not create a webhook-only SQL path.

- [ ] **Step 5: Run focused control-plane tests**

Run `bun test apps/control-plane/src/runs.test.ts apps/control-plane/src/github-jobs.test.ts`.

---

### Task 3: Persist and serve step-scoped logs

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/job-agent/src/bootstrap.ts`
- Modify: `apps/orchestrator/src/mac-agent.ts`
- Test: `apps/control-plane/src/http/dashboard-routes.test.ts` if present, otherwise add the route-focused test beside existing dashboard route tests
- Test: worker/orchestrator log event tests covering step IDs

**Interfaces:**
- Adds `getStepLogs(organizationId, runId, jobId, stepId, after?, limit?)` in `apps/web/src/api.ts`.
- Adds `GET /api/organizations/:organizationId/runs/:runId/jobs/:jobId/steps/:stepId/logs`.

- [ ] **Step 1: Add the failing route contract test**

Assert the route rejects a non-member organization, rejects invalid `after`/`limit`, and returns `CursorPage(LogChunk)` for a valid step. Assert the query is constrained by organization, run, job, and step IDs.

- [ ] **Step 2: Add step identity to authenticated log events**

Extend the worker log payload with `stepId: uuid | null` and preserve the existing job ID, sequence, content, and timestamp. Validate the payload strictly; unattributed chunks use `stepId: null` and continue to the existing job-log table.

- [ ] **Step 3: Write step chunks to the step table**

In the control-plane event handler, resolve the step under the authenticated organization/run/job and insert `(step_id, sequence, content, occurred_at)` with exact replay idempotency. Reject unknown step IDs without leaking payload contents.

- [ ] **Step 4: Add the authenticated HTTP endpoint and client**

Call `listStepLogChunks` after the existing `guard` check, parse query bounds with `logSchema`, and validate the response with `CursorPage(LogChunk)`. Add the matching API client function using the existing request helper.

- [ ] **Step 5: Run route and worker tests**

Run the focused route, worker-dispatch, orchestrator, and job-agent tests covering valid step IDs, unattributed logs, replay, authorization, and pagination.

---

### Task 4: Render collapsed steps and expandable logs

**Files:**
- Modify: `apps/web/src/components/LogViewer.tsx`
- Modify: `apps/web/src/routes/RunDetailPage.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/components/RunTimeline.tsx` only if shared status helpers are needed
- Test: `apps/web/src/components/LogViewer.test.tsx`
- Test: `apps/web/src/routes/RunDetailPage.test.tsx` or the existing run-detail component test location

**Interfaces:**
- `LogViewer` accepts `organizationId`, `runId`, `jobId`, and `stepId`.
- `RunDetailPage` consumes `RunJob.steps` and renders one collapsed row per step.

- [ ] **Step 1: Add failing UI tests**

Assert each job step renders collapsed by default with its name, result, and duration; logs are not fetched before expansion. After expansion, assert the step log request renders ordered content. Add empty, loading, retry, and unavailable-log assertions.

- [ ] **Step 2: Implement the step row**

Use a semantic `<details>`/`<summary>` or equivalent button with `aria-expanded`. Render status text and duration in the summary. Keep step rows keyboard accessible and preserve job-level resource/runner details.

- [ ] **Step 3: Load logs on expansion**

Use TanStack Query keyed by organization, run, job, and step. Do not call the endpoint while collapsed. Render bounded logs in a focusable `<pre>` and expose retry/empty states through the existing `QueryState` pattern.

- [ ] **Step 4: Keep unattributed fallback logs**

Render the existing job-level `LogViewer` only when the job has no step-attributed logs or a clear “Unattributed job logs” section is present. Do not duplicate the same log output under every step.

- [ ] **Step 5: Add styles and run web tests**

Style collapsed/expanded rows, result states, duration, and log panels using existing tokens. Run `bun test apps/web/src/components/LogViewer.test.tsx apps/web/src/routes/RunDetailPage.test.tsx` and the existing `RunTable`/telemetry tests.

---

### Task 5: Full verification and migration check

**Files:**
- Modify any affected test fixtures from Tasks 1–4.
- No new production files unless required by the existing event module boundaries.

- [ ] **Step 1: Run focused verification**

```bash
bun test \
  packages/db/src/dashboard.test.ts \
  apps/control-plane/src/github-jobs.test.ts \
  apps/control-plane/src/runs.test.ts \
  apps/web/src/components/LogViewer.test.tsx \
  apps/web/src/routes/RunDetailPage.test.tsx
```

- [ ] **Step 2: Run repository checks**

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

- [ ] **Step 3: Verify a persisted historical run**

Open a completed run, confirm every job step is collapsed, confirm result and duration are visible, expand a step, and verify logs load from the step endpoint after refresh. Confirm an unattributed job log remains available without being duplicated under each step.
