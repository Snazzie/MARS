# Windows Worker-Local Image Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows container workers build, verify, cache, and reuse their own Playwright-capable job image during install/reinstall.

**Architecture:** The control plane injects signed-by-configuration build metadata into `install-worker.ps1`. The Windows installer downloads hash-pinned inputs over HTTPS, builds `mars/windows-job:local` with the existing Containerfile, verifies the runtime in a Hyper-V probe, and atomically writes a provenance manifest before service registration. The orchestrator continues launching Hyper-V-isolated containers from the local tag.

**Tech Stack:** PowerShell, Docker Windows engine, Hyper-V isolation, Bun/TypeScript, Hono worker routes, Bun tests.

## Global Constraints

- Build only during worker install/reinstall; service restart reuses the cached image.
- Base image MUST match `mcr.microsoft.com/windows/server:ltsc2025@sha256:<64 lowercase hex>`.
- External payloads MUST use HTTPS URLs and exact SHA-256 verification.
- Runtime verification MUST require `mf.dll`, `mfplat.dll`, `msmpeg2vdec.dll`, `evr.dll`, `avrt.dll`, DNS, and TCP/443.
- Failed rebuild MUST preserve the existing service and prior cached image.
- Job containers MUST remain Hyper-V isolated; no `--no-sandbox` or network-policy changes.
- Local image provenance MUST be persisted in `C:\ProgramData\Mars\windows-job-image.json`.

---

### Task 1: Define build metadata and manifest contracts

**Files:**
- Modify: `deploy/workers/install-worker.ps1:1-14`
- Modify: `tests/installer-arguments.test.ts`
- Create: `tests/windows-worker-image-manifest.test.ts`

**Interfaces:**
- Add installer parameters/placeholders for `WindowsContainerBaseImage`, runner/Git/VC URLs and SHA-256 values, and `WindowsContainerImage` defaulting to `mars/windows-job:local`.
- Define manifest JSON fields: `schemaVersion`, `baseImage`, `runnerSha256`, `gitSha256`, `vcRuntimeSha256`, `jobAgentSha256`, `image`, `imageId`, `runtimeProbe`, `builtAt`.
- Add pure test helpers for exact base validation and manifest validation if they are extracted from PowerShell as text-contracts only; do not introduce a runtime TypeScript implementation that duplicates PowerShell behavior.

- [ ] **Step 1: Write failing contract tests**

Assert the installer contains the new placeholders, HTTPS URL validation, local image tag, manifest path, atomic manifest filename, and all five dependency names through the referenced verifier. Assert manifest validation rejects missing schema, mismatched image ID, or false runtime booleans.

- [ ] **Step 2: Run focused tests and verify expected failure**

Run:
```powershell
bun test tests/installer-arguments.test.ts tests/windows-worker-image-manifest.test.ts
```
Expected: failures identify missing build metadata and manifest contracts.

- [ ] **Step 3: Add minimal validation declarations and test fixtures**

Add exact installer parameter defaults/placeholders and manifest contract fixtures. Keep validation in PowerShell where the worker executes it; tests must remain observable source contracts.

- [ ] **Step 4: Run tests green**

Run the same command; expected all tests pass.

- [ ] **Step 5: Commit**

```powershell
git add deploy/workers/install-worker.ps1 tests/installer-arguments.test.ts tests/windows-worker-image-manifest.test.ts
git commit -m "test(windows): define local image manifest contract"
```

### Task 2: Add local image build and provenance implementation

**Files:**
- Create: `deploy/workers/build-windows-container-image-local.ps1`
- Modify: `deploy/workers/install-worker.ps1:40-70`
- Modify: `tests/windows-container-image-contract.test.ts`
- Modify: `tests/installer-arguments.test.ts`

**Interfaces:**
- `build-windows-container-image-local.ps1` parameters: `BaseImage`, `RunnerUrl`, `RunnerSha256`, `GitUrl`, `GitSha256`, `VcRuntimeUrl`, `VcRuntimeSha256`, `JobAgent`, `Image`, `ManifestPath`, `VerifierPath`.
- Script output: one compact manifest JSON object on success; nonzero exit on failure.
- Script MUST build locally and MUST NOT call `docker push`.

- [ ] **Step 1: Write failing image-build contracts**

Assert local build script stages `Containerfile`, `entrypoint.ps1`, and `verify-runtime.ps1`, validates the full Server digest, downloads HTTPS inputs, verifies hashes, calls `docker build`, never calls `docker push`, runs the Hyper-V verifier, inspects image ID, and writes a temporary manifest before atomic rename.

- [ ] **Step 2: Run contracts red**

Run:
```powershell
bun test tests/windows-container-image-contract.test.ts tests/installer-arguments.test.ts
```
Expected: local build script and installer integration assertions fail.

- [ ] **Step 3: Implement the local builder**

Use a unique staging directory under `C:\ProgramData\Mars\image-build-<guid>`. Download with `Invoke-WebRequest -UseBasicParsing`, reject non-HTTPS URLs, verify `Get-FileHash`, copy the job agent and verifier, run `docker pull` against the exact base digest, run `docker build --build-arg BASE_IMAGE=... --tag mars/windows-job:local`, and remove staging in `finally`.

Run a separate probe container with `--entrypoint powershell.exe --isolation=hyperv`, `verify-runtime.ps1 -RequireNetwork`, exact integer exit-code checking, bounded `docker logs`, and unconditional `docker rm -f`. Inspect the local image ID. Write `windows-job-image.json.tmp`, flush content, then `Move-Item -Force` to the manifest path.

- [ ] **Step 4: Integrate installer sequencing**

Call the local builder from `Ensure-WindowsContainerRuntime` before service replacement. Build failure must throw before existing service stop/removal. Set the service environment to local image plus local-image enablement. Do not remove the prior image until the new manifest and probe succeed.

- [ ] **Step 5: Run contracts and PowerShell parser**

Run focused contracts and parse:
```powershell
$files=@('deploy/workers/build-windows-container-image-local.ps1','deploy/workers/install-worker.ps1')
foreach($file in $files){$errors=$null;$tokens=$null;[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors;exit 1}}
```

- [ ] **Step 6: Commit**

```powershell
git add deploy/workers/build-windows-container-image-local.ps1 deploy/workers/install-worker.ps1 tests/windows-container-image-contract.test.ts tests/installer-arguments.test.ts
git commit -m "feat(windows): build job image locally"
```

### Task 3: Inject build configuration from the control plane

**Files:**
- Modify: `apps/control-plane/src/http/types.ts:20-45`
- Modify: `apps/control-plane/src/index.ts:35-47,121`
- Modify: `apps/control-plane/src/http/worker-routes.ts:63-76`
- Modify: `deploy/control-plane/compose.yaml:18-22`
- Modify: `tests/worker-installer-route.test.ts` or the existing worker route test file

**Interfaces:**
- Add `windowsContainerBuild` dependencies with base image, HTTPS payload URLs, and SHA-256 values.
- Add environment variables: `MARS_WINDOWS_CONTAINER_BASE_IMAGE`, `MARS_WINDOWS_CONTAINER_RUNNER_URL`, `MARS_WINDOWS_CONTAINER_RUNNER_SHA256`, `MARS_WINDOWS_CONTAINER_GIT_URL`, `MARS_WINDOWS_CONTAINER_GIT_SHA256`, `MARS_WINDOWS_CONTAINER_VC_URL`, `MARS_WINDOWS_CONTAINER_VC_SHA256`.
- Installer route injects those values for Windows container runtime and no longer rejects an empty remote image when local-build configuration is present.

- [ ] **Step 1: Write failing route tests**

Request `/api/workers/installer?audience=windows-x64&runtime=container` and assert the generated PowerShell contains the build metadata, local image tag, and no requirement for a remote image digest. Assert missing build metadata returns `503 artifact_unavailable` with a precise `windows-container-build-inputs` artifact.

- [ ] **Step 2: Run route tests red**

Run the focused worker route test; expected failures identify missing dependency wiring and response behavior.

- [ ] **Step 3: Implement environment/dependency wiring**

Read and validate all seven values at control-plane startup in production. Pass them through `ControlPlaneHttpDeps`. Extend Compose variable declarations without embedding secrets or mutable tags.

- [ ] **Step 4: Implement installer injection**

Inject build metadata only for Windows container installers. Keep VM installer behavior unchanged. Use existing PowerShell quoting and no-store response headers.

- [ ] **Step 5: Run route tests and typechecks**

```powershell
bun test apps/control-plane/src/http/app.test.ts
bun run --filter '@mars/control-plane' typecheck
```

- [ ] **Step 6: Commit**

```powershell
git add apps/control-plane/src/http/types.ts apps/control-plane/src/index.ts apps/control-plane/src/http/worker-routes.ts deploy/control-plane/compose.yaml apps/control-plane/src/http/app.test.ts
git commit -m "feat(windows): inject local image build inputs"
```

### Task 4: Enforce cached manifest at worker runtime

**Files:**
- Modify: `apps/orchestrator/src/windows-container.ts:10-43`
- Modify: `apps/orchestrator/src/windows-agent.ts` doctor path
- Create or modify: `apps/orchestrator/src/windows-container.test.ts`

**Interfaces:**
- `WindowsContainerConfig` gains `imageManifestPath?: string` and `requireLocalImageManifest?: boolean`.
- `reserveCapacity` validates the manifest image tag, image ID, runtime booleans, and Docker image ID before accepting capacity.

- [ ] **Step 1: Write failing runtime tests**

Cover missing manifest, false `tcp443`, mismatched image ID, and valid manifest acceptance. Use the existing injected `DockerRunner` and no Docker mocks beyond the established runner abstraction.

- [ ] **Step 2: Run tests red**

Run the Windows container test file; expected failures identify absent manifest validation.

- [ ] **Step 3: Implement validation**

Read and parse the manifest, require schema version and local image, inspect Docker image ID, compare exact IDs, and require all runtime booleans true. Surface a bounded actionable error through `windowsDoctor` and reject lease capacity.

- [ ] **Step 4: Run tests green**

```powershell
bun test apps/orchestrator/src/windows-container.test.ts
bun run --filter '@mars/orchestrator' typecheck
```

- [ ] **Step 5: Commit**

```powershell
git add apps/orchestrator/src/windows-container.ts apps/orchestrator/src/windows-agent.ts apps/orchestrator/src/windows-container.test.ts
git commit -m "fix(windows): require verified local image manifest"
```

### Task 5: End-to-end worker rollout verification

**Files:**
- Modify: `tests/installer-arguments.test.ts` only if final contract gaps remain
- Modify: `docs/superpowers/specs/2026-08-17-windows-worker-local-image-design.md` with observed evidence only

- [ ] **Step 1: Run complete focused verification**

```powershell
bun test tests/windows-container-image-contract.test.ts tests/windows-container-proof-contract.test.ts tests/installer-arguments.test.ts apps/orchestrator/src/windows-container.test.ts apps/control-plane/src/http/app.test.ts
```

- [ ] **Step 2: Run all changed PowerShell parser checks**

Parse the local builder, verifier, installer, and proof scripts with `Parser.ParseFile`; require zero parser errors.

- [ ] **Step 3: Build the job-agent artifact**

```powershell
bun run --filter '@mars/job-agent' build
```

- [ ] **Step 4: Configure control plane and reinstall one drained worker**

Set all seven `MARS_WINDOWS_CONTAINER_*` values to immutable URLs/hashes, deploy the control plane, request a Windows container installer, and run it on one drained worker. Require the manifest and local image ID to match.

- [ ] **Step 5: Exercise actual browser behavior**

Run `node tests/windows-playwright-smoke.mjs` on the reinstalled worker through `.github/workflows/windows-smoke.yml`. Require page creation and local navigation success.

- [ ] **Step 6: Reinstall remaining workers and rerun RaceIQ**

Reinstall/restart the remaining drained workers, verify each manifest, enable the pool, and rerun RaceIQ job `95364529408` unchanged.

- [ ] **Step 7: Commit observed evidence and push**

```powershell
git add docs/superpowers/specs/2026-08-17-windows-worker-local-image-design.md
git commit -m "docs(windows): record local image rollout evidence"
git push origin main
```
