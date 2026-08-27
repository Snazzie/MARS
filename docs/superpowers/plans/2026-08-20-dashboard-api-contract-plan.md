# Dashboard API Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard client/server request and response shapes share one compile-time-visible contract while preserving existing behavior.

**Architecture:** Add a shared `dashboard-api.ts` contract module in `packages/contracts`, then migrate the browser API client and control-plane HTTP handlers to import those schemas. Keep runtime parsing at HTTP/database boundaries and normalize database timestamps before protocol schema validation.

**Tech Stack:** TypeScript, Zod, Bun, Hono, Bun test, workspace package `@mars/contracts`.

## Global Constraints

- Preserve existing dashboard URLs, HTTP methods, authentication, status codes, and error payloads.
- No OpenAPI generator, generated files, database migrations, or worker protocol redesign.
- Shared endpoint schemas own wire-format shapes; database row types remain adapter-local.
- Runtime validation remains mandatory for HTTP, database, and worker data.
- Use tests first for every new contract or behavior.

---

### Task 1: Add shared dashboard endpoint contracts

**Files:**
- Create: `packages/contracts/src/dashboard-api.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/dashboard-api.test.ts`

**Interfaces:**
- Produces schemas and inferred types consumed by `apps/web/src/api.ts` and `apps/control-plane/src/http`.
- Export `DashboardConfigureWorkerResponse`, `DashboardMutationResponse`, `DashboardHealthResponse`, and equivalent names for migrated endpoint payloads.

- [ ] **Step 1: Write failing schema coverage**

Add tests that import the future schemas and assert representative payloads parse:

```ts
import { expect, test } from "bun:test";
import { DashboardConfigureWorkerResponse, DashboardHealthResponse } from "./dashboard-api.ts";

test("parses worker configuration response", () => {
  expect(DashboardConfigureWorkerResponse.parse({
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
    commandId: "00000000-0000-4000-8000-000000000001",
  }).revision).toHaveLength(64);
});

test("rejects malformed health response", () => {
  expect(() => DashboardHealthResponse.parse({ ok: "yes" })).toThrow();
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun test packages/contracts/src/dashboard-api.test.ts
```

Expected: module/schema import failure because the shared endpoint module does not exist.

- [ ] **Step 3: Define shared schemas**

Implement schemas by composing existing domain schemas. Start with all response schemas currently declared inline in `apps/web/src/api.ts`, plus request schemas currently parsed independently by dashboard routes. Export `z.infer` types and a small endpoint metadata type:

```ts
export type DashboardEndpoint<Req extends z.ZodTypeAny | undefined, Res extends z.ZodTypeAny> = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  request: Req;
  response: Res;
};
```

Use strict schemas where the existing wire contract is strict. Do not alter payload keys or optionality during this migration.

- [ ] **Step 4: Export the module**

Add `export * from "./dashboard-api.ts";` to `packages/contracts/src/index.ts`.

- [ ] **Step 5: Run contract tests**

Run:

```bash
bun test packages/contracts/src/dashboard-api.test.ts
```

Expected: all tests pass.

---

### Task 2: Migrate browser and server dashboard API usage

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/http/app.ts`
- Modify: `apps/web/src/api.test.ts`
- Modify: `apps/control-plane/src/http/dashboard-api.test.ts`

**Interfaces:**
- Consumes schemas exported by Task 1.
- `request()` remains the single browser JSON parser; endpoint functions pass shared schemas rather than recreating them.
- Server handlers continue returning Hono `Response` values with current status codes.

- [ ] **Step 1: Inventory inline schemas and write migration assertions**

Add tests asserting the configure-worker response and representative health/mutation responses parse using the shared schemas. Add a compile-time assertion in a test-adjacent TypeScript module:

```ts
const configureEndpoint = {
  method: "POST",
  request: WorkerConfiguration,
  response: DashboardConfigureWorkerResponse,
} satisfies DashboardEndpoint<typeof WorkerConfiguration, typeof DashboardConfigureWorkerResponse>;
```

- [ ] **Step 2: Run focused tests before migration**

Run:

```bash
bun test apps/web/src/api.test.ts apps/control-plane/src/http/dashboard-api.test.ts
```

Expected: the new compile-time/schema references fail until imports and shared definitions are wired.

- [ ] **Step 3: Replace browser inline response schemas**

Import shared schemas from `@mars/contracts` in `apps/web/src/api.ts`. Replace duplicate schemas for health, worker configuration, workers, pools, settings, repositories, runs, onboarding, and mutation responses. Preserve request paths, headers, body serialization, and response parsing behavior.

- [ ] **Step 4: Apply shared request/response schemas on the server**

In `dashboard-routes.ts`, replace local request schemas where a shared schema exists. Parse request bodies with the shared schema and validate response DTOs at the return boundary where the current handler already has a corresponding domain schema. Keep authorization and error mapping unchanged.

Register `/api/me` using the existing authenticated route behavior; do not broaden authentication middleware to unknown API routes.

- [ ] **Step 5: Run focused client/server suites**

Run:

```bash
bun test apps/web/src/api.test.ts apps/control-plane/src/http/dashboard-api.test.ts apps/control-plane/src/http/app.test.ts
```

Expected: zero failures.

---

### Task 3: Consolidate timestamp normalization and regression coverage

**Files:**
- Modify: `apps/control-plane/src/worker-dispatch.ts`
- Modify: `apps/control-plane/src/index.ts`
- Modify: `apps/control-plane/src/worker-dispatch.test.ts`
- Modify: `apps/control-plane/src/browser-invalidations.ts`
- Modify: `apps/control-plane/src/browser-invalidations.test.ts`

**Interfaces:**
- `normalizeTimestamp(value: unknown): unknown` converts `Date` and parseable database timestamp strings to ISO strings; invalid values remain invalid for schema rejection.
- All command replay and dashboard invalidation adapters use the same normalization rule.

- [ ] **Step 1: Add failing coverage for all timestamp inputs**

Cover JavaScript `Date`, PostgreSQL-style strings, ISO strings, and malformed values. Assert malformed values still fail the shared schema rather than being silently replaced.

- [ ] **Step 2: Run timestamp tests and verify the malformed boundary fails correctly**

Run:

```bash
bun test apps/control-plane/src/worker-dispatch.test.ts apps/control-plane/src/browser-invalidations.test.ts
```

Expected: the new PostgreSQL-style normalization test fails before implementation and malformed input is rejected.

- [ ] **Step 3: Use one normalization helper at all database/protocol boundaries**

Move the helper to the narrowest shared control-plane utility if both command and invalidation adapters need it. Import it from `index.ts`, `worker-dispatch.ts`, and `browser-invalidations.ts`; do not duplicate date parsing logic.

- [ ] **Step 4: Run timestamp regression tests**

Run the same focused command. Expected: all timestamp tests pass with malformed values still rejected.

---

### Task 4: Run verification and review the contract migration

**Files:**
- Modify: only files identified by prior tasks if test fixes are required.

- [ ] **Step 1: Run package contract and control-plane suites**

```bash
bun test packages/contracts/src/dashboard-api.test.ts apps/control-plane/src/worker-dispatch.test.ts apps/control-plane/src/browser-invalidations.test.ts apps/control-plane/src/http/app.test.ts apps/control-plane/src/http/dashboard-api.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run web API and affected component tests**

```bash
bun test apps/web/src/api.test.ts apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/WorkerCard.test.tsx
```

Expected: zero failures.

- [ ] **Step 3: Run type checking**

```bash
bun run typecheck
```

Expected: all workspace packages typecheck successfully; this is the build-time drift gate.

- [ ] **Step 4: Smoke-test the live API boundary**

With the development stack running, request `/api/healthz` and `/api/me`. Confirm health returns the existing JSON shape and unauthenticated `/api/me` returns a JSON `401`, never an empty body.

- [ ] **Step 5: Review changed files for scope**

Confirm no routes, status codes, auth rules, database schemas, generated artifacts, or worker protocol payloads changed unintentionally.
