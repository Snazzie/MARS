# Worker v1 Installer Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish self-contained Linux, Windows, and macOS worker installer scripts as GitHub `worker-v0.1.0` assets while preserving existing runtime capabilities and enrollment.

**Architecture:** The control plane remains the enrollment authority. The copied command downloads a platform installer script from the GitHub release tag, passes the selected control-plane URL and one-use code, and the script performs the complete prerequisite/artifact/service/enrollment flow. Existing Linux KVM/libvirt, Windows VM/container, and macOS Tart runtime paths remain unchanged.

**Tech Stack:** Bun/TypeScript, React, Hono, Bash, PowerShell, zsh, GitHub Actions, GitHub Releases.

## Global Constraints

- Release tag is exactly `worker-v0.1.0`.
- Preserve existing Linux and Windows VM/container capabilities; no runtime conversion.
- Preserve macOS arm64 Tart support.
- Cosign signing is not required for v1; do not claim signed artifacts.
- Retain HTTPS-only downloads and SHA-256 verification where supported.
- Copied commands include the GitHub release asset URL, selected control-plane URL, and one-use enrollment code.
- Installer scripts contain the complete install flow and then join the control plane.
- Do not claim publication until GitHub release assets are observable.

---

### Task 1: GitHub-tagged copied commands

**Files:** `apps/web/src/components/EnrollmentPanel.tsx`, `apps/web/src/components/WorkerActions.tsx`, focused web tests.

- [ ] Assert exact `worker-v0.1.0` asset URLs for Linux/Windows/macOS.
- [ ] Ensure commands pass control-plane URL, enrollment code, and existing Windows runtime selector.
- [ ] Preserve safe shell quoting, temporary cleanup, and existing approved-origin selection.
- [ ] Run focused web tests and commit.

### Task 2: Self-contained installer arguments and assets

**Files:** `deploy/workers/install-worker.sh`, `install-worker.ps1`, `install-worker-macos.sh`, `apps/control-plane/src/http/worker-routes.ts`, installer tests.

- [ ] Make all three scripts accept the copied command’s control-plane URL and code arguments while retaining existing runtime options.
- [ ] Ensure published scripts have all required manifest/runtime values materialized or download those values from GitHub release assets; no unresolved placeholders.
- [ ] Keep complete existing prerequisite, artifact verification, service registration, resume/idempotence, and authenticated enrollment behavior.
- [ ] Run shell/PowerShell/parser and installer tests; commit.

### Task 3: Unsigned release metadata and workflow

**Files:** `packages/contracts/src/worker-release.ts`, `apps/control-plane/src/worker-release.ts`, `deploy/control-plane/release-manifest.json`, `.github/workflows/release-workers.yml`, `deploy/control-plane/Dockerfile`, deployment tests.

- [ ] Remove cosign signing/verification steps and signature-bundle requirements from v1 release flow without deleting existing runtime metadata needed by installers.
- [ ] Keep VM/container platform fields and SHA-256/HTTPS validation.
- [ ] Publish stable installer asset names from the aggregate release job and make the manifest/runtime URLs point to `worker-v0.1.0` assets.
- [ ] Ensure control-plane packaging uses exact hashed artifacts and remains fail-closed for unavailable files.
- [ ] Run deployment/contract tests and commit.

### Task 4: Verify and publish v0.1.0

**Files:** `deploy/control-plane/README.md` only if release instructions require correction; smoke/tests as needed.

- [ ] Run focused command, installer, manifest, deployment, enrollment, and proxied smoke tests.
- [ ] Configure the required GitHub Actions variables/artifact sources and release credentials externally; do not invent them.
- [ ] Push implementation commits to `main`.
- [ ] Trigger the workflow for `worker-v0.1.0`, watch all platform jobs, and verify release asset URLs and SHA-256 metadata.
- [ ] Report the observable release URL and exact pass/fail evidence; do not claim unavailable host execution.
