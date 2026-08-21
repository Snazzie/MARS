# Per-worker Lease Preservation Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace install-time preservation environment configuration with a persisted per-worker control delivered by a durable command and dashboard/API toggle.

**Architecture:** PostgreSQL stores `workers.preserve_leases` as desired state. The API dispatches `worker.set_lease_preservation` with `{ enabled: boolean }`. The worker atomically persists the applied value in its existing state directory, reports it in doctor data, and lifecycle/cleanup paths read the live value. Disabling requeues existing `debug_preserved` leases for durable normal cleanup.

**Tech Stack:** Bun, TypeScript, Hono, Zod, PostgreSQL/Drizzle SQL, React, PowerShell, existing WebSocket worker command/event protocol.

## Global Constraints

- Default disabled for existing and new workers.
- Global administrators only.
- Immediate effect for running leases, future leases, and pending cleanup.
- Disable requeues existing `debug_preserved` leases.
- Worker persistence completes before acknowledgement.
- Remove `WHITESMITH_DEBUG_PRESERVE_LEASES` from config, installer, and runtime.
- Do not alter runner-loss classification, allocation, capacity, or unrelated cleanup retry behavior.

## Layer Contract Matrix

| Boundary | Producer | Consumer | Proof |
|---|---|---|---|
| DB schema | `workers.preserve_leases` | dashboard/API | migration/default tests |
| DTO | `preserveLeases: boolean` | web client/UI | Zod/normalization tests |
| API | `{enabled:boolean}` | mutation handler | auth/validation/idempotency tests |
| Command | `worker.set_lease_preservation` | worker WebSocket | serialization/replay tests |
| Event | applied `{commandId,workerId,enabled}` | control plane | schema/ack tests |
| Local state | `preserveLeases` | restart/lifecycle | write-before-ack/reload tests |
| Doctor | applied setting | control plane/UI | doctor contract tests |
| Cleanup | live boolean | lifecycle/stop handler | enabled/disabled tests |
| Disable | `debug_preserved -> pending` | cleanup dispatcher | requeue/runtime command tests |

### Task 1: Persist desired state and typed DTO

Files: `packages/db/src/schema.ts`, `packages/db/src/drizzle-schema.ts`, `packages/db/src/dashboard.ts`, `packages/contracts/src/dashboard.ts`, schema/dashboard tests.

- [ ] Add failing assertions for idempotent migration, Drizzle field, query projection, normalization, and DTO `preserveLeases`.
- [ ] Run `bun test packages/db/src/schema.test.ts tests/dashboard-contracts.test.ts`; verify failure.
- [ ] Add `preserve_leases boolean NOT NULL DEFAULT false` to canonical schema/migration and typed/query paths.
- [ ] Re-run focused tests; require zero failures.
- [ ] Commit `feat(db): persist worker lease preservation`.

Layer check: query a worker through the dashboard mapper and validate with the same DTO consumed by the web client.

### Task 2: Add protocol schemas and worker durable state

Files: `packages/contracts/src/orchestration.ts`, existing orchestrator state helper, `apps/orchestrator/src/windows-agent.ts`, `apps/orchestrator/src/lease-lifecycle.ts`, orchestrator tests.

- [ ] Add failing tests for command parsing, worker-ID validation, write-before-ack, default-false load, restart reload, doctor field, and enabled/disabled cleanup.
- [ ] Run `bun test apps/orchestrator/src/windows-agent.test.ts apps/orchestrator/src/lease-lifecycle.test.ts`; verify failure.
- [ ] Add command/event schemas and doctor field; persist via atomic state-file replacement; load at startup; handle command; remove environment reads.
- [ ] Re-run focused tests; require zero failures.
- [ ] Commit `feat(worker): persist lease preservation setting`.

Layer check: serialize command through `WorkerCommand`, process it, parse emitted event through `WorkerEventPayload`, reload state, and verify lifecycle sees the same value.

### Task 3: Wire control-plane command/replay and acknowledgement

Files: `apps/control-plane/src/worker-configuration.ts` or command persistence module, `worker-dispatch.ts`, `worker-lifecycle.ts`, tests.

- [ ] Add failing tests for exact command payload, replay, idempotency, acknowledgement validation, and doctor applied-state reporting.
- [ ] Run focused control-plane worker tests; verify failure.
- [ ] Persist desired state before dispatch, reuse durable replay, accept only matching acknowledgements, expose pending versus applied.
- [ ] Re-run focused tests; require zero failures.
- [ ] Commit `feat(control-plane): reconcile lease preservation`.

Layer check: capture serialized command from API mutation, replay it, and verify only the target worker changes.

### Task 4: Add API mutation and immediate disable cleanup

Files: `apps/control-plane/src/http/dashboard-routes.ts`, dashboard API contracts, `lease-cleanup.ts`, `lease-reconciliation.ts`, API/cleanup tests.

- [ ] Add failing tests for global-admin auth, worker ownership, strict request validation, idempotency, desired update, dispatch, invalidation, and worker-scoped disable requeue.
- [ ] Run focused API/cleanup tests; verify failure.
- [ ] Implement `POST /api/organizations/:organizationId/workers/:workerId/lease-preservation` with `{enabled:boolean}`; atomically requeue matching `debug_preserved` leases on disable and preserve runtime-specific stop command selection.
- [ ] Re-run focused tests; require zero failures.
- [ ] Commit `feat(api): add worker preservation control`.

Layer check: issue HTTP request, parse response DTO, inspect command payload, and verify cleanup dispatch command.

### Task 5: Add dashboard toggle

Files: `apps/web/src/api.ts`, existing worker list/detail components, web tests.

- [ ] Add failing tests for rendering, accessible label, warning, pending/error, non-admin visibility, and refetch.
- [ ] Run focused web tests; verify failure.
- [ ] Add typed mutation and accessible toggle using existing auth/error/refetch patterns.
- [ ] Run web tests and browser smoke verification.
- [ ] Commit `feat(web): add worker preservation toggle`.

Layer check: use real API client request/response contract, not shape-only mocks.

### Task 6: Remove install-time environment plumbing

Files: `.env.example`, `deploy/control-plane/compose.yaml`, `apps/control-plane/src/http/worker-routes.ts`, `deploy/workers/install-worker.ps1`, orchestrator runtime files, installer tests.

- [ ] Add failing assertions for absent placeholder/assignment and no runtime environment dependency.
- [ ] Run installer/orchestrator focused tests; verify failure.
- [ ] Remove compose/env entry, route injection, PowerShell service assignment, and runtime reads; retain safe default false.
- [ ] Re-run tests and search for `WHITESMITH_DEBUG_PRESERVE_LEASES`; require no active production/config references.
- [ ] Commit `refactor: remove install-time lease preservation flag`.

Layer check: fetch generated installer through the actual route and inspect PowerShell output.

### Task 7: Cross-layer verification and operations docs

Files: existing worker operations docs and smoke tests.

- [ ] Run `bun test packages/db/src apps/control-plane/src apps/orchestrator/src apps/web/src tests/installer-arguments.test.ts tests/dashboard-contracts.test.ts`; require zero changed-area failures.
- [ ] Run typechecks for `@whitesmith/db`, `@whitesmith/control-plane`, `@whitesmith/orchestrator`, and `@whitesmith/web`; require no new changed-file diagnostics.
- [ ] Exercise disposable worker: enable, fail lease, verify retention/event; disable without reinstall, verify requeue/cleanup; restart and verify persistence/replay.
- [ ] Verify every Layer Contract Matrix boundary with observed data.
- [ ] Document toggle, resource warning, immediate disable cleanup, offline replay, and runner-loss semantics; do not document removed environment variable as active configuration.
- [ ] Commit `docs: document worker preservation control`.
