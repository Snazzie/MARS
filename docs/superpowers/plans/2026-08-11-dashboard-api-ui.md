# Dashboard API and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development to implement this plan task-by-task. API and UI tasks in the same wave share only the contracts listed below.

**Goal:** Replace the worker-only dashboard with an organization-rooted operations console showing workflow runs, stage timings, action graphs, results, logs, and complete worker adoption/management.

**Architecture:** Add organization-owned persistence and REST read/mutation services to the control plane, expose versioned DTOs in `packages/contracts`, and build the React SPA around organization-rooted TanStack Query keys and route state. API and UI work in parallel using identical contract types; fixture adapters allow UI progress before API routes are complete.

**Tech Stack:** Bun, TypeScript, PostgreSQL, Zod, React 19, TanStack Query, TanStack Router, TanStack Table, TanStack Charts 0.11.0, accessible SVG/HTML graph rendering.

## Global Constraints

- Organization IDs must be present in every query key and organization-rooted API route.
- Cross-tenant resources return `404`, not authorization details.
- Mutations require `Idempotency-Key`.
- Cursor pagination is required for runs, repositories, logs, and worker activity lists.
- Workflow transitions are monotonic and terminal states win.
- Completed logs are bounded chunks; do not claim live step-log streaming.
- Charts require readable summaries and table fallbacks.
- Keyboard focus, reduced motion, responsive layouts, and WCAG AA are required.
- Existing worker endpoints remain functional during migration.
- Persisted payloads must not contain enrollment codes, claims, JIT, GitHub tokens, or private keys.

---

### Task 1: Add shared dashboard contracts

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/dashboard.ts`
- Test: `tests/dashboard-contracts.test.ts`

**Interfaces:**
- Produces Zod schemas and inferred types: `OrganizationSummary`, `OverviewDto`, `RepositorySummary`, `RunSummary`, `RunDetail`, `RunStage`, `RunJob`, `ActionGraph`, `LogChunk`, `WorkerDetail`, `WorkerDoctor`, `CapacitySnapshot`, `CursorPage<T>`, `ApiError`.
- `RunSummary` fields: `id`, `organizationId`, `repositoryId`, `repositoryFullName`, `workflowName`, `runNumber`, `event`, `branch`, `commitSha`, `actorLogin`, `status`, `conclusion`, `queuedAt`, `startedAt`, `completedAt`, `durationMs`, `runtimeBoundary`.
- `RunDetail` extends summary with `stages`, `jobs`, `graph`, `resourceObservation`, `failureReason`, and `teardownState`.
- `CursorPage<T>` is `{items:T[]; nextCursor:string|null}`.

- [ ] Add schemas for all DTOs and typed API errors.
- [ ] Add strict parsing tests for valid DTOs, invalid cursors, malformed timestamps, and forbidden secret-like keys.
- [ ] Run `bun test tests/dashboard-contracts.test.ts`.
- [ ] Run `bun run --filter @whitesmith/contracts typecheck`.

### Task 2: Add dashboard persistence schema and repository services

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/dashboard.ts`
- Test: `tests/dashboard-db.test.ts`

**Interfaces:**
- Produces `dashboardSchemaSql` and named query functions: `listOrganizations`, `getOverview`, `listRepositories`, `listRuns`, `getRunDetail`, `listLogChunks`, `listWorkers`, `getWorkerDetail`, `recordRunTransition`, `recordRunStage`, `upsertRepository`.
- All query functions accept `organizationId` before resource IDs and return shared DTO-compatible records.

- [ ] Add tables for installations, repositories, workflow runs, run stages, jobs, action edges, log chunks, resource observations, and outbox invalidations.
- [ ] Add organization-scoped indexes and foreign keys.
- [ ] Implement monotonic run transition checks with terminal-state protection.
- [ ] Implement cursor pagination ordered by stable `(created_at,id)` pairs.
- [ ] Test tenant isolation, transition ordering, cursor boundaries, and bounded log chunk size.
- [ ] Run `bun test tests/dashboard-db.test.ts`.

### Task 3: Implement organization dashboard REST APIs

**Files:**
- Modify: `apps/control-plane/src/index.ts`
- Create: `apps/control-plane/src/dashboard-api.ts`
- Create: `apps/control-plane/src/dashboard-api.test.ts`

**Interfaces:**
- Produces handlers for:
  - `GET /api/organizations`
  - `GET /api/organizations/:orgId/overview`
  - `GET /api/organizations/:orgId/repositories`
  - `GET /api/organizations/:orgId/runs`
  - `GET /api/organizations/:orgId/runs/:runId`
  - `GET /api/organizations/:orgId/runs/:runId/logs`
  - `GET /api/organizations/:orgId/workers`
  - worker mutations `adopt`, `reject`, `drain`, `remove`.
- Each mutation validates `Idempotency-Key`, returns the shared `ApiError` envelope, and hides foreign resources as `404`.

- [ ] Add authenticated organization membership/global-admin authorization.
- [ ] Parse filters, cursors, and bounded log parameters with Zod.
- [ ] Wire worker actions to existing adoption/dispatch lifecycle functions.
- [ ] Add focused tests for organization isolation, pagination, errors, idempotency, and worker state transitions.
- [ ] Run control-plane focused tests and typecheck.

### Task 4: Ingest GitHub run metadata and lifecycle stages

**Files:**
- Modify: `apps/control-plane/src/github.ts`
- Modify: `apps/control-plane/src/webhook.ts`
- Create: `apps/control-plane/src/runs.ts`
- Test: `tests/run-lifecycle.test.ts`

**Interfaces:**
- Produces `applyWorkflowJobWebhook(payload)` and `recordRunStage(runId, stage, timestamps)`.
- Converts GitHub workflow/job events into organization-owned runs, jobs, stages, action edges, and monotonic outcomes.

- [ ] Resolve tenancy only from approved installation IDs.
- [ ] Upsert repository/run/job records using immutable GitHub IDs.
- [ ] Record queued, started, completed, and teardown stage timing.
- [ ] Preserve unknown/pending installations as no-op `202` webhook responses.
- [ ] Test duplicate deliveries, late events, terminal-state protection, and stage duration calculation.
- [ ] Run focused lifecycle tests.

### Task 5: Build dashboard shell and organization navigation

**Files:**
- Replace: `apps/web/src/index.tsx`
- Replace: `apps/web/src/styles.css`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/router.tsx`
- Create: `apps/web/src/components/AppShell.tsx`
- Create: `apps/web/src/components/StateView.tsx`

**Interfaces:**
- Consumes shared dashboard DTOs and API helpers.
- Produces routes `/`, `/runs`, `/runs/:runId`, `/repositories`, `/workers`, `/pools`, `/settings`.
- `api.ts` exports organization-rooted query functions and `mutateWithIdempotency`.

- [ ] Add persistent organization selector and navigation shell.
- [ ] Add loading, empty, error, unauthorized, offline, and reduced-motion state components.
- [ ] Configure organization-rooted TanStack Query keys and route prefetch.
- [ ] Preserve `/api/me` and current OAuth behavior.
- [ ] Run web typecheck and build.

### Task 6: Implement overview, runs, and run detail screens

**Files:**
- Create: `apps/web/src/routes/OverviewPage.tsx`
- Create: `apps/web/src/routes/RunsPage.tsx`
- Create: `apps/web/src/routes/RunDetailPage.tsx`
- Create: `apps/web/src/components/charts/TrendChart.tsx`
- Create: `apps/web/src/components/charts/OutcomeBars.tsx`
- Create: `apps/web/src/components/RunTable.tsx`
- Create: `apps/web/src/components/RunTimeline.tsx`
- Create: `apps/web/src/components/ActionGraph.tsx`
- Create: `apps/web/src/components/LogViewer.tsx`
- Test: `apps/web/src/routes/dashboard.test.tsx`

**Interfaces:**
- Consumes `OverviewDto`, `CursorPage<RunSummary>`, `RunDetail`, and `CursorPage<LogChunk>`.
- `ActionGraph` accepts `ActionGraph` and exposes a table fallback.

- [ ] Add overview metric cards, trend/outcome charts, capacity, and recent runs.
- [ ] Add filterable cursor-paginated runs table.
- [ ] Add run detail header, result, lifecycle timeline, per-stage duration, resources, graph, and logs.
- [ ] Add accessible graph node summaries and dependency table fallback.
- [ ] Add log chunk loading and search state without claiming live streaming.
- [ ] Test loading/error/empty, route navigation, graph fallback, and result rendering.
- [ ] Run web tests/typecheck/build.

### Task 7: Implement worker management screen and flows

**Files:**
- Create: `apps/web/src/routes/WorkersPage.tsx`
- Create: `apps/web/src/components/WorkerCard.tsx`
- Create: `apps/web/src/components/WorkerDoctor.tsx`
- Create: `apps/web/src/components/WorkerActions.tsx`
- Create: `apps/web/src/components/EnrollmentWizard.tsx`
- Test: `apps/web/src/routes/workers.test.tsx`

**Interfaces:**
- Consumes `CursorPage<WorkerDetail>`, `WorkerDoctor`, and `CapacitySnapshot`.
- Uses API mutations with `Idempotency-Key`; successful mutations invalidate organization worker and overview keys.

- [ ] Split pending adoption from active worker management.
- [ ] Render fingerprint confirmation, doctor checks/remediation, capacities, ceilings, leases, and sandboxes.
- [ ] Implement Adopt, Reject, Drain, Rotate key, and Remove controls with confirmation and failure states.
- [ ] Implement enrollment wizard with separate one-use code and installer command blocks.
- [ ] Add keyboard-complete dialogs and responsive worker cards/table.
- [ ] Test pending/adopted/offline/error states and mutation invalidation.
- [ ] Run web tests/typecheck/build.

### Task 8: Add repositories, pools, settings, and invalidation refresh

**Files:**
- Create: `apps/web/src/routes/RepositoriesPage.tsx`
- Create: `apps/web/src/routes/PoolsPage.tsx`
- Create: `apps/web/src/routes/SettingsPage.tsx`
- Create: `apps/web/src/invalidation.ts`
- Modify: `apps/control-plane/src/index.ts`
- Test: `tests/dashboard-invalidation.test.ts`

**Interfaces:**
- Browser invalidation messages are `{version:1,sequence,organizationId,type:"invalidate",keys,occurredAt}`.
- Sequence gaps invalidate all organization query caches and REST polling remains fallback.

- [ ] Add repository inventory and pool/settings placeholder states backed by real organization APIs where available.
- [ ] Add browser WebSocket invalidation handling with sequence-gap recovery.
- [ ] Verify no organization cache or socket event crosses tenant boundaries.
- [ ] Test invalidation ordering and gap behavior.
- [ ] Run focused tests.

### Task 9: Run full verification and smoke the dashboard

**Files:**
- Modify: `IMPLEMENTATION-STATUS.md`
- Test: existing workspace test suites and browser smoke flow.

- [ ] Run `bun install --frozen-lockfile`.
- [ ] Run `bun run typecheck`, `bun run lint`, `bun test`, and `bun run build`.
- [ ] Run Compose configuration validation with required environment values.
- [ ] Exercise organization selection, runs/history/detail, stage timings, graph, logs, result, worker adoption, and worker actions in Chromium.
- [ ] Verify responsive, keyboard, reduced-motion, and empty/error states.
- [ ] Update implementation status with exact verification evidence.
- [ ] Commit API/UI work in coherent commits and push `main`.
