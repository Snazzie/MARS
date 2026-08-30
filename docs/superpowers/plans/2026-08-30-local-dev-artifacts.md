# Local Development Worker Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make non-production Windows worker installers download all required artifacts from the local control plane or configured local files, never GitHub release assets, while preserving SHA-256 validation.

**Architecture:** Keep production release behavior unchanged. In development, generate explicit local artifact URLs/paths and serve configured local files through existing control-plane artifact routes. Remove the possibility of falling back to the GitHub release manifest in development; missing local configuration returns a clear artifact-unavailable error.

**Tech Stack:** Bun, TypeScript, Hono, PowerShell, Bun test.

## Global Constraints

- Development means `NODE_ENV` is not `production`.
- Development must not consult the GitHub `latest` release manifest or release asset URLs.
- SHA-256 validation remains enabled for every downloaded artifact.
- Production immutable release behavior remains unchanged.
- Missing local artifacts fail clearly; no silent GitHub fallback.

---

### Task 1: Add explicit development artifact configuration

**Files:**
- Modify: `apps/control-plane/src/index.ts` environment/config assembly.
- Modify: `apps/control-plane/src/http/types.ts` dependency types.
- Test: `apps/control-plane/src/http/app.test.ts`.

**Interfaces:**
- Produce a development-only Windows artifact configuration containing local orchestrator, service-host, template, runner, Git, and VC paths or URLs plus SHA-256 values.
- Preserve the existing `WindowsWorkerRelease` production manifest interface.

- [ ] **Step 1: Write failing tests** asserting development dependencies expose local artifact values and do not require release metadata.
- [ ] **Step 2: Run `bun test apps/control-plane/src/http/app.test.ts` and verify the new assertions fail for the missing local configuration behavior.
- [ ] **Step 3: Add typed development artifact configuration sourced from environment variables and pass it into HTTP dependencies only when non-production.
- [ ] **Step 4: Run the focused test and verify it passes.
- [ ] **Step 5: Commit the configuration change.

### Task 2: Generate local-only Windows installer values

**Files:**
- Modify: `apps/control-plane/src/http/worker-routes.ts`.
- Test: `apps/control-plane/src/http/app.test.ts`.
- Test: `tests/installer-arguments.test.ts`.

**Interfaces:**
- Development installer generation injects explicit local control-plane artifact URLs and local dependency values.
- Production installer generation continues injecting release-manifest values.

- [ ] **Step 1: Write failing tests for a development installer containing no `github.com/.../latest` fallback and explicit local artifact endpoints.
- [ ] **Step 2: Run the focused tests and verify they fail because the current Windows values omit local artifact sources.
- [ ] **Step 3: Update `windowsInstallerValues` and installer route generation to select development values by environment and inject all required local URLs/hashes.
- [ ] **Step 4: Run the focused tests and verify they pass.
- [ ] **Step 5: Commit the installer-generation change.

### Task 3: Serve configured local Windows dependencies

**Files:**
- Modify: `apps/control-plane/src/http/worker-routes.ts`.
- Test: `apps/control-plane/src/http/app.test.ts`.

**Interfaces:**
- Add local-only artifact endpoints for the Windows template and container dependencies when configured.
- Each endpoint returns the configured file with `X-Content-SHA256`, `no-store`, and a deterministic unavailable response when absent.

- [ ] **Step 1: Write failing tests for local template/runner/Git/VC routes, response hashes, and missing-artifact failures.
- [ ] **Step 2: Run the focused tests and verify they fail because the routes do not exist.
- [ ] **Step 3: Implement the routes using the existing `packagedResponse` and `artifactExists` patterns; reject local mode when a configured file is absent.
- [ ] **Step 4: Run the focused tests and verify they pass.
- [ ] **Step 5: Commit the local artifact routes.

### Task 4: Prevent development PowerShell fallbacks

**Files:**
- Modify: `deploy/workers/install-worker.ps1`.
- Test: `tests/installer-arguments.test.ts`.

**Interfaces:**
- Generated development installers receive explicit values for every artifact URL and hash.
- The live release manifest fallback is unavailable in development and remains available only for production installers.

- [ ] **Step 1: Write failing tests asserting generated development scripts do not contain an active GitHub release fallback path and fail when required local values are absent.
- [ ] **Step 2: Run the focused tests and verify the assertions fail against the current script.
- [ ] **Step 3: Add an explicit local-artifact mode parameter/guard to the PowerShell installer; keep checksum checks unchanged.
- [ ] **Step 4: Run the focused tests and verify they pass.
- [ ] **Step 5: Commit the installer guard.

### Task 5: Verify end-to-end local development flow

**Files:**
- Modify: `.env.example` with documented local artifact variables.
- Test: `apps/control-plane/src/http/app.test.ts`.
- Test: `tests/installer-arguments.test.ts`.

- [ ] **Step 1: Add `.env.example` entries for local Windows artifacts and their SHA-256 values.
- [ ] **Step 2: Run focused installer and route tests.
- [ ] **Step 3: Build the control plane with `bun run --filter @mars/control-plane build`.
- [ ] **Step 4: Run the Windows installer smoke scenario against the local control-plane endpoints and confirm no GitHub artifact request occurs.
- [ ] **Step 5: Commit the final documentation and verification changes.
