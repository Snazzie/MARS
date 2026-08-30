# Cross-Platform Worker Download Proxy Implementation Plan

**Goal:** Route Linux, Windows, and macOS installer HTTP downloads through the control plane while selecting local development or immutable production sources server-side.

## Constraints

- Installer scripts contain no GitHub release-manifest fallback.
- Worker-facing HTTP URLs point only to the selected control plane.
- OCI/Tart image references remain registry-native and are injected by the control plane.
- Development sources are local; production sources come from release metadata/configuration.
- Existing proxy integrity and security boundaries apply to every proxied HTTP artifact.

## Tasks

### 1. Platform artifact configuration

- Add typed Linux and macOS development artifact configuration.
- Resolve repository defaults for Linux compose/domain and platform orchestrators when present.
- Preserve production manifest sources.
- Test independent platform availability and missing-artifact failures.

### 2. Proxy routes and generated values

- Add Linux golden-image route using local file or production upstream source.
- Generalize orchestrator route for local macOS and production sources.
- Generate Linux/macOS installer values with control-plane HTTP endpoints only.
- Reuse digest-verified bounded proxy snapshots.

### 3. Dumb installers

- Remove release URL and manifest loading from Linux/macOS installers.
- Require injected URLs, hashes, and OCI/Tart references.
- Preserve platform preflight, integrity checks, and enrollment behavior.

### 4. Control-plane installer commands

- Make enrollment and Windows upgrade command builders always use `/api/workers/installer`.
- Remove web GitHub release URL policy and update tests.

### 5. Verification

- Run focused control-plane, web, installer, deployment, and executable script tests.
- Build control plane and web.
- Review correctness/security and push to main.
