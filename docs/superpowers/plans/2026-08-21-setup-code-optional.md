# Optional First-Run Setup Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove first-run setup-code authorization from the private control-plane UI and setup endpoint while preserving idempotency and persisted origin configuration.

**Architecture:** The onboarding request sends only `publicBaseUrl`; the setup route validates the request and idempotency key, then calls `ControlPlaneSetup.configure` without a code. Setup-code generation, logging, file handling, and code-specific schema fields are removed because no caller uses them.

**Tech Stack:** Bun, TypeScript, Hono, Zod, React, Bun tests, Drizzle/PostgreSQL.

## Global Constraints

- The private deployment accepts unauthenticated setup because the user explicitly accepted the risk.
- `POST /api/setup/github-app` still requires `Idempotency-Key`.
- The request body is exactly `{ publicBaseUrl: string }`.
- The UI must not render or submit a setup-code field.
- Existing manifest response shape and canonical persisted-origin behavior remain unchanged.
- No compatibility alias for `setupCode` remains in production contracts.

---

### Task 1: Remove setup-code lifecycle and backend authorization

**Files:**
- Modify: `apps/control-plane/src/control-plane-setup.ts`
- Modify: `apps/control-plane/src/http/github-routes.ts`
- Modify: `packages/contracts/src/onboarding.ts`
- Modify: `apps/control-plane/src/index.ts`

**Interfaces:**
- `ControlPlaneSetup.configure` becomes `configure(candidateOrigin: string): Promise<string>`.
- `ControlPlaneSetup.authorize` and setup-code arguments are removed.
- Setup initialization no longer returns `setupCode`.
- `/api/setup/github-app` parses only `{ publicBaseUrl }` and retains the idempotency-key guard.

- [ ] **Step 1: Update backend tests to call setup without a code.**
- [ ] **Step 2: Run focused backend tests and verify failures identify stale setup-code signatures.**
- [ ] **Step 3: Remove setup-code file generation, hashing, logging, and authorization branches.**
- [ ] **Step 4: Change the setup route to call `deps.setup.configure(body.publicBaseUrl)`.**
- [ ] **Step 5: Remove `setupCode` from initialization and runtime logging.**
- [ ] **Step 6: Run `bun test apps/control-plane/src/control-plane-setup.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts`.**
- [ ] **Step 7: Commit backend changes.**

### Task 2: Remove setup-code UI and contract usage

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: `apps/web/src/routes/OnboardingPage.test.tsx`
- Modify: `packages/contracts/src/onboarding.ts`

**Interfaces:**
- `ControlPlaneSetupRequest` is `{ publicBaseUrl: string }`.
- `beginControlPlaneSetup` sends only `publicBaseUrl` plus a fresh idempotency key.

- [ ] **Step 1: Update UI tests to assert no setup-code label, input, or log instruction exists.**
- [ ] **Step 2: Run the UI test and verify the stale setup-code assertions fail.**
- [ ] **Step 3: Remove setup-code state, field, copy, validation, and request payload from `SetupCard`.**
- [ ] **Step 4: Update `ControlPlaneSetupRequest` and API serialization.**
- [ ] **Step 5: Run `bun test apps/web/src/routes/OnboardingPage.test.tsx`.**
- [ ] **Step 6: Commit UI and contract changes.**

### Task 3: Verify deployment behavior and publish

**Files:**
- Modify: `apps/control-plane/src/control-plane-setup.test.ts`
- Modify: `tests/control-plane-deployment-contract.test.ts`
- Modify: `deploy/control-plane/README.md` if setup instructions mention the code

**Interfaces:**
- Deployment documentation describes opening `/onboarding`, entering the public origin, and creating the GitHub App without a setup code.

- [ ] **Step 1: Replace setup-code lifecycle tests with origin-only setup tests.**
- [ ] **Step 2: Update deployment contract assertions for the code-free onboarding flow.**
- [ ] **Step 3: Update the deployment README first-boot instructions.**
- [ ] **Step 4: Run `bun run --cwd packages/db db:check`.**
- [ ] **Step 5: Run focused tests, `bun run typecheck`, and `bun run build`.**
- [ ] **Step 6: Commit and push the completed change to `main`.**
