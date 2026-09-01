# Runner Cache Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-enabled per-worker runner caching with user-configurable TTL and size cap, plus an authenticated per-worker purge action without affecting the GitHub Actions cache.

**Architecture:** Extend the shared worker configuration contract with `cache.runnerCacheEnabled`, `cache.ttlSeconds`, and `cache.runnerCacheMaxGiB`. Workers apply all three settings live to the package-download cache while retaining the existing Actions cache. Add a durable worker command for purge, dispatched by the control plane and handled by each worker runtime; purge clears only package-cache objects and metadata.

**Tech Stack:** Bun, TypeScript, Zod contracts, PostgreSQL control-plane persistence, existing worker WebSocket command dispatcher, Bun SQLite package cache, React dashboard.

## Global Constraints

- The public configuration fields are exactly `cache.runnerCacheEnabled`, `cache.ttlSeconds`, and `cache.runnerCacheMaxGiB`.
- `runnerCacheEnabled` defaults to `true` for existing and development workers.
- `runnerCacheMaxGiB` defaults to `20` and is configured in whole GiB.
- `ttlSeconds` is configurable per worker and applies to package entries through the existing shared TTL lifecycle.
- When enabled, the package cache evicts least-recently-used ready packages to remain within `runnerCacheMaxGiB`; active fills are never evicted.
- Disabling bypasses package caching but retains existing package objects.
- Purge is per worker, authenticated, audited, idempotent, and never deletes the GitHub Actions cache.
- Applying configuration does not restart proxy or HTTPS listeners.
- Existing Actions-cache routes, status, snapshots, telemetry, and TTL behavior remain unchanged.
- Live fills must not publish after a purge; active fills may finish safely.

---

### Task 1: Extend shared configuration contracts

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Test: `packages/contracts/src/orchestration.test.ts`

**Interfaces:**
- Produce `WorkerCacheConfiguration` and `WorkerObservedConfiguration` with required `runnerCacheEnabled: boolean` and `runnerCacheMaxGiB: number` in observed payloads.
- Preserve `WorkerConfiguration` default parsing for old callers by defaulting `runnerCacheEnabled` to `true`, `runnerCacheMaxGiB` to `20`, and `ttlSeconds` to `172800`.

- [ ] Add tests proving omitted fields parse as `{ ttlSeconds: 172800, runnerCacheEnabled: true, runnerCacheMaxGiB: 20 }`, explicit values parse correctly, and observed configuration rejects missing fields.
- [ ] Run `bun test packages/contracts/src/orchestration.test.ts` and verify the new assertions fail before implementation.
- [ ] Update the Zod schemas so `WorkerCacheConfiguration` defaults all three fields and `RequiredWorkerCacheConfiguration` requires all three.
- [ ] Run `bun test packages/contracts/src/orchestration.test.ts` and verify it passes.
- [ ] Commit with `feat(contracts): add runner cache size cap`.

### Task 2: Add package-cache policy and purge primitive

**Files:**
- Modify: `apps/orchestrator/src/action-cache/package-download-cache.ts`
- Modify: `apps/orchestrator/src/action-cache/package-download-cache.test.ts`
- Modify: `apps/orchestrator/src/action-cache/service.ts`
- Modify: `apps/orchestrator/src/action-cache/service.test.ts`

**Interfaces:**
- Extend `PackageDownloadCache` with `setEnabled(enabled: boolean): void`, `setMaxBytes(maxBytes: bigint): void`, and `purge(): Promise<void>`.
- `startActionCacheService` applies `runnerCacheEnabled`, `ttlSeconds`, and `runnerCacheMaxGiB` while preserving defaults for direct callers.

- [ ] Add tests for disabled pass-through, re-enable hit reuse, TTL refresh/expiry, size-cap LRU eviction, active-fill protection, purge removing package rows/objects, purge idempotence, and Actions-cache object isolation.
- [ ] Run the focused package/service tests and verify the new tests fail before implementation.
- [ ] Add enabled state, positive safe GiB-to-byte validation, and LRU eviction after successful publication or configuration changes; never evict active fills.
- [ ] Add purge generation/state protection so fills started before purge cannot publish after a purge; remove package rows and object files, retain the package SQLite/database layout, and make repeated purge safe.
- [ ] Add service lifecycle wiring so TTL, enabled state, and size cap are independent controls and listener startup/closure is unchanged.
- [ ] Run `bun test apps/orchestrator/src/action-cache/package-download-cache.test.ts apps/orchestrator/src/action-cache/service.test.ts` and verify all pass.
- [ ] Commit with `feat(cache): support runner cache policy and purge`.

### Task 3: Apply configuration on Linux, macOS, and Windows workers

**Files:**
- Modify: `apps/orchestrator/src/linux-agent.ts`
- Modify: `apps/orchestrator/src/mac-agent.ts`
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Modify: corresponding `linux-agent.test.ts`, `mac-agent.test.ts`, and `windows-agent.test.ts`
**Interfaces:**
- Consume `WorkerConfigurePayload.cache.runnerCacheEnabled`, `cache.ttlSeconds`, and `cache.runnerCacheMaxGiB`.
- Consume `ActionCacheService` runtime methods for changing package-cache enabled state and size cap.
- Continue calling `applyTtl` with `cache.ttlSeconds` and report the complete observed cache configuration.

- [ ] Add platform tests asserting configure applies TTL, enable state, and size cap, and the acknowledgement includes the exact observed values.
- [ ] Run the three platform test files and verify new assertions fail before implementation.
- [ ] Call the package-cache toggle and size-cap methods through the service during each platform’s existing `worker.configure` path before emitting `worker.configured`.
- [ ] Keep platform resource and lease behavior unchanged.
- [ ] Run `bun test apps/orchestrator/src/linux-agent.test.ts apps/orchestrator/src/mac-agent.test.ts apps/orchestrator/src/windows-agent.test.ts`.
- [ ] Commit with `feat(worker): apply runner cache policy`.

### Task 4: Add durable purge worker command

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `apps/control-plane/src/worker-requests.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/control-plane-gateway.ts` if acknowledgement routing requires it
- Modify: `apps/orchestrator/src/linux-agent.ts`
- Modify: `apps/orchestrator/src/mac-agent.ts`
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Test: matching worker request, dispatch, acknowledgement, and platform command tests

**Interfaces:**
- Add command type exactly `worker.runner_cache_purge` with no lease ID and a payload containing the command ID/worker ID through existing command envelopes.
- Add an authenticated per-worker control-plane endpoint that dispatches this command and records an audit event.
- Workers acknowledge success/failure through the existing `command.accepted`/worker event command lifecycle.

- [ ] Add failing tests for authenticated purge dispatch, unauthenticated rejection, idempotent replay, command persistence, and all three worker runtimes handling the command.
- [ ] Run the focused control-plane and worker tests and verify the new tests fail before implementation.
- [ ] Implement the command schema, durable dispatch, endpoint authorization, audit record, and worker handlers calling `packageDownloadCache.purge()`.
- [ ] Ensure a disconnected worker retains the pending command for replay when it reconnects.
- [ ] Run the focused command/control-plane/worker tests and verify all pass.
- [ ] Commit with `feat(cache): add durable runner cache purge command`.

### Task 5: Expose control in the worker management UI

**Files:**
- Modify: `apps/web/src/components/WorkerConfigurationForm.tsx`
- Modify: `apps/web/src/components/WorkerCard.tsx`
- Modify: `apps/web/src/api.ts`
- Test: `apps/web/src/components/WorkerConfigurationForm.test.tsx`
- Test: `apps/web/src/components/WorkerCard.test.tsx`
- Test: `apps/web/src/api.test.ts`

**Interfaces:**
- Display and edit `cache.runnerCacheEnabled` alongside the existing cache TTL.
- Provide a per-worker `Purge runner cache` action calling the authenticated endpoint from Task 4.

- [ ] Add UI tests for enabled default, disabling, re-enabling, purge confirmation, success feedback, and failed-request feedback.
- [ ] Run the affected web tests and verify new assertions fail before implementation.
- [ ] Wire the control to the existing worker configuration mutation and purge endpoint without changing unrelated worker settings.
- [ ] Run the affected web tests and verify all pass.
- [ ] Commit with `feat(web): add runner cache controls`.

### Task 6: End-to-end verification and documentation

**Files:**
- Modify: `apps/orchestrator/src/action-cache/service.test.ts` if end-to-end coverage needs a focused fixture
- Modify: relevant control-plane/worker test files for cross-boundary assertions
- Modify: `docs/superpowers/specs/2026-09-01-runner-cache-control-design.md` only if implementation decisions changed

- [ ] Run `bun test apps/orchestrator/src/action-cache/package-download-cache.test.ts apps/orchestrator/src/action-cache/service.test.ts`.
- [ ] Run `bun test apps/job-agent/src/bootstrap.test.ts`.
- [ ] Run platform worker and control-plane focused tests covering configuration and purge.
- [ ] Run `bun run --filter @mars/orchestrator typecheck` and the control-plane/web typechecks.
- [ ] Run `bun test` from the repository root.
- [ ] Verify `git status --short` is clean and push the completed commits to `main`.
