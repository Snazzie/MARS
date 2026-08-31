# Linux Control-Plane Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a Linux/amd64 Unraid control-plane image that ships no worker assets and consumes only a compatible GitHub worker release.

**Architecture:** The production control plane fetches `worker-release-manifest.json` from a configurable HTTPS URL, defaults to GitHub `releases/latest`, validates schema and semantic compatibility, and caches the result. Compatibility requires `major.minor.patch` syntax, the same major version, and a worker minor less than or equal to the control-plane minor; any non-negative worker patch is accepted. The Docker image contains only control-plane runtime files. Worker release publication remains separate.

**Tech Stack:** Bun, TypeScript, Zod, Docker Buildx, GitHub Actions, Unraid XML templates, Bun tests.

## Global Constraints

- No worker installers, binaries, VM images, broker files, domain templates, or worker manifest in the control-plane image.
- Manifest source defaults to `https://github.com/Snazzie/Mars/releases/latest/download/worker-release-manifest.json`.
- Contract versions use `major.minor.patch` syntax.
- Accept only same-major worker releases with worker minor <= control-plane minor; accept any non-negative worker patch.
- Reject malformed versions, higher worker minor versions, and different major versions.
- Require a non-null `linux-x64` manifest platform for Linux worker enrollment.
- Worker artifact URLs must remain HTTPS/OCI digest-pinned values from the release manifest.
- Preserve PostgreSQL-only control-plane deployment and existing Unraid operator inputs.

---

### Task 1: Add manifest fetch and compatibility primitives

**Files:**
- Modify: `apps/control-plane/src/worker-release.ts`
- Test: `apps/control-plane/src/worker-release.test.ts`
- Modify: `apps/control-plane/src/index.ts`

**Interfaces:**
- Produce `parseContractVersion(value: string): { major: number; minor: number; patch: number }`.
- Produce `isWorkerContractCompatible(controlPlaneVersion: string, workerVersion: string): boolean`.
- Produce `loadWorkerReleaseManifest(source?: string | URL, development?: DevelopmentWorkerRelease): Promise<WorkerReleaseManifest>` with production default remote URL.

- [ ] Add failing tests for exact accepted/rejected version boundaries: `0.1.0` accepts worker `0.1.0`, `0.1.99`, and `0.0.7`; rejects `0.2.0`, `1.0.0`, and malformed values.
- [ ] Add failing fetch tests using an injectable fetch implementation or local test server for HTTP failure, invalid JSON, schema failure, and valid manifest.
- [ ] Implement strict `major.minor.patch` parsing and compatibility checks.
- [ ] Implement HTTPS-only remote JSON retrieval with clear errors and process-lifetime caching.
- [ ] Add `MARS_WORKER_RELEASE_MANIFEST_URL` and `MARS_WORKER_CONTRACT_VERSION` production configuration, defaulting to the specified GitHub URL and `0.1.0`.
- [ ] Validate compatibility and require `linux-x64` before wiring production dependencies.
- [ ] Run `bun test apps/control-plane/src/worker-release.test.ts`.
- [ ] Commit as `feat: load compatible worker releases remotely`.

### Task 2: Remove worker payload from production image

**Files:**
- Modify: `deploy/control-plane/Dockerfile`
- Modify: `apps/control-plane/src/index.ts`
- Modify: `tests/control-plane-image-smoke.sh`
- Modify: `tests/control-plane-deployment-contract.test.ts`

**Interfaces:**
- Production startup artifact checks cover only control-plane files: API entrypoint, web files, migrations.
- Worker enrollment uses the remote manifest and does not resolve local worker filesystem paths.

- [ ] Add failing packaging assertions that the Dockerfile does not copy `workers`, worker binaries, or Windows/macOS artifacts.
- [ ] Remove worker build arguments, worker compilation outputs, worker `COPY` instructions, and worker runtime environment variables from the Dockerfile.
- [ ] Keep Linux/amd64 control-plane build and `EXPOSE 3000` unchanged.
- [ ] Remove production checks for local installers, orchestrators, service host, and Windows container assets.
- [ ] Update the smoke test to assert API/web/migration files and assert worker payload paths are absent.
- [ ] Run `bun test tests/control-plane-deployment-contract.test.ts`.
- [ ] Commit as `refactor: keep worker assets outside control plane image`.

### Task 3: Publish the Linux control-plane image

**Files:**
- Modify: `.github/workflows/release-control-plane.yml`
- Modify: `deploy/control-plane/README.md`
- Modify: `deploy/unraid/mars-control-plane.xml`

**Interfaces:**
- Workflow publishes `ghcr.io/snazzie/mars/control-plane` as Linux/amd64 and promotes only a smoke-tested immutable digest to `latest`.
- Template exposes database/origin settings plus optional manifest URL and supported contract version.

- [ ] Add workflow steps that build without `MARS_WINDOWS_SERVICE_HOST_ARTIFACT` or packaged worker manifest arguments.
- [ ] Configure Buildx platform `linux/amd64`, push an immutable SHA/run tag, verify digest, and run the existing smoke test.
- [ ] Promote the verified digest to `ghcr.io/snazzie/mars/control-plane:latest`.
- [ ] Document remote worker release lookup and compatibility behavior.
- [ ] Add XML fields for `MARS_WORKER_RELEASE_MANIFEST_URL` and `MARS_WORKER_CONTRACT_VERSION` with safe defaults.
- [ ] Run XML/workflow contract tests.
- [ ] Commit as `ci: publish Linux control plane image`.

### Task 4: Verify release compatibility and deployment contracts

**Files:**
- Modify: `tests/control-plane-deployment-contract.test.ts`
- Modify: `apps/control-plane/src/http/app.test.ts` if route behavior requires coverage
- Modify: `deploy/control-plane/README.md`

**Interfaces:**
- Tests prove worker installer responses use URLs supplied by a compatible remote manifest and refuse incompatible manifests.

- [ ] Add a test for a compatible lower worker minor and arbitrary patch.
- [ ] Add tests for higher minor and different major rejection.
- [ ] Add a test proving no local worker asset fallback occurs in production.
- [ ] Add documentation for release publication order: worker release first, then control-plane image deployment.
- [ ] Run targeted control-plane and deployment tests.
- [ ] Commit as `test: enforce worker release compatibility`.

### Task 5: Build and smoke-test the image

**Files:**
- No source changes unless verification exposes a defect.

- [ ] Run `bun test apps/control-plane/src/worker-release.test.ts tests/control-plane-deployment-contract.test.ts`.
- [ ] Build locally with `docker buildx build --platform linux/amd64 --load -f deploy/control-plane/Dockerfile -t mars-control-plane:linux .`.
- [ ] Run the image with test PostgreSQL/origin environment and verify `/api/livez` and `/api/readyz`.
- [ ] Run `bash tests/control-plane-image-smoke.sh` against the built image.
- [ ] Record the resulting image digest and any unavailable external-release prerequisite.
