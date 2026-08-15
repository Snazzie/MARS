# Worker Capacity Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate worker-wide concurrency from per-job limits and enforce aggregate worker capacity during dynamic scheduling.

**Architecture:** Keep per-job CPU, memory, and storage ceilings in the worker runtime policy. Add a worker-wide `maxConcurrentJobs` setting to worker configuration/state. Reservation transactions sum active lease requests for the worker and admit a job only when aggregate capacity and concurrency remain available.

**Tech Stack:** Bun, TypeScript, Zod, React, PostgreSQL tagged SQL, Bun tests.

## Global Constraints

- `maxConcurrentJobs` is a worker-wide setting, not a per-job resource limit.
- Per-job CPU, memory, and storage limits are independent ceilings; never multiply them by concurrency.
- Worker appliance CPU, memory, and storage are aggregate capacity ceilings across active jobs.
- Scheduling checks must be atomic immediately before lease insertion.
- Existing storage and pool constraints remain enforced.

## Tasks

### Task 1: Split configuration contracts and UI

Modify contracts, worker configuration payloads, dashboard worker types, `WorkerConfigurationForm`, and worker agents so runtime limits contain only per-job CPU/memory/storage and worker concurrency is a separate field. Render separate UI sections and preserve acknowledgement round trips.

Tests: contract parsing, configuration persistence, UI markup, agent acknowledgement fixtures.

### Task 2: Persist worker-wide concurrency

Add a schema migration/column for worker-wide concurrency, populate it from existing `limits.maxConcurrentPods`, update worker reads/writes and dashboard normalization, and remove the legacy field from per-job limits after migration.

Tests: schema/configuration persistence and backward-compatible migration behavior.

### Task 3: Enforce aggregate capacity atomically

Update scheduler candidates and `reserveRoutingSlot` to use worker appliance capacity as aggregate CPU/memory/storage capacity. Sum active lease `requested` JSON dimensions for the worker inside the transaction, enforce `maxConcurrentJobs` independently, and retain per-job ceilings and pool storage/concurrency checks.

Tests: multiple active leases consuming aggregate capacity, queueing when one dimension is exhausted, independent concurrency, and capacity release.

### Task 4: Update docs and verification

Update `docs/worker-routing-labels.md` with the separate concurrency and aggregate-capacity model. Run focused tests, full typecheck, and commit/push to main.
