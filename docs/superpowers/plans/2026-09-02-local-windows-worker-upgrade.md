# Local Windows Worker Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local Windows worker installer generate a minimal upgrade script that replaces only the installed worker binaries without requiring the full container artifact bundle.

**Architecture:** Add an explicit `upgrade=true` installer query mode in the control-plane Windows installer route. In that mode, validate and package only the installer script, orchestrator, and service-host artifacts. Extend the PowerShell installer so `-Upgrade` skips fresh-install container prerequisites and atomically replaces the installed worker binaries while preserving identity and runtime state.

**Tech Stack:** Bun, TypeScript, Hono, PowerShell, Windows Services, existing development artifact resolver.

## Global Constraints

- Fresh Windows installation behavior remains unchanged and still requires the complete container artifact bundle.
- Upgrade mode is explicitly requested with `upgrade=true`.
- Upgrade replaces only `mars-orchestrator.exe` and `mars-service-host.exe`.
- Upgrade preserves `C:\ProgramData\Mars\worker-identity.json`, join credentials, Docker images, and container artifacts.
- Upgrade stops and restarts `MarsWorker` and fails closed if either replacement cannot be completed.
- Local development artifacts remain local filesystem paths; no GitHub release URLs are required.
- Upgrade operations do not alter control-plane or worker cache data.

---

### Task 1: Add upgrade-aware control-plane installer generation

**Files:**
- Modify: `apps/control-plane/src/http/worker-routes.ts`
- Test: `apps/control-plane/src/http/app.test.ts`
- Test: `apps/control-plane/src/http/worker-routes.test.ts` if present

**Interfaces:**
- Consume `upgrade=true` from `/api/workers/installer` query parameters.
- Continue using `DevelopmentWindowsArtifacts` and `windowsInstallerValues` for generated installer values.

- [ ] Add a failing test requesting `/api/workers/installer?audience=windows-x64&runtime=container&upgrade=true&connectOrigin=http://localhost:3000` with only local orchestrator/service-host/installer artifacts and assert HTTP 200.
- [ ] Add a failing test proving the same development setup without `upgrade=true` still returns HTTP 503 with `development:container`.
- [ ] Implement upgrade-mode prerequisite selection requiring only `installer`, `orchestrator`, and `serviceHost`; retain the current full prerequisite list for fresh installs.
- [ ] Generate upgrade values containing local orchestrator/service-host URLs and hashes, `MARS_ARTIFACT_MODE=local`, `Upgrade`-compatible parameters, and no container artifact requirement.
- [ ] Preserve authenticated origin injection, artifact size limits, path safety, and the existing production release path.
- [ ] Run `bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/http/worker-routes.test.ts` and verify all pass.
- [ ] Commit with `feat(control-plane): support local Windows worker upgrades`.

### Task 2: Make the PowerShell installer perform minimal upgrades

**Files:**
- Modify: `deploy/workers/install-worker.ps1`
- Test: `tests/install-worker-contract.test.ts` or the existing Windows installer contract test file

**Interfaces:**
- Consume generated `-Upgrade`, `-WindowsOrchestratorUrl`, `-WindowsOrchestratorSha256`, `-WindowsServiceHostUrl`, and `-WindowsServiceHostSha256` arguments.
- Preserve existing fresh-install parameters and behavior.

- [ ] Add failing contract assertions that the `-Upgrade` branch skips container artifact download/image-build steps and replaces both installed binaries.
- [ ] Implement an early upgrade branch after administrator/configuration validation that downloads only orchestrator and service-host artifacts, verifies SHA-256 values, stops `MarsWorker`, stages replacement files, moves them into `C:\Program Files\Mars`, restarts the service, and exits successfully.
- [ ] Keep worker identity, join-code, Docker, image, and lease directories untouched during upgrade.
- [ ] Ensure failed copy/start operations return nonzero and do not claim success.
- [ ] Run the installer contract test and a PowerShell parse check.
- [ ] Commit with `feat(windows): add minimal local worker upgrade`.

### Task 3: Verify local upgrade end to end

**Files:**
- Modify: `.env` only if required for local development mode; do not commit secrets or machine-specific values.

- [ ] Run `bun run build:windows-worker`.
- [ ] Start/restart local `bun dev` and request the installer with `upgrade=true`; verify HTTP 200 and that the generated script contains only the two worker binary download routes.
- [ ] Execute the generated script with `-Upgrade -WindowsRuntime container -AllowInsecureHttp` on the local Windows host.
- [ ] Verify `MarsWorker` is running and installed binary hashes match the freshly built artifacts.
- [ ] Verify the worker log no longer reports Zod unrecognized-key errors or one-second reconnects.
- [ ] Run `bun test apps/control-plane/src/http/app.test.ts apps/control-plane/src/http/worker-routes.test.ts tests/install-worker-contract.test.ts`.
- [ ] Run `bun test` and the relevant typechecks.
- [ ] Verify `git status --short` is clean and push completed commits to `main`.
