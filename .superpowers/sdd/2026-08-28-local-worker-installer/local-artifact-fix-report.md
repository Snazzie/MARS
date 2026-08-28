# Local worker installer artifact fix

## Root cause

Development startup loaded `deploy/control-plane/release-manifest.json` through `loadWorkerReleaseManifest`. The schema-2 fixture intentionally has every platform set to `null`, so the Windows request reached `installerArtifacts` with a null `windows-x64` platform and returned `503 artifact_unavailable` with `artifacts: ["platform:windows-x64"]` before installer value injection.

There was a second development wiring gap: `index.ts` resolved local executable paths but did not pass Windows container build inputs/artifact paths into `ControlPlaneHttpDeps`. The repository's `.env` already supplies the Windows container base image, runner/Git/VC URLs and SHA-256 values; local build scripts, image inputs, the Windows orchestrator, service host, and job agent are present in the repository (the local job-agent binary is named `whitesmith-job-agent.exe`).

## Implementation

- `apps/control-plane/src/worker-release.ts`
  - Added an explicitly opt-in development metadata path.
  - Hashes local Windows orchestrator and service-host files with SHA-256.
  - Combines those hashes with existing development container metadata and template digest, then validates the resulting schema-2 platform with the unchanged `WorkerReleaseManifest` contract.
  - Leaves a platform null when local files/configuration are incomplete or invalid; production loading remains immutable and unchanged.
  - Preserves one-time caching for the normal startup load while explicit development sources/configuration are uncached for dev restarts.
- `apps/control-plane/src/index.ts`
  - Reads existing `MARS_WINDOWS_CONTAINER_*` development variables.
  - Wires `windowsContainerBuild` and `windowsContainerArtifacts` into the HTTP app.
  - Uses the repository's local `whitesmith-job-agent.exe` fallback and computes the development Windows release metadata from local executable paths.
  - Normalizes a tag-plus-digest development base-image reference to its digest-pinned form for contract validation.
- `apps/control-plane/src/worker-release.test.ts`
  - Added a test first; it failed with the expected null-platform assertion.
  - Green test proves local executable hashes produce a validated usable Windows release record.

## Verification

### TDD red

`bun test apps/control-plane/src/worker-release.test.ts` failed before implementation with:

`received value must be a non-null object` (the loaded Windows platform was `null`).

### Focused green tests

`bun test apps/control-plane/src/worker-release.test.ts apps/control-plane/src/index.test.ts apps/control-plane/src/http/app.test.ts`

Result: `58 pass, 0 fail, 133 expect() calls`.

Control-plane typecheck was also run. No diagnostics remain in the changed files; the command still reports two pre-existing `packages/db/src/dashboard.ts` unknown-type diagnostics at line 334.

### Exact local smoke

A temporary smoke harness exercised the exact request path and query:

`/api/workers/installer?audience=windows-x64&runtime=container&connectOrigin=http%3A%2F%2Flocalhost%3A3000`

Result:

`{"status":200,"hasRuntime":true,"hasLocalBuilder":true,"hasPlaceholders":false,"body":"usable installer generated"}`

The generated script contains the local control-plane Windows container-builder URL and no unresolved installer placeholders. It does not need to download the installer script or release manifest from GitHub; all required Windows container values are injected before the script is returned.

A live restart of the repository server was not possible against the current database: the local `.env` webhook value includes `/api/github/webhooks`, while startup now correctly requires an origin, and the database is in the guarded non-final migration state. The old process on port 3000 consequently continued returning the original 503 and was not used as green evidence.

## Review correction

The local `.env` base image is intentionally a tag-plus-digest reference:
`mcr.microsoft.com/windows/server:ltsc2025@sha256:...`. The local image builder
requires that exact form, so development metadata now preserves the tag instead
of stripping it. The OCI contract accepts the tag-plus-digest form while still
requiring the immutable `@sha256:<64 lowercase hex>` suffix. The regression test
asserts the tagged value survives through `windowsInstallerValues`.

Post-correction focused result:

`bun test apps/control-plane/src/worker-release.test.ts apps/control-plane/src/index.test.ts apps/control-plane/src/http/app.test.ts packages/contracts/src/worker-release.test.ts`

Result: `64 pass, 0 fail, 140 expect() calls`.

Control-plane typecheck still reports only the two pre-existing
`packages/db/src/dashboard.ts:334` unknown-type diagnostics.
