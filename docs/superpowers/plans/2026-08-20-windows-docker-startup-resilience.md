# Windows Docker Startup Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Windows worker alive through Docker daemon startup races and order the worker service after Docker.

**Architecture:** `WindowsContainerDriver.reserveCapacity` retries only the Docker engine readiness probe with capped exponential backoff. Image, manifest, engine-mode, and resource errors remain fail-fast. The installer adds a Windows Service dependency on `docker` while preserving existing SCM recovery actions.

**Tech Stack:** TypeScript/Bun, Bun test, PowerShell installer, Windows Service Control Manager.

## Global Constraints

- Retry Docker readiness indefinitely with delays capped at 30 seconds.
- Do not retry permanent image or manifest validation failures.
- Preserve Windows-engine validation (`OSType=windows`).
- Keep changes limited to worker runtime, focused tests, and installer service configuration.

---

### Task 1: Docker Readiness Retry

**Files:**
- Modify: `apps/orchestrator/src/windows-container.ts`
- Test: `apps/orchestrator/src/windows-container.test.ts`

**Interfaces:**
- `WindowsContainerDriver.reserveCapacity(resources)` remains unchanged.
- Add an internal readiness helper that invokes the injected `DockerRunner`.

- [ ] Add a test where `docker info` fails twice with the daemon named-pipe error, then returns `windows`; assert `reserveCapacity` resolves and `info` was called three times.
- [ ] Run `bun test apps/orchestrator/src/windows-container.test.ts`; confirm the new test fails before implementation.
- [ ] Implement capped exponential retry around only `docker info` readiness.
- [ ] Keep subsequent image/manifest validation outside the retry loop.
- [ ] Run the focused test file and confirm it passes.

### Task 2: Docker Service Dependency

**Files:**
- Modify: `deploy/workers/install-worker.ps1`

**Interfaces:**
- Existing `WhitesmithWorker` installation remains unchanged except for SCM dependency configuration.

- [ ] Configure `WhitesmithWorker` to depend on the Windows `docker` service after creation.
- [ ] Preserve existing failure recovery actions and startup verification.
- [ ] Run the installer contract tests covering service installation text and confirm they pass.

### Task 3: Verification

**Files:**
- No additional files.

- [ ] Run focused orchestrator tests.
- [ ] Run installer contract tests.
- [ ] Run typecheck for affected workspace packages.
- [ ] Verify the running worker heartbeat and queued job pickup against the live local stack.
