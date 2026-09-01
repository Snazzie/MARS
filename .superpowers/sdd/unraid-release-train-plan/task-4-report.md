# Task 4 report

Status: implemented in base commit `45eaefb`, with subsequent workflow hardening and verification commit.

## Delivered

- Replaced `release-workers.yml` and `release-control-plane.yml` with the workflow-dispatch-only `Release Mars` workflow in `release-mars.yml`.
- Added strict independent app/worker SemVer inputs, duplicate final release/tag checks, separate version metadata, immutable worker manifest URLs, schema-3 parsing, prerelease publication, anonymous asset/hash gate, and gated immutable broker/control-plane promotions.
- Added hosted Linux, Windows-container, and macOS worker asset jobs. Linux resolves Actions Runner and verifies the Ubuntu Noble image against HTTPS `SHA256SUMS`; Windows resolves runner/Git/VC dependencies and the Windows Server LTSC 2025 `windows/amd64` digest; macOS resolves the public source image digest without running Tart.
- Updated `images/worker-appliance/build.sh` for offline Runner/job-agent injection via `virt-customize`, source/output hash recording, and removed Cosign attestation.
- Updated CI slim-image assertions and required `GITHUB_WEBHOOK_URL` Compose interpolation.
- Updated control-plane image smoke runner to preserve fixture compatibility while allowing an explicit empty `SMOKE_MANIFEST_URL` to exercise the baked remote manifest.
- Added `tests/release-mars-workflow-contract.test.ts` covering sole publisher ownership, schema-3/immutable gates, promotion ordering, and appliance checks.

## Verification

- `bun test tests/release-mars-workflow-contract.test.ts` — 4 passed, 0 failed.
- `git diff --check` — passed (Git reports only expected Windows LF conversion warning for shell files).

## Concerns

- Actual GitHub-hosted release dispatch, anonymous GHCR/GitHub release observability, Docker builds, and host runtime proofs require repository credentials/network and are not runnable from this Windows checkout.
- Existing deployment contract tests still reference the removed publisher filenames/schema-2 fixture; the deployment-contract test owner must migrate those assertions to `release-mars.yml` and schema 3.
