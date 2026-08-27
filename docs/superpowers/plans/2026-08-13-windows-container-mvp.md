# Windows Container MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Windows worker MVP runtime with Docker Windows containers that require Hyper-V isolation and clean up every lease.

**Architecture:** Add a `WindowsContainerDriver` implementing the existing `RuntimeDriver` interface. It invokes Docker through an injectable process runner, validates an immutable `@sha256:` image and Windows-container/Hyper-V preflight, creates one labeled disposable container per lease, and removes it on every terminal path. Update Windows worker wiring and the PowerShell installer to configure the container image instead of VHDX templates while preserving enrollment and worker protocol behavior.

**Tech Stack:** Bun, TypeScript, Zod contracts, Docker CLI, PowerShell, Bun tests.

## Global Constraints

- Docker commands MUST use `--isolation=hyperv`.
- Process-isolated fallback is forbidden.
- Images MUST use a full immutable `@sha256:` digest.
- No Docker socket, arbitrary host path, or reusable credential may enter a job container.
- Containers MUST carry a Mars lease label and be removed after terminal lease handling.
- Linux guests are unsupported by the Windows-container MVP.
- Existing Hyper-V VHDX driver remains available but is not selected by the Windows MVP.
- Skip formatters, linters, and project-wide test suites during task implementation; run verification once at the end.

---

### Task 1: Add Docker Windows-container runtime driver

**Files:**
- Create: `apps/orchestrator/src/windows-container.ts`
- Create: `apps/orchestrator/src/windows-container.test.ts`
- Modify: `apps/orchestrator/src/runtime.ts` only if the existing `Lease` fields require the guest platform/image contract

**Interfaces:**
- Consumes: `Lease`, `RuntimeDriver`, `RuntimeLease`, `PoolResources` from `runtime.ts` and contracts.
- Produces: `WindowsContainerDriver`, `WindowsContainerConfig`, and `DockerRunner` injectable interfaces.

- [ ] Write tests covering exact Docker argv, `--isolation=hyperv`, digest validation, resource/label propagation, rejection of mutable images, no secret in argv, idempotent create, stop/remove cleanup, and orphan label filtering.
- [ ] Run the focused test and confirm the new tests fail for missing driver.
- [ ] Implement Docker process invocation with stdout/stderr capture and nonzero exit errors.
- [ ] Validate image format `^[^@\s]+@sha256:[0-9a-f]{64}$`; reject all tags and process isolation.
- [ ] Implement `reserveCapacity` using Docker info and a Windows-container/Hyper-V isolation probe; fail if Docker is unavailable or in Linux mode.
- [ ] Implement lease creation using a unique container name, Mars lease labels, pinned image, `--isolation=hyperv`, CPU/memory/storage limits, and a temporary bootstrap file that is passed only through the minimal required container path.
- [ ] Keep bootstrap payload out of Docker argv and logs; remove temporary host material in `finally` paths.
- [ ] Implement inspect, stop, remove, diagnostics, and label-based orphan reconciliation.
- [ ] Run the focused driver tests and confirm they pass.

### Task 2: Wire Windows worker to the container driver

**Files:**
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Modify: `apps/orchestrator/src/index.ts` only if command wiring requires it
- Modify: `apps/orchestrator/src/windows-container.test.ts` for worker configuration coverage

**Interfaces:**
- Consumes: `WindowsContainerDriver` from Task 1.
- Produces: Windows worker startup using `MARS_WINDOWS_CONTAINER_IMAGE` and container runtime settings.

- [ ] Add worker startup tests asserting Windows worker construction uses the container driver and does not require VHDX variables.
- [ ] Replace `HyperVDriver` construction in `runWindowsWorker` with `WindowsContainerDriver` configured from the immutable container image and resource limits.
- [ ] Preserve worker enrollment, WebSocket authentication, encrypted lease handling, events, and service lifecycle.
- [ ] Reject Linux guest leases at the Windows worker boundary with an explicit unsupported-platform error.
- [ ] Run focused worker tests and confirm they pass.

### Task 3: Replace Windows installer preflight and configuration

**Files:**
- Modify: `deploy/workers/install-worker.ps1`
- Modify: `tests/installer-arguments.test.ts`

**Interfaces:**
- Consumes: control-plane generated installer placeholders and `WindowsContainerDriver` environment names.
- Produces: a LocalSystem Windows worker configured for Docker Windows containers with mandatory Hyper-V isolation.

- [ ] Add tests asserting the installer checks Containers, Hyper-V, Docker CLI/daemon, Windows engine mode, immutable image digest, and an actual `docker run --rm --isolation=hyperv` probe.
- [ ] Replace VHDX parameters with `WindowsContainerImage`; retain `-Code` alias and local insecure-development exception.
- [ ] Add noninteractive Docker checks and fail clearly for Linux container mode, missing Docker, missing Containers/Hyper-V features, probe failure, or digest mismatch.
- [ ] Configure `MARS_WINDOWS_CONTAINER_IMAGE` and remove VHDX environment output from the Windows path.
- [ ] Preserve protected identity/join-code directories, LocalSystem service registration, firewall setup, and service restart behavior.
- [ ] Parse the PowerShell script and run focused installer tests.

### Task 4: Add image preparation and distribution contract

**Files:**
- Create: `deploy/workers/prepare-windows-container-image.ps1`
- Modify: `apps/control-plane/src/http/worker-routes.ts` or installer generation source if the generated script lacks the new placeholder
- Modify: `tests/installer-arguments.test.ts`

**Interfaces:**
- Consumes: an operator-provided Windows Server Core image reference and `mars-job-agent.exe`.
- Produces: a digest-pinned Windows container image containing the Actions Runner, job agent, startup command, and manifest.

- [ ] Add tests for immutable source/target validation and manifest output.
- [ ] Implement preparation with Dockerfile generation, pinned Windows Server Core source, runner and agent installation, guest-service startup command, image build, digest inspection, and manifest emission.
- [ ] Reject mutable source references and unpinned output; never download or embed a third-party modified OS image.
- [ ] Update generated installer placeholders/configuration to pass the resulting immutable image reference.
- [ ] Run focused preparation and installer-generation tests.

### Task 5: Verify integration and commit

**Files:**
- Modify only files required by failing verification.

- [ ] Run targeted contract, orchestrator, installer, and job-agent tests.
- [ ] Run package typechecks/builds for contracts, control-plane, orchestrator, web, and job-agent.
- [ ] On this Windows host, run available Docker/Hyper-V preflight and document any unavailable end-to-end check with exact command output.
- [ ] Inspect the final diff for VHDX-only Windows configuration accidentally retained in the active path.
- [ ] Commit implementation and push `main`.
