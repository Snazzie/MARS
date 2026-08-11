# Whitesmith Dashboard Design

## Decision

Build an organization-rooted operations console backed by typed REST DTOs. API and React UI are parallel workstreams sharing contracts in `packages/contracts`.

## Goals

- Show per-organization and per-repository workflow run history.
- Show run content, lifecycle stages, stage durations, action/job dependencies, logs, result, and observed runtime resources.
- Provide a dedicated worker-management experience for enrollment, adoption, doctor state, capacity, leases, draining, key rotation, and removal.
- Preserve tenant isolation, cursor pagination, accessible chart summaries, and the existing worker APIs during migration.

## Information architecture

Routes:

- `/` overview
- `/runs` filtered run history
- `/runs/:runId` run detail
- `/repositories` repository inventory
- `/workers` worker management
- `/pools` runner pools
- `/settings` organization settings

The organization selector is persistent. Organization IDs are present in every query key and API route. Cross-tenant resources return `404`.

## Overview

The overview contains outcome counts, queued/running/completed/failed/cancelled trends, p50/p95 queue and execution durations, worker capacity, active leases, and recent repository runs. Charts have textual summaries and table fallbacks. Empty, loading, error, offline, and unauthorized states are explicit.

## Runs and run detail

Run history supports organization, repository, branch/event, status, and date filters. It uses cursor pagination and route-prefetching. Rows show repository/workflow, run number/event, commit, actor, result, timestamps, duration, and runtime boundary.

Run detail shows result metadata, commit and actor, lifecycle stages (`queued`, `allocating`, `provisioning`, `sandbox_ready`, `online`, `running`, `completed`, `reaping`, `reaped`), per-stage timestamps/durations, job/action dependency graph, job and step content, bounded searchable logs, requested versus observed resources, image digest, and teardown/reconciliation status.

The graph is accessible SVG/HTML with status colors, labels, keyboard-readable node summaries, and a tabular dependency fallback. No live step-log streaming is claimed; completed logs are served as bounded chunks.

## Workers

The worker screen separates pending adoption from operational management. It shows admission, connection, and configuration state; fingerprint, platform, driver, VM UUID; doctor checks/remediation; actual/reserved/free CPU, memory, and storage; ceilings and concurrency; active leases/sandboxes; and actions for Adopt, Reject, Drain, Rotate key, and Remove.

Enrollment is a dedicated wizard. One-use codes are displayed separately from copyable installer commands and never placed in URLs, arguments, environment values, or browser logs. Adoption requires fingerprint confirmation and clear pending/rejected/revoked states.

## API contract

New organization-rooted routes:

- `GET /api/organizations`
- `GET /api/organizations/:orgId/overview`
- `GET /api/organizations/:orgId/repositories`
- `GET /api/organizations/:orgId/runs`
- `GET /api/organizations/:orgId/runs/:runId`
- `GET /api/organizations/:orgId/runs/:runId/logs`
- `GET /api/organizations/:orgId/workers`
- `POST /api/organizations/:orgId/workers/:workerId/adopt`
- `POST /api/organizations/:orgId/workers/:workerId/reject`
- `POST /api/organizations/:orgId/workers/:workerId/drain`
- `POST /api/organizations/:orgId/workers/:workerId/remove`

DTOs define cursor pagination, run/job/stage/graph records, worker doctor/capacity records, typed error envelopes, and invalidation events. Mutations require `Idempotency-Key`. Browser invalidation messages remain sequence-based; REST polling is the fallback.

## Persistence

Add organization-owned records for GitHub installations/repositories, workflow runs/jobs/steps, lifecycle stage events, log chunks and searchable metadata, dependency edges, resource observations, and outbox/invalidation events. Existing workers, pools, leases, commands, audit events, and webhook deliveries remain authoritative for their domains.

Workflow transitions are monotonic and terminal states win. Logs are fetched after completion, stored gzip-compressed under canonical organization/repository/run/attempt/job paths, and indexed with organization-scoped metadata. Default retention is 30 days, capped at 365 days.

## Visual system and accessibility

Use the existing dark shell as a graphite operations console: mint success, amber pending, coral failure, compact resource typography, and restrained motion. Keep desktop density while providing responsive stacking. All controls are keyboard-complete, focus-visible, reduced-motion safe, and WCAG AA. Charts are wrapped in internal components with readable summaries and accessible table fallbacks.

## Parallel implementation contract

The API workstream owns migrations, repository/query services, DTO schemas, REST handlers, and representative fixtures. The UI workstream owns route layout, query hooks, visual components, graph/log rendering, worker flows, and fixtures. Both may use fixture adapters until the API endpoints are available, but fixture shapes must exactly match shared contracts. Neither workstream may invent a second DTO shape or bypass organization scoping.

## Verification

- API: migration, tenant-isolation, pagination, lifecycle ordering, log chunk bounds, mutation idempotency, and typed error tests.
- UI: typecheck/build, route rendering with loading/empty/error states, graph/table fallback, worker adoption actions, keyboard navigation, reduced motion, and responsive layout.
- End-to-end: organization switch, repository/run detail, stage timings, logs, graph, result, worker adoption, and invalidation refresh without cross-tenant cache reuse.
