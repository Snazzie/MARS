# API Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed persistence data and API response drift from breaking the worker UI.

**Architecture:** Keep `packages/contracts` as the single source of API schemas. Use explicitly typed repository DTO mappers so contract changes fail at build time, validate dynamic persistence at the repository boundary, and make the web client report the endpoint and contract path when runtime data still violates a contract. Do not weaken client schemas.

**Tech Stack:** TypeScript, Bun, Hono, Zod, React Query, Bun test.

## Global Constraints

- Reuse existing schemas from `@whitesmith/contracts`.
- Invalid nullable timestamps normalize to `null`.
- No database mutation or silent schema relaxation.
- Run targeted tests; skip formatters and project-wide suites during implementation.

---

### Task 1: Harden worker repository DTOs

**Files:**
- Modify: `packages/db/src/dashboard.ts`
- Test: `packages/db/src/dashboard.test.ts`

**Interfaces:**
- `listWorkers` and `listAllWorkers` continue returning `CursorPage<WorkerDetail>`.
- `normalizeWorker` must emit values accepted by `WorkerDetail`.

- [x] Normalize malformed worker timestamps to `null`.
- [x] Add regression coverage for empty and invalid timestamp strings.
- [x] Replace the worker DTO type assertion with an explicit `WorkerDetail` object.
- [x] Run `bun test packages/db/src/dashboard.test.ts`.

### Task 2: Improve web response validation diagnostics

**Files:**
- Modify: `apps/web/src/api.ts`
- Test: `apps/web/src/api.test.ts` or the existing API contract test file.

**Interfaces:**
- `request(path, schema, init)` remains the shared typed request helper.
- Contract parse failures include HTTP method, path, and Zod issue paths.

- [x] Add endpoint-aware validation errors.
- [x] Add a regression test for a malformed worker response.
- [x] Run the focused web API test.

### Task 3: Build-time and repository contract coverage

**Files:**
- Modify: `packages/db/src/dashboard.ts`
- Modify: `packages/db/src/dashboard.test.ts`
- Modify: `tests/dashboard-contracts.test.ts` only for shared schema coverage.

**Interfaces:**
- Worker repository functions return `CursorPage<WorkerDetail>`.
- `normalizeWorker` constructs an explicit `WorkerDetail`; no `as WorkerDetail` assertion is permitted.

- [x] Keep shared `WorkerDetail` schemas as the source of inferred UI/API types.
- [x] Cover malformed timestamp persistence at the repository boundary.
- [x] Preserve shared schema tests for malformed timestamps and response shape.

### Task 4: Verify affected contracts

- [x] Run `bun test packages/db/src/dashboard.test.ts`.
- [x] Run `bun test apps/web/src/api.test.ts`.
- [x] Run `bun test tests/dashboard-contracts.test.ts`.
- [x] Run typecheck for affected packages.
