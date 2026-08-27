# Windows Native Service Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Windows orchestrator under a real Windows SCM service host.

**Architecture:** A small Rust/Win32 executable registers with SCM, starts the Bun-compiled orchestrator in a kill-on-close Job Object, redirects logs, and reports service state. The control plane serves both artifacts; the installer downloads and registers the host.

**Tech Stack:** Rust 1.97, `windows-sys`, Bun, PowerShell, Windows SCM.

## Global Constraints

- Local development artifacts may be unsigned; production signing remains required.
- The service runs as LocalSystem and inherits machine-scoped worker configuration.
- Stop and shutdown terminate the complete child process tree.
- Unexpected child exit returns failure so SCM recovery restarts the service.
- Installer failures expose SCM events and worker logs.

---

### Task 1: Native SCM host

**Files:**
- Create: `apps/windows-service-host/Cargo.toml`
- Create: `apps/windows-service-host/src/main.rs`

**Interfaces:**
- Consumes: command line `<orchestrator.exe> windows-worker`
- Produces: `dist/mars-service-host.exe`

- [ ] Write unit tests for Windows command-line quoting and exit-code mapping.
- [ ] Run `cargo test --manifest-path apps/windows-service-host/Cargo.toml` and observe failure before implementation.
- [ ] Implement SCM registration, state reporting, child creation, Job Object containment, logging, stop/shutdown handling, and console smoke mode.
- [ ] Run crate tests and build the release executable.
- [ ] Commit the native host.

### Task 2: Artifact route and installer

**Files:**
- Modify: `apps/control-plane/src/http/types.ts`
- Modify: `apps/control-plane/src/http/worker-routes.ts`
- Modify: `apps/control-plane/src/index.ts`
- Modify: `deploy/workers/install-worker.ps1`
- Modify: `apps/control-plane/src/http/app.test.ts`
- Modify: `tests/installer-arguments.test.ts`

**Interfaces:**
- Consumes: `workerServiceHostExecutable?: URL`
- Produces: `GET /api/workers/service-host?audience=windows-x64`

- [ ] Add failing route and installer assertions for the host artifact and registered command line.
- [ ] Run focused tests and observe failures.
- [ ] Wire the host artifact through control-plane dependencies and endpoint.
- [ ] Download the host beside the orchestrator, register it with `New-Service`, wait for Running, and surface startup diagnostics.
- [ ] Run focused tests and PowerShell parsing.
- [ ] Commit distribution changes.

### Task 3: Remove fake service mode

**Files:**
- Modify: `apps/orchestrator/src/index.ts`
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Delete: `apps/orchestrator/src/windows-service.ts`
- Modify: `tests/installer-arguments.test.ts`

**Interfaces:**
- Consumes: native host launches `mars-orchestrator.exe windows-worker`
- Produces: one ordinary Windows worker entrypoint

- [ ] Add a failing assertion that `--service` and `runWindowsWorkerService` are absent.
- [ ] Remove the JavaScript lifecycle shim and service branch.
- [ ] Run orchestrator typecheck and focused tests.
- [ ] Commit the clean cutover.

### Task 4: End-to-end verification and publication

**Files:**
- Modify if required by verification only: files above

- [ ] Build orchestrator Windows executable and native host.
- [ ] Exercise native host console smoke mode with a short-lived child and verify exit propagation.
- [ ] Run control-plane, orchestrator, installer, and native-host focused checks.
- [ ] Restart the development control plane and verify both Windows artifacts return HTTP 200.
- [ ] Push all commits to `main`.
