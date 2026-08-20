# Control Plane Deployment Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (recommended). Steps use checkbox (`- [ ]`) syntax and are executed task-by-task.

**Goal:** Produce an immutable, smoke-tested control-plane release that operators can deploy on Unraid with Docker Compose, without requiring Cloudflare Tunnel.

**Architecture:** Keep the existing two-service production stack: control plane plus PostgreSQL. Correct the Compose digest and relative-path contracts, add operator-safe configuration and operations documentation, and extend GitHub Actions with Linux image publication and runtime smoke checks. Cloudflare remains an optional external ingress concern.

**Tech Stack:** Bun 1.2.20, Docker Buildx, Docker Compose, GitHub Actions, GHCR, PostgreSQL 17, Markdown, YAML.

## Global Constraints

- The core deployment must not require Cloudflare Tunnel.
- Production images must use immutable `repository@sha256:<digest>` references.
- The production image must run as the existing non-root `bun` user.
- Preserve `/var/lib/whitesmith` and PostgreSQL persistent storage.
- Do not claim worker-runtime production readiness.
- CI must fail on typecheck, test, build, image, or startup-smoke failures.
- Do not put usable credentials in tracked files.
- Skip formatters, linters, and project-wide test suites during individual implementation tasks; run the complete verification gate once at the end.

## File Map

- Modify `deploy/control-plane/compose.yaml`: immutable image syntax, valid relative paths, documented core stack behavior, and proxy-compatible port contract.
- Create `.env.example`: safe configuration template covering required production variables.
- Create `deploy/control-plane/README.md`: Unraid installation, secrets, persistence, upgrades, rollback, backups, health, proxy/WebSocket requirements, and optional external tunnel note.
- Modify `.github/workflows/ci.yml`: deterministic Linux image build validation and artifact checks.
- Create `.github/workflows/release-control-plane.yml`: release-triggered GHCR publication, digest capture, metadata, and SBOM/provenance.
- Create `tests/control-plane-deployment-contract.test.ts`: static deployment contract checks that fail on invalid digest syntax, bad paths, missing required config, or undocumented core artifacts.
- Create `tests/control-plane-image-smoke.sh`: container-level HTTP smoke helper used by CI with PostgreSQL.
- Modify `IMPLEMENTATION-STATUS.md`: add the precise distinction between control-plane hosting readiness and unfinished worker execution readiness.

---

### Task 1: Lock deployment contracts with tests

**Files:**
- Create: `tests/control-plane-deployment-contract.test.ts`
- Test: `deploy/control-plane/compose.yaml`, `.env.example`, `deploy/control-plane/README.md`

**Interfaces:**
- Produces deterministic Bun tests that read the deployment files and assert observable release contracts.
- Later tasks must satisfy these assertions without weakening them.

- [ ] **Step 1: Add tests for immutable image and relative paths**

Assert that the production service uses `@${WHITESMITH_RELEASE_DIGEST}` or an equivalent repository-plus-digest form, rejects `:sha256:` construction, and references `./app_master_key`, `./tunnel_token`, and `./cloudflared-wrapper.sh` relative to the Compose directory.

- [ ] **Step 2: Add tests for required configuration documentation**

Assert that `.env.example` contains every required Compose interpolation variable, excludes real credential values, and that the deployment README documents `PUBLIC_BASE_URL`, `BROWSER_BASE_URL`, `POSTGRES_PASSWORD`, `APP_MASTER_KEY`, GitHub OAuth/webhook values, and Windows image inputs.

- [ ] **Step 3: Add tests for Unraid operational documentation**

Assert that the README covers named volumes, backup/restore, rollback, `/api/livez`, `/api/readyz`, WebSocket forwarding, and explicitly says Cloudflare Tunnel is optional.

- [ ] **Step 4: Run the focused contract test and confirm expected failures**

Run:

```bash
bun test tests/control-plane-deployment-contract.test.ts
```

Expected: failures for files not yet created or corrected.

---

### Task 2: Correct production Compose and configuration template

**Files:**
- Modify: `deploy/control-plane/compose.yaml`
- Create: `.env.example`
- Modify: `tests/control-plane-deployment-contract.test.ts`

**Interfaces:**
- Compose consumes `WHITESMITH_RELEASE_DIGEST` as `sha256:<64 hex>` and renders `ghcr.io/whitesmith/control-plane@sha256:<64 hex>`.
- Compose resolves secret and optional wrapper files from `deploy/control-plane/`.
- `.env.example` supplies safe placeholders only.

- [ ] **Step 1: Change the image reference to digest syntax**

Replace the current tag interpolation with repository-plus-digest syntax. Keep the variable required and document that its value is `sha256:<64 hex>`.

- [ ] **Step 2: Fix Compose-relative paths**

Use `./app_master_key`, `./tunnel_token`, and `./cloudflared-wrapper.sh`. Keep `cloudflared` in the optional `tunnel` profile and do not make it a dependency of the core stack.

- [ ] **Step 3: Define the safe environment template**

Include placeholders for all required variables, including release digest, build ID, public/browser URLs, database password, GitHub credentials, webhook configuration, and Windows container input metadata. Include comments that credentials must be supplied out of band.

- [ ] **Step 4: Render Compose against the template contract**

Use placeholder values in a temporary environment to verify that `docker compose -f deploy/control-plane/compose.yaml config` renders a valid digest reference and paths under the Compose directory.

---

### Task 3: Add Unraid operator documentation

**Files:**
- Create: `deploy/control-plane/README.md`
- Modify: `tests/control-plane-deployment-contract.test.ts`

**Interfaces:**
- Documentation describes the two-service required deployment and treats Cloudflare Tunnel as external and optional.
- Documentation gives exact commands for secret creation, startup, health verification, upgrade, rollback, and PostgreSQL/data-volume backup.

- [ ] **Step 1: Document prerequisites and directory layout**

Specify Linux Docker/Compose support, a deployment directory containing `compose.yaml`, `.env`, `app_master_key`, and optional tunnel files. State that the control plane is a host service and does not execute Windows Hyper-V or Kata jobs inside Unraid.

- [ ] **Step 2: Document secrets and startup**

Give commands to generate a 32-byte base64 master key, create the required secret file with restrictive permissions, populate `.env`, and start only the core services:

```bash
docker compose -f deploy/control-plane/compose.yaml up -d postgres control-plane
```

- [ ] **Step 3: Document health and proxy requirements**

Document `/api/livez`, `/api/readyz`, port 3000, HTTPS termination, and WebSocket upgrade forwarding. Describe both host-level proxying and a shared Docker network for containerized reverse proxies.

- [ ] **Step 4: Document backup, upgrade, and rollback**

Include `pg_dump`, volume backup guidance, immutable digest upgrades, rollback by restoring the previous digest, and the requirement to keep `APP_MASTER_KEY` stable.

- [ ] **Step 5: Document optional external Cloudflare usage**

State that users may run `cloudflared` separately and that no tunnel token is needed by the core control-plane stack.

---

### Task 4: Add Linux release image workflow and runtime smoke gate

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-control-plane.yml`
- Create: `tests/control-plane-image-smoke.sh`

**Interfaces:**
- CI builds the image on a Linux runner and verifies required runtime files.
- Release workflow publishes to `ghcr.io/whitesmith/control-plane`, resolves the pushed digest, and emits release metadata.
- Smoke script exits nonzero unless the control plane reaches live and ready health endpoints with PostgreSQL.

- [ ] **Step 1: Harden CI image validation**

Use Docker Buildx on `ubuntu-latest`, tag the image with the commit SHA, inspect required files, and retain the existing typecheck/test/build gates. Do not publish from pull requests.

- [ ] **Step 2: Implement the startup smoke helper**

The helper must poll `/api/livez` and `/api/readyz` with bounded retries, fail on non-2xx responses after the timeout, and print the final response body for diagnosis. It must not log secrets.

- [ ] **Step 3: Add disposable PostgreSQL-backed image smoke**

In CI, start PostgreSQL with a temporary network, run the image with production-like required variables and a temporary master-key secret, wait for health, execute the smoke helper, and clean up with `if: always()`.

- [ ] **Step 4: Add release-only GHCR publication**

Trigger on a version tag and manual dispatch. Use `docker/login-action`, `docker/metadata-action`, and `docker/build-push-action` with `push: true`, `provenance: true`, and `sbom: true`. Capture the registry digest from metadata or inspect and write a release artifact containing:

```text
image=ghcr.io/whitesmith/control-plane
 digest=sha256:<64 hex>
 build_id=<commit SHA or release tag>
```

- [ ] **Step 5: Add release artifact verification**

Pull the exact published digest on Linux, verify required files, and run the same PostgreSQL-backed smoke path against the immutable reference.

---

### Task 5: Reconcile status and run final verification

**Files:**
- Modify: `IMPLEMENTATION-STATUS.md`
- Modify: affected deployment files only if verification exposes a concrete defect.

**Interfaces:**
- Status clearly separates control-plane hosting readiness from unfinished worker-runtime readiness.

- [ ] **Step 1: Update implementation status**

Add a current evidence section stating which control-plane hosting gates are now covered and preserve the explicit list of unfinished worker execution work.

- [ ] **Step 2: Run focused deployment contracts**

```bash
bun test tests/control-plane-deployment-contract.test.ts
```

- [ ] **Step 3: Run workspace typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Run the complete test suite**

```bash
bun test
```

- [ ] **Step 5: Run the workspace build**

```bash
bun run build
```

- [ ] **Step 6: Render production Compose with placeholder values**

```bash
docker compose -f deploy/control-plane/compose.yaml config
```

Verify the output contains `ghcr.io/whitesmith/control-plane@sha256:...` and no nested `deploy/control-plane/deploy/control-plane` paths.

- [ ] **Step 7: Run Linux image and startup smoke**

Run the CI-equivalent Buildx image build and PostgreSQL-backed health smoke on a Linux Docker builder. If the local daemon is Windows-container mode, use the Linux CI runner rather than treating that environment failure as application evidence.

- [ ] **Step 8: Commit verified implementation**

```bash
git add .env.example deploy/control-plane .github/workflows tests/control-plane-deployment-contract.test.ts tests/control-plane-image-smoke.sh IMPLEMENTATION-STATUS.md
git commit -m "feat: prepare control plane for docker deployment"
```

## Verification checklist

- [ ] Compose uses immutable `@sha256` image syntax.
- [ ] Compose paths resolve relative to `deploy/control-plane/`.
- [ ] `.env.example` has all required variables and no usable credentials.
- [ ] Unraid documentation excludes Cloudflare from the core requirement.
- [ ] CI builds and validates the Linux image.
- [ ] Release workflow publishes GHCR image with digest, SBOM, and provenance.
- [ ] PostgreSQL-backed startup smoke reaches live and ready endpoints.
- [ ] Complete test suite passes.
- [ ] Workspace build passes.
- [ ] Worker-runtime incompleteness remains explicitly documented.
